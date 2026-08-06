import { RednoteDomainError } from '@rednote/commerce-core';
import { z } from 'zod';

import type { RednoteMcpDeps } from '../types.js';
import {
  RednoteToolRegistry,
  errorResult,
  okResult,
  type RednoteToolResult,
} from './rednoteToolRegistry.js';

const PRODUCT_STATUS = ['all', 'active', 'draft', 'low_stock'] as const;
const NOTE_STATUS = ['all', 'draft', 'pending_approval', 'published'] as const;
const CAMPAIGN_STATUS = ['all', 'open', 'upcoming', 'closed'] as const;
const PROMOTION_STATUS = ['all', 'active', 'paused', 'draft'] as const;
const APPROVAL_STATUS = ['all', 'pending', 'approved', 'rejected', 'expired'] as const;

const expectedRevision = z.number().int().min(0).describe('最近一次读取返回的 revision。');
const commandId = z
  .string()
  .min(1)
  .max(120)
  .describe('必填幂等键；重试同一操作时必须复用同一个值。');

function meta(args: { expectedRevision: number; commandId: string }) {
  return {
    expectedRevision: args.expectedRevision,
    commandId: args.commandId,
  };
}

async function withService(
  deps: RednoteMcpDeps,
  run: (service: ReturnType<RednoteMcpDeps['getService']>) => Promise<RednoteToolResult>,
): Promise<RednoteToolResult> {
  try {
    return await run(deps.getService());
  } catch (error) {
    if (error instanceof RednoteDomainError) {
      return errorResult(error.code, error.message);
    }
    return errorResult('INTERNAL', 'Rednote 本地经营服务暂时不可用');
  }
}

async function revisionEnvelope(
  service: ReturnType<RednoteMcpDeps['getService']>,
  data: unknown,
): Promise<RednoteToolResult> {
  const state = await service.getStateSnapshot();
  return okResult({ dataMode: state.dataMode, revision: state.revision, result: data });
}

