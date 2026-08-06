import { expireApprovalIfNeeded, hashApprovalProposal, hashStableValue } from './approval.js';
import { RednoteDomainError } from './errors.js';
import { calculateCampaignProfit, calculatePromotionPreview } from './profit.js';
import { buildDailyReport, buildOverview } from './report.js';
import { createRednoteDemoState } from './seed.js';
import {
  REDNOTE_STATE_SCHEMA_VERSION,
  type ApprovalFilter,
  type ApprovalProposal,
  type CampaignFilter,
  type CampaignProfitInput,
  type MutationMeta,
  type NoteFilter,
  type ProductFilter,
  type PromotionFilter,
  type PromotionPreviewInput,
  type RednoteApproval,
  type RednoteAuditEntry,
  type RednoteCommerceState,
  type RednoteDailyReport,
  type RednoteOverview,
  type RednoteProduct,
  type RednoteMutationResult,
  type RednoteServiceOptions,
  type SaveNoteDraftInput,
  type UpdateProductDraftInput,
} from './types.js';

const MAX_PROCESSED_COMMANDS = 100;
const MAX_AUDIT_ENTRIES = 200;
let fallbackIdSequence = 0;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertNonEmpty(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new RednoteDomainError('INVALID_INPUT', `${field} 必须为 1-${maxLength} 个字符`);
  }
  return normalized;
}

function assertInteger(value: number, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RednoteDomainError('INVALID_INPUT', `${field} 必须是 ${min}-${max} 的整数`);
  }
  return value;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  return assertInteger(limit, 'limit', 1, 200);
}

function validateState(state: RednoteCommerceState): void {
  if (
    state.schemaVersion !== REDNOTE_STATE_SCHEMA_VERSION ||
    state.dataMode !== 'demo' ||
    !Number.isInteger(state.revision) ||
    !Array.isArray(state.products) ||
    !Array.isArray(state.notes) ||
    !Array.isArray(state.campaigns) ||
    !Array.isArray(state.promotions) ||
    !Array.isArray(state.enrollments) ||
    !Array.isArray(state.approvals) ||
    !Array.isArray(state.auditLog) ||
    !Array.isArray(state.metrics) ||
    !Array.isArray(state.processedCommands)
  ) {
    throw new RednoteDomainError('INVALID_STATE', 'Rednote 本地经营数据格式无效');
  }
}

function findRequired<T extends { id: string }>(list: T[], id: string, label: string): T {
  const item = list.find((entry) => entry.id === id);
  if (!item) throw new RednoteDomainError('NOT_FOUND', `${label}不存在: ${id}`);
  return item;
}

function approvalTargetKey(proposal: ApprovalProposal): string {
  switch (proposal.kind) {
    case 'product.publish':
      return `${proposal.kind}:${proposal.productId}`;
    case 'note.publish':
      return `${proposal.kind}:${proposal.noteId}`;
    case 'campaign.enroll':
      return `${proposal.kind}:${proposal.campaignId}:${proposal.productId}`;
    case 'promotion.launch':
      return `${proposal.kind}:${proposal.promotionId}`;
  }
}

