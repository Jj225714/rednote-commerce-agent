import type {
  RednoteCommerceState,
  RednoteDailyReport,
  RednoteOverview,
} from './types.js';

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function buildOverview(state: RednoteCommerceState): RednoteOverview {
  const gmvCents = sum(state.metrics.map((metric) => metric.gmvCents));
  const refundCents = sum(state.metrics.map((metric) => metric.refundCents));
  const adSpendCents = sum(state.metrics.map((metric) => metric.adSpendCents));
  const estimatedNetProfitCents = Math.round(gmvCents * 0.34) - refundCents - adSpendCents;
  const lowStockProducts = state.products.filter(
    (product) => product.inventory <= product.safetyStock,
  );
  const riskyPromotions = state.promotions.filter((promotion) => {
    if (promotion.spendCents <= 0) return false;
    return promotion.attributedRevenueCents / promotion.spendCents < 2;
  });
  const pendingApprovals = state.approvals.filter((approval) => approval.status === 'pending');

  return {
    dataMode: state.dataMode,
    revision: state.revision,
    gmvCents,
    orderCount: sum(state.metrics.map((metric) => metric.orderCount)),
    estimatedNetProfitCents,
    adSpendCents,
    activeProducts: state.products.filter((product) => product.status === 'active').length,
    lowStockProducts: lowStockProducts.length,
    draftNotes: state.notes.filter((note) => note.status === 'draft').length,
    openCampaigns: state.campaigns.filter((campaign) => campaign.status === 'open').length,
    pendingApprovals: pendingApprovals.length,
    activePromotions: state.promotions.filter((promotion) => promotion.status === 'active').length,
    alerts: [
      ...lowStockProducts.map((product) => ({
        kind: 'inventory' as const,
        objectId: product.id,
        message: `${product.name} 库存 ${product.inventory}，低于安全库存 ${product.safetyStock}`,
      })),
      ...riskyPromotions.map((promotion) => ({
        kind: 'promotion' as const,
        objectId: promotion.id,
        message: `${promotion.name} 当前 ROAS 低于 2.0`,
      })),
      ...pendingApprovals.map((approval) => ({
        kind: 'approval' as const,
        objectId: approval.id,
        message: `有一项 ${approval.kind} 操作等待人工审批`,
      })),
    ],
  };
}

export function buildDailyReport(
  state: RednoteCommerceState,
  generatedAt: string,
): RednoteDailyReport {
  const overview = buildOverview(state);
  const risks = overview.alerts.map((alert) => alert.message);
  const highlights = [
    `近 7 日演示成交额 ${(overview.gmvCents / 100).toFixed(2)} 元，共 ${overview.orderCount} 单`,
    `当前 ${overview.activeProducts} 个在售商品、${overview.draftNotes} 篇笔记草稿`,
    `演示推广消耗 ${(overview.adSpendCents / 100).toFixed(2)} 元`,
  ];
  const recommendedActions: string[] = [];
  if (overview.lowStockProducts > 0) recommendedActions.push('优先处理低库存商品，避免继续扩大推广');
  if (overview.pendingApprovals > 0) recommendedActions.push('检查待审批操作的利润、库存和影响范围');
  if (overview.openCampaigns > 0) recommendedActions.push('为开放活动筛选毛利率高于保护线的商品');
  if (recommendedActions.length === 0) recommendedActions.push('继续观察内容与推广转化，保持当前节奏');

  return {
    dataMode: state.dataMode,
    generatedAt,
    headline: '本报告基于 Rednote Agent 本地演示数据生成，不代表真实小红书经营结果。',
    overview,
    highlights,
    risks,
    recommendedActions,
  };
}
