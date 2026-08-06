import { describe, expect, it } from 'vitest';

import {
  RednoteCommerceService,
  RednoteDomainError,
  type RednoteCommerceState,
  type RednoteStateRepository,
} from '../index.js';

class MemoryRepository implements RednoteStateRepository {
  state: RednoteCommerceState | null = null;
  saves = 0;

  async load(): Promise<RednoteCommerceState | null> {
    return this.state ? structuredClone(this.state) : null;
  }

  async save(state: RednoteCommerceState): Promise<void> {
    this.saves += 1;
    this.state = structuredClone(state);
  }
}

function createHarness() {
  const repository = new MemoryRepository();
  let now = new Date('2026-08-05T00:00:00.000Z');
  let sequence = 0;
  const service = new RednoteCommerceService({
    repository,
    now: () => now,
    createId: (prefix) => `${prefix}-test-${++sequence}`,
  });
  return {
    repository,
    service,
    setNow(value: string) {
      now = new Date(value);
    },
  };
}

describe('RednoteCommerceService', () => {
  it('seeds a complete demo workspace and builds an overview', async () => {
    const { repository, service } = createHarness();
    const overview = await service.getOverview();

    expect(overview.dataMode).toBe('demo');
    expect(overview.activeProducts).toBe(3);
    expect(overview.lowStockProducts).toBe(1);
    expect(overview.draftNotes).toBe(3);
    expect(overview.openCampaigns).toBe(1);
    expect(overview.activePromotions).toBe(1);
    expect(overview.gmvCents).toBeGreaterThan(0);
    expect(repository.saves).toBe(1);
  });

  it('saves a note draft once and replays a repeated command id', async () => {
    const { repository, service } = createHarness();
    const overview = await service.getOverview();
    const input = {
      productId: 'product-ceramic-cup',
      title: '通勤杯清洁步骤',
      body: '基于商品资料整理杯盖拆洗、日常冲洗和晾干步骤，不虚构使用体验。',
      tags: ['通勤好物', '清洁步骤'],
      angle: '实用教程',
    };

    const first = await service.saveNoteDraft(input, {
      commandId: 'save-note-1',
      expectedRevision: overview.revision,
    });
    const replay = await service.saveNoteDraft(input, {
      commandId: 'save-note-1',
      expectedRevision: overview.revision,
    });

    expect(replay).toEqual(first);
    expect(repository.state?.notes.filter((note) => note.id === first.id)).toHaveLength(1);
    expect(repository.state?.revision).toBe(1);
  });

  it('does not allow a published note to be edited or submitted again', async () => {
    const { repository, service } = createHarness();
    await service.getOverview();
    const published = repository.state?.notes.find((note) => note.id === 'note-aroma-room');

    await expect(service.saveNoteDraft(
      {
        id: 'note-aroma-room',
        productId: published!.productId,
        title: published!.title,
        body: published!.body,
        tags: published!.tags,
        angle: published!.angle,
      },
      { commandId: 'edit-published-note', expectedRevision: 0 },
    )).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.prepareNotePublish(
      'note-aroma-room',
      { commandId: 'prepare-published-note', expectedRevision: 0 },
    )).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    expect(repository.state?.revision).toBe(0);
    expect(repository.state?.notes.find((note) => note.id === 'note-aroma-room')).toMatchObject({
      status: 'published',
      publishedAt: '2026-07-29T12:00:00.000Z',
    });
  });

  it('rejects stale revisions without changing state', async () => {
    const { repository, service } = createHarness();
    await service.getOverview();

    await expect(
      service.updateProductDraft(
        { productId: 'product-storage', priceCents: 4990 },
        { commandId: 'stale-update', expectedRevision: 7 },
      ),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(repository.state?.revision).toBe(0);
    expect(repository.state?.products.find((product) => product.id === 'product-storage')?.priceCents).toBe(4590);
  });

  it('rejects empty product updates without advancing the revision', async () => {
    const { repository, service } = createHarness();
    await service.getOverview();

    await expect(
      service.updateProductDraft(
        { productId: 'product-storage' },
        { commandId: 'empty-product-update', expectedRevision: 0 },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(repository.state?.revision).toBe(0);
  });

  it('does not replay a command id across different operations', async () => {
    const { service } = createHarness();
    await service.updateProductDraft(
      { productId: 'product-storage', inventory: 30 },
      { commandId: 'shared-command-id', expectedRevision: 0 },
    );

    await expect(
      service.prepareProductPublish(
        'product-storage',
        { commandId: 'shared-command-id', expectedRevision: 1 },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('does not replay a command id for a different input to the same operation', async () => {
    const { repository, service } = createHarness();
    await service.prepareProductPublish(
      'product-storage',
      { commandId: 'same-operation-command', expectedRevision: 0 },
    );

    await expect(
      service.prepareProductPublish(
        'product-tea-set',
        { commandId: 'same-operation-command', expectedRevision: 1 },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(repository.state?.approvals).toHaveLength(1);
    expect(repository.state?.approvals[0]?.proposal).toMatchObject({
      kind: 'product.publish',
      productId: 'product-storage',
    });
  });

  it('calculates explainable campaign profit and inventory risks', async () => {
    const { service } = createHarness();
    const preview = await service.calculateCampaignProfit({
      productId: 'product-canvas-bag',
      campaignId: 'campaign-summer-home',
      plannedStock: 30,
      promotionBudgetCents: 5_000,
    });

    expect(preview.transactionPriceCents).toBe(7_642);
    expect(preview.projectedRevenueCents).toBe(229_260);
    expect(preview.projectedNetProfitCents).toBeLessThan(preview.projectedRevenueCents);
    expect(preview.risks).toContain('计划库存超过当前可用库存');
    expect(preview.risks).toContain('商品已低于安全库存');
  });

  it('prepares and executes a note approval exactly once', async () => {
    const { repository, service } = createHarness();
    const initial = await service.getOverview();
    const approval = await service.prepareNotePublish('note-cup-commute', {
      commandId: 'prepare-note-1',
      expectedRevision: initial.revision,
    });

    expect(approval.status).toBe('pending');
    expect(repository.state?.notes.find((note) => note.id === 'note-cup-commute')?.status).toBe('pending_approval');

    const executed = await service.executeApproval(approval.id, {
      commandId: 'execute-note-1',
      expectedRevision: 1,
    });
    const replay = await service.executeApproval(approval.id, {
      commandId: 'execute-note-1',
      expectedRevision: 1,
    });

    expect(executed.status).toBe('approved');
    expect(replay).toEqual(executed);
    expect(repository.state?.notes.find((note) => note.id === 'note-cup-commute')?.status).toBe('published');
    expect(repository.state?.revision).toBe(2);
  });

  it('executes a campaign approval with its promotion budget intact', async () => {
    const { repository, service } = createHarness();
    await service.getOverview();
    const approval = await service.prepareCampaignEnrollment(
      {
        productId: 'product-storage',
        campaignId: 'campaign-summer-home',
        plannedStock: 40,
        promotionBudgetCents: 5_000,
      },
      { commandId: 'prepare-campaign-budget', expectedRevision: 0 },
    );

    expect(approval.proposal).toMatchObject({
      kind: 'campaign.enroll',
      promotionBudgetCents: 5_000,
    });
    await expect(
      service.executeApproval(
        approval.id,
        { commandId: 'execute-campaign-budget', expectedRevision: 1 },
      ),
    ).resolves.toMatchObject({ status: 'approved' });
    expect(repository.state?.enrollments).toHaveLength(1);
  });

  it('allows only one pending approval for the same campaign and product', async () => {
    const { repository, service } = createHarness();
    await service.prepareCampaignEnrollment(
      {
        productId: 'product-storage',
        campaignId: 'campaign-summer-home',
        plannedStock: 40,
      },
      { commandId: 'campaign-pending-1', expectedRevision: 0 },
    );

    await expect(
      service.prepareCampaignEnrollment(
        {
          productId: 'product-storage',
          campaignId: 'campaign-summer-home',
          plannedStock: 45,
        },
        { commandId: 'campaign-pending-2', expectedRevision: 1 },
      ),
    ).rejects.toMatchObject({ code: 'APPROVAL_ALREADY_PENDING' });
    expect(repository.state?.approvals).toHaveLength(1);
    expect(repository.state?.revision).toBe(1);
  });

  it('fails closed when an approval expires', async () => {
    const harness = createHarness();
    const initial = await harness.service.getOverview();
    const approval = await harness.service.prepareProductPublish('product-storage', {
      commandId: 'prepare-product-1',
      expectedRevision: initial.revision,
    });
    harness.setNow('2026-08-05T00:11:00.000Z');

    const snapshot = await harness.service.getStateSnapshot();
    const overview = await harness.service.getOverview();
    expect(snapshot.approvals.find((item) => item.id === approval.id)?.status).toBe('expired');
    expect(overview.pendingApprovals).toBe(0);

    await expect(
      harness.service.executeApproval(approval.id, {
        commandId: 'execute-expired-1',
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
    await expect(
      harness.service.rejectApproval(
        approval.id,
        '迟到的拒绝',
        { commandId: 'reject-expired-1', expectedRevision: 1 },
      ),
    ).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
    expect(harness.repository.state?.products.find((product) => product.id === 'product-storage')?.status).toBe('draft');
    expect(harness.repository.state?.revision).toBe(1);
  });

  it('restores a note draft when its only pending approval expires', async () => {
    const harness = createHarness();
    await harness.service.prepareNotePublish(
      'note-cup-commute',
      { commandId: 'prepare-note-expiry', expectedRevision: 0 },
    );
    harness.setNow('2026-08-05T00:11:00.000Z');

    const snapshot = await harness.service.getStateSnapshot();
    expect(snapshot.approvals[0]?.status).toBe('expired');
    expect(snapshot.notes.find((note) => note.id === 'note-cup-commute')?.status).toBe('draft');
    harness.setNow('2026-08-05T00:12:00.000Z');
    expect(await harness.service.getStateSnapshot()).toEqual(snapshot);
  });

  it('fails closed when the approved proposal changed', async () => {
    const { repository, service } = createHarness();
    await service.getOverview();
    const approval = await service.prepareNotePublish('note-cup-commute', {
      commandId: 'prepare-note-change',
      expectedRevision: 0,
    });
    const persistedNote = repository.state?.notes.find((note) => note.id === 'note-cup-commute');
    if (!persistedNote) throw new Error('missing persisted note');
    persistedNote.body = `${persistedNote.body} 被外部篡改`;

    await expect(
      service.executeApproval(approval.id, {
        commandId: 'execute-changed-note',
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_CHANGED' });
    expect(repository.state?.revision).toBe(1);
    expect(repository.state?.notes.find((note) => note.id === 'note-cup-commute')?.status).toBe('pending_approval');
  });

  it('fails closed when product selling points change after approval', async () => {
    const { repository, service } = createHarness();
    const approval = await service.prepareProductPublish(
      'product-storage',
      { commandId: 'prepare-product-copy', expectedRevision: 0 },
    );
    await service.updateProductDraft(
      { productId: 'product-storage', sellingPoints: ['审批后替换的卖点'] },
      { commandId: 'change-product-copy', expectedRevision: 1 },
    );

    await expect(
      service.executeApproval(
        approval.id,
        { commandId: 'execute-changed-product-copy', expectedRevision: 2 },
      ),
    ).rejects.toMatchObject({ code: 'PROPOSAL_CHANGED' });
    expect(repository.state?.revision).toBe(2);
  });

  it('rejects an approval and restores a pending note to draft', async () => {
    const { repository, service } = createHarness();
    await service.getOverview();
    const approval = await service.prepareNotePublish('note-cup-commute', {
      commandId: 'prepare-note-reject',
      expectedRevision: 0,
    });
    const rejected = await service.rejectApproval(
      approval.id,
      '标题需要重新核对',
      { commandId: 'reject-note-1', expectedRevision: 1 },
    );

    expect(rejected.status).toBe('rejected');
    expect(repository.state?.notes.find((note) => note.id === 'note-cup-commute')?.status).toBe('draft');
  });

  it('previews promotion economics and generates a demo-labelled report', async () => {
    const { service } = createHarness();
    const preview = await service.previewPromotion({ promotionId: 'promotion-bag-feed' });
    const report = await service.generateDailyReport();

    expect(preview.currentRoasBps).toBeLessThan(20_000);
    expect(preview.risks).toContain('关联商品低于安全库存，不建议扩大推广');
    expect(report.dataMode).toBe('demo');
    expect(report.headline).toContain('本地演示数据');
    expect(report.recommendedActions.length).toBeGreaterThan(0);
  });

  it('returns stable domain errors for missing records', async () => {
    const { service } = createHarness();
    await expect(service.getProduct('missing')).rejects.toBeInstanceOf(RednoteDomainError);
    await expect(service.getProduct('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects persisted state with a missing required collection', async () => {
    const { repository, service } = createHarness();
    await service.getOverview();
    const corrupted = structuredClone(repository.state) as unknown as Record<string, unknown>;
    delete corrupted.processedCommands;
    repository.state = corrupted as unknown as RednoteCommerceState;

    await expect(service.getStateSnapshot()).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('recovers invalid persisted state only through an explicit reset', async () => {
    const { repository, service } = createHarness();
    await service.getOverview();
    const corrupted = structuredClone(repository.state) as unknown as Record<string, unknown>;
    delete corrupted.processedCommands;
    repository.state = corrupted as unknown as RednoteCommerceState;

    await expect(service.getStateSnapshot()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(service.resetDemoState({
      commandId: 'recover-invalid-demo',
      expectedRevision: 0,
    })).resolves.toEqual({ revision: 1 });

    await expect(service.getStateSnapshot()).resolves.toMatchObject({
      dataMode: 'demo',
      revision: 1,
    });
    expect(repository.state?.processedCommands).toHaveLength(1);
  });

  it('returns the same compact result when reset is retried', async () => {
    const { repository, service } = createHarness();
    await service.getOverview();
    const meta = { commandId: 'reset-demo-idempotent', expectedRevision: 0 };

    const first = await service.resetDemoState(meta);
    const replay = await service.resetDemoState(meta);

    expect(first).toEqual({ revision: 1 });
    expect(replay).toEqual(first);
    expect(repository.state?.revision).toBe(1);
    expect(repository.state?.processedCommands).toHaveLength(1);
  });
});