export class RednoteCommerceService {
  private readonly repository: RednoteServiceOptions['repository'];
  private readonly now: () => Date;
  private readonly createId: (prefix: string) => string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(options: RednoteServiceOptions) {
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date());
    this.createId =
      options.createId ??
      ((prefix) => {
        fallbackIdSequence += 1;
        return `${prefix}-${Date.now().toString(36)}-${fallbackIdSequence.toString(36)}`;
      });
  }

  private async readState(): Promise<RednoteCommerceState> {
    const existing = await this.repository.load();
    if (existing) {
      validateState(existing);
      return this.materializeExpiredApprovals(clone(existing));
    }
    const seeded = createRednoteDemoState();
    await this.repository.save(clone(seeded));
    return seeded;
  }

  private materializeExpiredApprovals(state: RednoteCommerceState): RednoteCommerceState {
    const now = this.now();
    state.approvals = state.approvals.map((approval) => expireApprovalIfNeeded(approval, now));
    const pendingNoteIds = new Set<string>();
    const expiredNoteTimes = new Map<string, string>();
    for (const approval of state.approvals) {
      if (approval.proposal.kind !== 'note.publish') continue;
      if (approval.status === 'pending') pendingNoteIds.add(approval.proposal.noteId);
      if (approval.status === 'expired') {
        expiredNoteTimes.set(approval.proposal.noteId, approval.expiresAt);
      }
    }
    for (const note of state.notes) {
      if (
        note.status === 'pending_approval'
        && expiredNoteTimes.has(note.id)
        && !pendingNoteIds.has(note.id)
      ) {
        note.status = 'draft';
        note.updatedAt = expiredNoteTimes.get(note.id)!;
      }
    }
    return state;
  }

  private enqueueWrite<T>(run: () => Promise<T>): Promise<T> {
    const operation = this.writeQueue.then(run, run);
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  private async mutate<T>(
    operation: string,
    meta: MutationMeta,
    input: unknown,
    change: (state: RednoteCommerceState, nowIso: string) => T,
  ): Promise<T> {
    return this.enqueueWrite(async () => {
      const commandId = assertNonEmpty(meta.commandId, 'commandId', 120);
      assertInteger(meta.expectedRevision, 'expectedRevision', 0, Number.MAX_SAFE_INTEGER);
      const inputHash = hashStableValue(input);
      const state = await this.readState();
      const replay = state.processedCommands.find((entry) => entry.commandId === commandId);
      if (replay) {
        if (replay.operation !== operation || replay.inputHash !== inputHash) {
          throw new RednoteDomainError(
            'INVALID_INPUT',
            `commandId 已用于不同请求: ${replay.operation}`,
          );
        }
        return clone(replay.result as T);
      }
      if (state.revision !== meta.expectedRevision) {
        throw new RednoteDomainError(
          'REVISION_CONFLICT',
          `经营数据已更新，预期 revision=${meta.expectedRevision}，实际为 ${state.revision}`,
        );
      }
      const nowIso = this.now().toISOString();
      const result = change(state, nowIso);
      state.revision += 1;
      state.processedCommands.push({
        commandId,
        operation,
        inputHash,
        result: clone(result),
        processedAt: nowIso,
      });
      state.processedCommands = state.processedCommands.slice(-MAX_PROCESSED_COMMANDS);
      state.auditLog = state.auditLog.slice(-MAX_AUDIT_ENTRIES);
      await this.repository.save(clone(state));
      return clone(result);
    });
  }

  private appendAudit(
    state: RednoteCommerceState,
    action: string,
    objectType: string,
    objectId: string,
    summary: string,
    createdAt: string,
  ): RednoteAuditEntry {
    const entry: RednoteAuditEntry = {
      id: this.createId('audit'),
      action,
      objectType,
      objectId,
      summary,
      createdAt,
    };
    state.auditLog.push(entry);
    return entry;
  }

  private createApproval(
    state: RednoteCommerceState,
    proposal: ApprovalProposal,
    nowIso: string,
  ): RednoteApproval {
    const targetKey = approvalTargetKey(proposal);
    const duplicate = state.approvals.find(
      (approval) =>
        approval.status === 'pending'
        && approvalTargetKey(approval.proposal) === targetKey,
    );
    if (duplicate) {
      throw new RednoteDomainError(
        'APPROVAL_ALREADY_PENDING',
        `同一对象已有待审批提案: ${duplicate.id}`,
      );
    }
    const approval: RednoteApproval = {
      id: this.createId('approval'),
      kind: proposal.kind,
      status: 'pending',
      proposal: clone(proposal),
      proposalHash: hashApprovalProposal(proposal),
      createdAt: nowIso,
      expiresAt: new Date(new Date(nowIso).getTime() + 10 * 60_000).toISOString(),
      decidedAt: null,
      decisionReason: null,
    };
    state.approvals.push(approval);
    return approval;
  }

  async getStateSnapshot(): Promise<RednoteCommerceState> {
    return this.readState();
  }

  async getOverview(): Promise<RednoteOverview> {
    return buildOverview(await this.readState());
  }

  async listProducts(filter: ProductFilter = {}): Promise<RednoteProduct[]> {
    const state = await this.readState();
    const query = filter.query?.trim().toLocaleLowerCase();
    const products = state.products.filter((product) => {
      if (filter.status && filter.status !== 'all' && product.status !== filter.status) return false;
      if (!query) return true;
      return `${product.name} ${product.sku} ${product.tags.join(' ')}`
        .toLocaleLowerCase()
        .includes(query);
    });
    return products.slice(0, clampLimit(filter.limit));
  }

  async getProduct(productId: string): Promise<RednoteProduct> {
    const state = await this.readState();
    return clone(findRequired(state.products, productId, '商品'));
  }

  async listNotes(filter: NoteFilter = {}) {
    const state = await this.readState();
    return state.notes
      .filter((note) => {
        if (filter.productId && note.productId !== filter.productId) return false;
        return !filter.status || filter.status === 'all' || note.status === filter.status;
      })
      .slice(0, clampLimit(filter.limit));
  }

  async listCampaigns(filter: CampaignFilter = {}) {
    const state = await this.readState();
    return state.campaigns
      .filter((campaign) => !filter.status || filter.status === 'all' || campaign.status === filter.status)
      .slice(0, clampLimit(filter.limit));
  }

  async listPromotions(filter: PromotionFilter = {}) {
    const state = await this.readState();
    return state.promotions
      .filter((promotion) => !filter.status || filter.status === 'all' || promotion.status === filter.status)
      .slice(0, clampLimit(filter.limit));
  }

  async listApprovals(filter: ApprovalFilter = {}) {
    const now = this.now();
    const state = await this.readState();
    return state.approvals
      .map((approval) => expireApprovalIfNeeded(approval, now))
      .filter((approval) => !filter.status || filter.status === 'all' || approval.status === filter.status)
      .slice(0, clampLimit(filter.limit));
  }

  async getApproval(approvalId: string): Promise<RednoteApproval> {
    const state = await this.readState();
    return expireApprovalIfNeeded(findRequired(state.approvals, approvalId, '审批'), this.now());
  }

  async listAuditLog(limit = 100) {
    const state = await this.readState();
    return state.auditLog.slice(-clampLimit(limit)).reverse();
  }

  async calculateCampaignProfit(input: CampaignProfitInput) {
    assertInteger(input.plannedStock, 'plannedStock', 1, 100_000);
    if (input.promotionBudgetCents !== undefined) {
      assertInteger(input.promotionBudgetCents, 'promotionBudgetCents', 0, 100_000_000);
    }
    const state = await this.readState();
    const product = findRequired(state.products, input.productId, '商品');
    const campaign = findRequired(state.campaigns, input.campaignId, '活动');
    return calculateCampaignProfit(product, campaign, input);
  }

  async previewPromotion(input: PromotionPreviewInput) {
    if (input.dailyBudgetCents !== undefined) {
      assertInteger(input.dailyBudgetCents, 'dailyBudgetCents', 100, 10_000_000);
    }
    const state = await this.readState();
    const promotion = findRequired(state.promotions, input.promotionId, '推广计划');
    const product = findRequired(state.products, promotion.productId, '商品');
    return calculatePromotionPreview(promotion, product, input);
  }

  async generateDailyReport(): Promise<RednoteDailyReport> {
    return buildDailyReport(await this.readState(), this.now().toISOString());
  }

  saveNoteDraft(input: SaveNoteDraftInput, meta: MutationMeta) {
    return this.mutate('note.saveDraft', meta, input, (state, nowIso) => {
      const product = findRequired(state.products, input.productId, '商品');
      const title = assertNonEmpty(input.title, 'title', 60);
      const body = assertNonEmpty(input.body, 'body', 2_000);
      const angle = assertNonEmpty(input.angle, 'angle', 120);
      const tags = input.tags.slice(0, 10).map((tag) => assertNonEmpty(tag, 'tag', 30));
      const existing = input.id ? findRequired(state.notes, input.id, '笔记') : null;
      if (existing) {
        if (existing.status !== 'draft') {
          throw new RednoteDomainError('INVALID_INPUT', '只有草稿状态的笔记可以编辑');
        }
        Object.assign(existing, {
          productId: product.id,
          title,
          body,
          tags,
          angle,
          status: 'draft',
          publishedAt: null,
          updatedAt: nowIso,
        });
        this.appendAudit(state, 'note.draft.updated', 'note', existing.id, `更新笔记草稿《${title}》`, nowIso);
        return existing;
      }
      const note = {
        id: this.createId('note'),
        productId: product.id,
        title,
        body,
        tags,
        angle,
        status: 'draft' as const,
        publishedAt: null,
        updatedAt: nowIso,
      };
      state.notes.push(note);
      this.appendAudit(state, 'note.draft.created', 'note', note.id, `创建笔记草稿《${title}》`, nowIso);
      return note;
    });
  }

  updateProductDraft(input: UpdateProductDraftInput, meta: MutationMeta) {
    return this.mutate('product.updateDraft', meta, input, (state, nowIso) => {
      const product = findRequired(state.products, input.productId, '商品');
      if (
        input.name === undefined
        && input.priceCents === undefined
        && input.inventory === undefined
        && input.sellingPoints === undefined
      ) {
        throw new RednoteDomainError('INVALID_INPUT', '至少需要提供一个商品更新字段');
      }
      if (input.name !== undefined) product.name = assertNonEmpty(input.name, 'name', 100);
      if (input.priceCents !== undefined) product.priceCents = assertInteger(input.priceCents, 'priceCents', 1, 100_000_000);
      if (input.inventory !== undefined) product.inventory = assertInteger(input.inventory, 'inventory', 0, 10_000_000);
      if (input.sellingPoints !== undefined) {
        product.sellingPoints = input.sellingPoints.slice(0, 10).map((value) => assertNonEmpty(value, 'sellingPoint', 120));
      }
      product.updatedAt = nowIso;
      this.appendAudit(state, 'product.draft.updated', 'product', product.id, `更新商品草稿「${product.name}」`, nowIso);
      return product;
    });
  }

  prepareProductPublish(productId: string, meta: MutationMeta) {
    return this.mutate('approval.prepare.productPublish', meta, { productId }, (state, nowIso) => {
      const product = findRequired(state.products, productId, '商品');
      const approval = this.createApproval(state, {
        kind: 'product.publish',
        productId: product.id,
        productName: product.name,
        priceCents: product.priceCents,
        inventory: product.inventory,
        sellingPoints: clone(product.sellingPoints),
      }, nowIso);
      this.appendAudit(state, 'approval.prepared', 'approval', approval.id, `创建商品上架审批：${product.name}`, nowIso);
      return approval;
    });
  }

  prepareNotePublish(noteId: string, meta: MutationMeta) {
    return this.mutate('approval.prepare.notePublish', meta, { noteId }, (state, nowIso) => {
      const note = findRequired(state.notes, noteId, '笔记');
      if (note.status !== 'draft') {
        throw new RednoteDomainError('INVALID_INPUT', '只有草稿状态的笔记可以提交发布审批');
      }
      note.status = 'pending_approval';
      note.updatedAt = nowIso;
      const approval = this.createApproval(state, {
        kind: 'note.publish',
        noteId: note.id,
        noteTitle: note.title,
        productId: note.productId,
        body: note.body,
        tags: clone(note.tags),
        angle: note.angle,
      }, nowIso);
      this.appendAudit(state, 'approval.prepared', 'approval', approval.id, `创建笔记发布审批：《${note.title}》`, nowIso);
      return approval;
    });
  }

  prepareCampaignEnrollment(input: CampaignProfitInput, meta: MutationMeta) {
    return this.mutate('approval.prepare.campaignEnrollment', meta, input, (state, nowIso) => {
      assertInteger(input.plannedStock, 'plannedStock', 1, 100_000);
      if (input.promotionBudgetCents !== undefined) {
        assertInteger(input.promotionBudgetCents, 'promotionBudgetCents', 0, 100_000_000);
      }
      const product = findRequired(state.products, input.productId, '商品');
      const campaign = findRequired(state.campaigns, input.campaignId, '活动');
      const preview = calculateCampaignProfit(product, campaign, input);
      const approval = this.createApproval(state, {
        kind: 'campaign.enroll',
        campaignId: campaign.id,
        campaignName: campaign.name,
        productId: product.id,
        productName: product.name,
        plannedStock: input.plannedStock,
        promotionBudgetCents: preview.promotionBudgetCents,
        projectedRevenueCents: preview.projectedRevenueCents,
        projectedNetProfitCents: preview.projectedNetProfitCents,
        projectedMarginBps: preview.projectedMarginBps,
        risks: preview.risks,
      }, nowIso);
      this.appendAudit(state, 'approval.prepared', 'approval', approval.id, `创建活动报名审批：${campaign.name} / ${product.name}`, nowIso);
      return approval;
    });
  }

  preparePromotionLaunch(input: PromotionPreviewInput, meta: MutationMeta) {
    return this.mutate('approval.prepare.promotionLaunch', meta, input, (state, nowIso) => {
      if (input.dailyBudgetCents !== undefined) {
        assertInteger(input.dailyBudgetCents, 'dailyBudgetCents', 100, 10_000_000);
      }
      const promotion = findRequired(state.promotions, input.promotionId, '推广计划');
      const product = findRequired(state.products, promotion.productId, '商品');
      const preview = calculatePromotionPreview(promotion, product, input);
      const approval = this.createApproval(state, {
        kind: 'promotion.launch',
        promotionId: promotion.id,
        promotionName: promotion.name,
        productId: product.id,
        dailyBudgetCents: preview.dailyBudgetCents,
        projectedRoasBps: preview.projectedRoasBps,
        risks: preview.risks,
      }, nowIso);
      this.appendAudit(state, 'approval.prepared', 'approval', approval.id, `创建推广启动审批：${promotion.name}`, nowIso);
      return approval;
    });
  }

  private rebuildProposal(state: RednoteCommerceState, proposal: ApprovalProposal): ApprovalProposal {
    switch (proposal.kind) {
      case 'product.publish': {
        const product = findRequired(state.products, proposal.productId, '商品');
        return {
          ...proposal,
          productName: product.name,
          priceCents: product.priceCents,
          inventory: product.inventory,
          sellingPoints: clone(product.sellingPoints),
        };
      }
      case 'note.publish': {
        const note = findRequired(state.notes, proposal.noteId, '笔记');
        return {
          ...proposal,
          noteTitle: note.title,
          productId: note.productId,
          body: note.body,
          tags: clone(note.tags),
          angle: note.angle,
        };
      }
      case 'campaign.enroll': {
        const product = findRequired(state.products, proposal.productId, '商品');
        const campaign = findRequired(state.campaigns, proposal.campaignId, '活动');
        const preview = calculateCampaignProfit(product, campaign, {
          productId: product.id,
          campaignId: campaign.id,
          plannedStock: proposal.plannedStock,
          promotionBudgetCents: proposal.promotionBudgetCents,
        });
        return {
          ...proposal,
          campaignName: campaign.name,
          productName: product.name,
          projectedRevenueCents: preview.projectedRevenueCents,
          projectedNetProfitCents: preview.projectedNetProfitCents,
          projectedMarginBps: preview.projectedMarginBps,
          risks: preview.risks,
        };
      }
      case 'promotion.launch': {
        const promotion = findRequired(state.promotions, proposal.promotionId, '推广计划');
        const product = findRequired(state.products, promotion.productId, '商品');
        const preview = calculatePromotionPreview(promotion, product, {
          promotionId: promotion.id,
          dailyBudgetCents: proposal.dailyBudgetCents,
        });
        return {
          ...proposal,
          promotionName: promotion.name,
          productId: product.id,
          projectedRoasBps: preview.projectedRoasBps,
          risks: preview.risks,
        };
      }
    }
  }

  executeApproval(approvalId: string, meta: MutationMeta) {
    return this.mutate('approval.execute', meta, { approvalId }, (state, nowIso) => {
      const approval = findRequired(state.approvals, approvalId, '审批');
      if (approval.status === 'expired') {
        throw new RednoteDomainError('APPROVAL_EXPIRED', '审批已过期，请重新创建提案');
      }
      if (approval.status !== 'pending') {
        throw new RednoteDomainError('APPROVAL_NOT_PENDING', `审批当前状态为 ${approval.status}`);
      }
      if (new Date(approval.expiresAt).getTime() <= new Date(nowIso).getTime()) {
        throw new RednoteDomainError('APPROVAL_EXPIRED', '审批已过期，请重新创建提案');
      }
      const currentProposal = this.rebuildProposal(state, approval.proposal);
      if (hashApprovalProposal(currentProposal) !== approval.proposalHash) {
        throw new RednoteDomainError('PROPOSAL_CHANGED', '审批对象已变化，请重新预览并创建提案');
      }

      switch (approval.proposal.kind) {
        case 'product.publish': {
          const product = findRequired(state.products, approval.proposal.productId, '商品');
          product.status = product.inventory <= product.safetyStock ? 'low_stock' : 'active';
          product.updatedAt = nowIso;
          break;
        }
        case 'note.publish': {
          const note = findRequired(state.notes, approval.proposal.noteId, '笔记');
          note.status = 'published';
          note.publishedAt = nowIso;
          note.updatedAt = nowIso;
          break;
        }
        case 'campaign.enroll': {
          const { campaignId, productId, plannedStock } = approval.proposal;
          if (state.enrollments.some(
            (enrollment) =>
              enrollment.campaignId === campaignId
              && enrollment.productId === productId,
          )) {
            throw new RednoteDomainError('PROPOSAL_CHANGED', '该商品已报名此活动');
          }
          state.enrollments.push({
            id: this.createId('enrollment'),
            campaignId,
            productId,
            plannedStock,
            enrolledAt: nowIso,
          });
          break;
        }
        case 'promotion.launch': {
          const promotion = findRequired(state.promotions, approval.proposal.promotionId, '推广计划');
          promotion.status = 'active';
          promotion.dailyBudgetCents = approval.proposal.dailyBudgetCents;
          promotion.updatedAt = nowIso;
          break;
        }
      }

      approval.status = 'approved';
      approval.decidedAt = nowIso;
      approval.decisionReason = '用户在 Rednote Agent 工作台确认执行';
      this.appendAudit(state, 'approval.executed', 'approval', approval.id, `已在本地演示数据中执行 ${approval.kind}`, nowIso);
      return approval;
    });
  }

  rejectApproval(approvalId: string, reason: string, meta: MutationMeta) {
    return this.mutate(
      'approval.reject',
      meta,
      { approvalId, reason: reason.trim() },
      (state, nowIso) => {
        const approval = findRequired(state.approvals, approvalId, '审批');
        if (approval.status === 'expired') {
          throw new RednoteDomainError('APPROVAL_EXPIRED', '审批已过期，请重新创建提案');
        }
        if (approval.status !== 'pending') {
          throw new RednoteDomainError('APPROVAL_NOT_PENDING', `审批当前状态为 ${approval.status}`);
        }
        approval.status = 'rejected';
        approval.decidedAt = nowIso;
        approval.decisionReason = assertNonEmpty(reason, 'reason', 300);
        if (approval.proposal.kind === 'note.publish') {
          const note = findRequired(state.notes, approval.proposal.noteId, '笔记');
          note.status = 'draft';
          note.updatedAt = nowIso;
        }
        this.appendAudit(state, 'approval.rejected', 'approval', approval.id, `已拒绝 ${approval.kind}：${approval.decisionReason}`, nowIso);
        return approval;
      },
    );
  }

  resetDemoState(meta: MutationMeta): Promise<RednoteMutationResult> {
    return this.enqueueWrite(async () => {
      const operation = 'demo.reset';
      const commandId = assertNonEmpty(meta.commandId, 'commandId', 120);
      assertInteger(meta.expectedRevision, 'expectedRevision', 0, Number.MAX_SAFE_INTEGER);
      const inputHash = hashStableValue({});
      const loaded = await this.repository.load();
      let current = createRednoteDemoState();
      let recoveringInvalidState = false;
      if (loaded) {
        try {
          validateState(loaded);
          current = this.materializeExpiredApprovals(clone(loaded));
        } catch (error) {
          if (!(error instanceof RednoteDomainError) || error.code !== 'INVALID_STATE') {
            throw error;
          }
          recoveringInvalidState = true;
        }
      }

      if (!recoveringInvalidState) {
        const replay = current.processedCommands.find((entry) => entry.commandId === commandId);
        if (replay) {
          if (replay.operation !== operation || replay.inputHash !== inputHash) {
            throw new RednoteDomainError(
              'INVALID_INPUT',
              `commandId 已用于其他操作: ${replay.operation}`,
            );
          }
          return clone(replay.result as RednoteMutationResult);
        }
        if (current.revision !== meta.expectedRevision) {
          throw new RednoteDomainError('REVISION_CONFLICT', '经营数据已更新，请刷新后再重置');
        }
      }
      const reset = createRednoteDemoState();
      reset.revision = recoveringInvalidState ? 1 : current.revision + 1;
      reset.auditLog.push({
        id: this.createId('audit'),
        action: 'demo.reset',
        objectType: 'workspace',
        objectId: 'rednote-demo',
        summary: '用户确认后重置了本地演示数据。',
        createdAt: this.now().toISOString(),
      });
      const result: RednoteMutationResult = { revision: reset.revision };
      reset.processedCommands.push({
        commandId,
        operation,
        inputHash,
        result,
        processedAt: this.now().toISOString(),
      });
      await this.repository.save(clone(reset));
      return clone(result);
    });
  }
}
