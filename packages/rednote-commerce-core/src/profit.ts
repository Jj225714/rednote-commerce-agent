import type {
  CampaignProfitInput,
  CampaignProfitPreview,
  PromotionPreview,
  PromotionPreviewInput,
  RednoteCampaign,
  RednoteProduct,
  RednotePromotion,
} from './types.js';

function multiplyBps(cents: number, bps: number): number {
  return Math.round((cents * bps) / 10_000);
}

export function calculateCampaignProfit(
  product: RednoteProduct,
  campaign: RednoteCampaign,
  input: CampaignProfitInput,
): CampaignProfitPreview {
  const transactionPriceCents = multiplyBps(product.priceCents, campaign.discountBps);
  const projectedRevenueCents = transactionPriceCents * input.plannedStock;
  const productCostCents = product.costCents * input.plannedStock;
  const shippingCostCents = product.shippingCostCents * input.plannedStock;
  const platformFeeCents = multiplyBps(
    projectedRevenueCents,
    Math.max(product.platformFeeRateBps, campaign.platformFeeRateBps),
  );
  const refundLossCents = multiplyBps(projectedRevenueCents, product.refundLossRateBps);
  const promotionBudgetCents = input.promotionBudgetCents ?? 0;
  const projectedNetProfitCents =
    projectedRevenueCents -
    productCostCents -
    shippingCostCents -
    platformFeeCents -
    refundLossCents -
    promotionBudgetCents;
  const projectedMarginBps =
    projectedRevenueCents > 0
      ? Math.round((projectedNetProfitCents * 10_000) / projectedRevenueCents)
      : 0;
  const risks: string[] = [];
  if (campaign.status !== 'open') risks.push('活动当前不在开放报名状态');
  if (input.plannedStock < campaign.minStock) risks.push(`计划库存低于活动门槛 ${campaign.minStock}`);
  if (input.plannedStock > product.inventory) risks.push('计划库存超过当前可用库存');
  if (product.inventory <= product.safetyStock) risks.push('商品已低于安全库存');
  if (projectedMarginBps < 2_000) risks.push('预计净利率低于 20% 保护线');
  if (projectedNetProfitCents <= 0) risks.push('预计净利润不为正');

  return {
    productId: product.id,
    campaignId: campaign.id,
    plannedStock: input.plannedStock,
    transactionPriceCents,
    projectedRevenueCents,
    productCostCents,
    shippingCostCents,
    platformFeeCents,
    refundLossCents,
    promotionBudgetCents,
    projectedNetProfitCents,
    projectedMarginBps,
    risks,
  };
}

export function calculatePromotionPreview(
  promotion: RednotePromotion,
  product: RednoteProduct,
  input: PromotionPreviewInput,
): PromotionPreview {
  const currentRoasBps =
    promotion.spendCents > 0
      ? Math.round((promotion.attributedRevenueCents * 10_000) / promotion.spendCents)
      : 0;
  const dailyBudgetCents = input.dailyBudgetCents ?? promotion.dailyBudgetCents;
  const projectedRoasBps = currentRoasBps || 25_000;
  const projectedRevenueCents = Math.round((dailyBudgetCents * projectedRoasBps) / 10_000);
  const projectedUnits = product.priceCents > 0
    ? Math.max(1, Math.round(projectedRevenueCents / product.priceCents))
    : 1;
  const unitContributionCents =
    product.priceCents -
    product.costCents -
    product.shippingCostCents -
    multiplyBps(product.priceCents, product.platformFeeRateBps) -
    multiplyBps(product.priceCents, product.refundLossRateBps);
  const projectedNetProfitCents = unitContributionCents * projectedUnits - dailyBudgetCents;
  const risks: string[] = [];
  if (product.inventory <= product.safetyStock) risks.push('关联商品低于安全库存，不建议扩大推广');
  if (promotion.spendCents > 0 && currentRoasBps < 20_000) risks.push('当前 ROAS 低于 2.0');
  if (promotion.conversions === 0 && promotion.spendCents > 0) risks.push('已有消耗但没有归因成交');
  if (projectedNetProfitCents <= 0) risks.push('预计扣除推广预算后净利润不为正');

  return {
    promotionId: promotion.id,
    productId: product.id,
    currentRoasBps,
    projectedRoasBps,
    dailyBudgetCents,
    projectedRevenueCents,
    projectedNetProfitCents,
    risks,
  };
}