export function registerRednoteTools(registry: RednoteToolRegistry, deps: RednoteMcpDeps): void {
  registry.register({
    name: 'overview_get',
    category: 'overview',
    description: '读取 Rednote Agent 本地演示经营总览、告警和当前 revision。不会访问真实小红书。',
    inputShape: {},
    handler: async () => withService(deps, async (service) => okResult(await service.getOverview())),
  });

  registry.register({
    name: 'products_list',
    category: 'products',
    description: '查询本地演示商品，支持名称/SKU搜索和状态筛选。',
    inputShape: {
      query: z.string().max(100).optional(),
      status: z.enum(PRODUCT_STATUS).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    handler: async (args) => withService(deps, async (service) => revisionEnvelope(
      service,
      await service.listProducts(args),
    )),
  });

  registry.register({
    name: 'product_get',
    category: 'products',
    description: '读取一个本地演示商品的价格、成本、库存、卖点和运营标签。',
    inputShape: { productId: z.string().min(1).max(120) },
    handler: async ({ productId }) => withService(deps, async (service) => revisionEnvelope(
      service,
      await service.getProduct(productId),
    )),
  });

  registry.register({
    name: 'product_update_draft',
    category: 'products',
    description: '更新本地商品草稿字段，不会修改真实平台商品。需携带最近读取的 revision。',
    inputShape: {
      productId: z.string().min(1).max(120),
      name: z.string().min(1).max(100).optional(),
      priceCents: z.number().int().min(1).max(100_000_000).optional(),
      inventory: z.number().int().min(0).max(10_000_000).optional(),
      sellingPoints: z.array(z.string().min(1).max(120)).max(10).optional(),
      expectedRevision,
      commandId,
    },
    handler: async (args) => withService(deps, async (service) => revisionEnvelope(
      service,
      await service.updateProductDraft(args, meta(args)),
    )),
  });

  registry.register({
    name: 'product_prepare_publish',
    category: 'products',
    description: '只创建商品上架审批提案，不会直接上架。用户必须在工作台确认。',
    inputShape: {
      productId: z.string().min(1).max(120),
      expectedRevision,
      commandId,
    },
    handler: async (args) => withService(deps, async (service) => revisionEnvelope(
      service,
      await service.prepareProductPublish(args.productId, meta(args)),
    )),
  });

  registry.register({
    name: 'notes_list',
    category: 'content',
    description: '查询本地小红书笔记草稿和演示发布记录。',
    inputShape: {
      productId: z.string().min(1).max(120).optional(),
      status: z.enum(NOTE_STATUS).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    handler: async (args) => withService(deps, async (service) => revisionEnvelope(
      service,
      await service.listNotes(args),
    )),
  });

  registry.register({
    name: 'note_save_draft',
    category: 'content',
    description: '保存本地小红书笔记草稿；不得虚构体验、销量或功效，不会对外发布。',
    inputShape: {
      id: z.string().min(1).max(120).optional(),
      productId: z.string().min(1).max(120),
      title: z.string().min(1).max(60),
      body: z.string().min(20).max(2_000),
      tags: z.array(z.string().min(1).max(30)).max(10),
      angle: z.string().min(1).max(120),
      expectedRevision,
      commandId,
    },
    handler: async (args) => withService(deps, async (service) => revisionEnvelope(
      service,
      await service.saveNoteDraft(args, meta(args)),
    )),
  });

  registry.register({
    name: 'note_prepare_publish',
    category: 'content',
    description: '只创建笔记发布审批提案，不会发布到真实小红书。',
    inputShape: {
      noteId: z.string().min(1).max(120),
      expectedRevision,
      commandId,
    },
    handler: async (args) => withService(deps, async (service) => revisionEnvelope(
      service,
      await service.prepareNotePublish(args.noteId, meta(args)),
    )),
  });

  registry.register({
    name: 'campaigns_list',
    category: 'campaigns',
    description: '查询本地演示活动及库存、折扣、时间和报名状态。',
    inputShape: {
      status: z.enum(CAMPAIGN_STATUS).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    handler: async (args) => withService(deps, async (service) => revisionEnvelope(
      service,
      await service.listCampaigns(args),
    )),
  });

  registry.register({
    name: 'campaign_profit_calculate',
    category: 'campaigns',
    description: '计算活动成交价、费用、预计净利润和库存风险，仅作本地演示分析。',
    inputShape: {
      productId: z.string().min(1).max(120),
      campaignId: z.string().min(1).max(120),
      plannedStock: z.number().int().min(1).max(100_000),
      promotionBudgetCents: z.number().int().min(0).max(100_000_000).optional(),
    },
    handler: async (args) => withService(deps, async (service) => revisionEnvelope(
      service,
      await service.calculateCampaignProfit(args),
    )),
  });

  registry.register({
    name: 'campaign_prepare_enrollment',
    category: 'campaigns',
    description: '根据利润预览创建活动报名审批提案，不会直接报名。',
    inputShape: {
      productId: z.string().min(1).max(120),
      campaignId: z.string().min(1).max(120),
      plannedStock: z.number().int().min(1).max(100_000),
      promotionBudgetCents: z.number().int().min(0).max(100_000_000).optional(),
      expectedRevision,
      commandId,
    },
    handler: async (args) => withService(deps, async (service) => revisionEnvelope(
      service,
      await service.prepareCampaignEnrollment(args, meta(args)),
    )),
  });

  registry.register({
    name: 'promotions_list',
    category: 'promotions',
    description: '查询本地演示推广计划的预算、消耗、归因成交和状态。',
    inputShape: {
      status: z.enum(PROMOTION_STATUS).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    handler: async (args) => withService(deps, async (service) => revisionEnvelope(
      service,
      await service.listPromotions(args),
    )),
  });

  registry.register({
    name: 'promotion_preview',
    category: 'promotions',
    description: '预览推广预算、ROAS、预计收入、预计净利润和库存风险。',
    inputShape: {
      promotionId: z.string().min(1).max(120),
      dailyBudgetCents: z.number().int().min(100).max(10_000_000).optional(),
    },
    handler: async (args) => withService(deps, async (service) => revisionEnvelope(
      service,
      await service.previewPromotion(args),
    )),
  });

  registry.register({
    name: 'promotion_prepare_launch',
    category: 'promotions',
    description: '创建推广启动或预算调整审批提案，不会直接投放或扣费。',
    inputShape: {
      promotionId: z.string().min(1).max(120),
      dailyBudgetCents: z.number().int().min(100).max(10_000_000).optional(),
      expectedRevision,
      commandId,
    },
    handler: async (args) => withService(deps, async (service) => revisionEnvelope(
      service,
      await service.preparePromotionLaunch(args, meta(args)),
    )),
  });

  registry.register({
    name: 'approvals_list',
    category: 'approvals',
    description: '查询本地审批提案。Agent 只能查看状态，不能批准或执行。',
    inputShape: {
      status: z.enum(APPROVAL_STATUS).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    handler: async (args) => withService(deps, async (service) => revisionEnvelope(
      service,
      await service.listApprovals(args),
    )),
  });

  registry.register({
    name: 'approval_get',
    category: 'approvals',
    description: '读取一个审批提案的影响、风险、状态和过期时间。没有执行能力。',
    inputShape: { approvalId: z.string().min(1).max(120) },
    handler: async ({ approvalId }) => withService(deps, async (service) => revisionEnvelope(
      service,
      await service.getApproval(approvalId),
    )),
  });

  registry.register({
    name: 'audit_list',
    category: 'approvals',
    description: '读取最近的本地经营操作审计记录。',
    inputShape: { limit: z.number().int().min(1).max(200).optional() },
    handler: async ({ limit }) => withService(deps, async (service) => revisionEnvelope(
      service,
      await service.listAuditLog(limit),
    )),
  });

  registry.register({
    name: 'daily_report_generate',
    category: 'reports',
    description: '基于本地演示数据生成经营日报，明确标注不代表真实小红书数据。',
    inputShape: {},
    handler: async () => withService(deps, async (service) => okResult(await service.generateDailyReport())),
  });
}
