export const REDNOTE_STATE_SCHEMA_VERSION = 1 as const;

export type RednoteDataMode = 'demo';
export type ProductStatus = 'active' | 'draft' | 'low_stock';
export type NoteStatus = 'draft' | 'pending_approval' | 'published';
export type CampaignStatus = 'open' | 'upcoming' | 'closed';
export type PromotionStatus = 'active' | 'paused' | 'draft';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type ApprovalKind =
  | 'product.publish'
  | 'note.publish'
  | 'campaign.enroll'
  | 'promotion.launch';

export interface RednoteProduct {
  id: string;
  sku: string;
  name: string;
  status: ProductStatus;
  priceCents: number;
  costCents: number;
  shippingCostCents: number;
  inventory: number;
  safetyStock: number;
  weeklySales: number;
  platformFeeRateBps: number;
  refundLossRateBps: number;
  tags: string[];
  sellingPoints: string[];
  updatedAt: string;
}

export interface RednoteNote {
  id: string;
  productId: string;
  title: string;
  body: string;
  tags: string[];
  angle: string;
  status: NoteStatus;
  publishedAt: string | null;
  updatedAt: string;
}

export interface RednoteCampaign {
  id: string;
  name: string;
  status: CampaignStatus;
  discountBps: number;
  platformFeeRateBps: number;
  minStock: number;
  startsAt: string;
  endsAt: string;
  summary: string;
}

export interface RednotePromotion {
  id: string;
  name: string;
  productId: string;
  status: PromotionStatus;
  dailyBudgetCents: number;
  spendCents: number;
  attributedRevenueCents: number;
  impressions: number;
  clicks: number;
  conversions: number;
  updatedAt: string;
}

export interface CampaignEnrollment {
  id: string;
  campaignId: string;
  productId: string;
  plannedStock: number;
  enrolledAt: string;
}

export interface RednoteDailyMetric {
  date: string;
  gmvCents: number;
  orderCount: number;
  refundCents: number;
  adSpendCents: number;
}

export interface ProductPublishProposal {
  kind: 'product.publish';
  productId: string;
  productName: string;
  priceCents: number;
  inventory: number;
  sellingPoints: string[];
}

export interface NotePublishProposal {
  kind: 'note.publish';
  noteId: string;
  noteTitle: string;
  productId: string;
  body: string;
  tags: string[];
  angle: string;
}

export interface CampaignEnrollmentProposal {
  kind: 'campaign.enroll';
  campaignId: string;
  campaignName: string;
  productId: string;
  productName: string;
  plannedStock: number;
  promotionBudgetCents: number;
  projectedRevenueCents: number;
  projectedNetProfitCents: number;
  projectedMarginBps: number;
  risks: string[];
}

export interface PromotionLaunchProposal {
  kind: 'promotion.launch';
  promotionId: string;
  promotionName: string;
  productId: string;
  dailyBudgetCents: number;
  projectedRoasBps: number;
  risks: string[];
}

export type ApprovalProposal =
  | ProductPublishProposal
  | NotePublishProposal
  | CampaignEnrollmentProposal
  | PromotionLaunchProposal;

export interface RednoteApproval {
  id: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  proposal: ApprovalProposal;
  proposalHash: string;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decisionReason: string | null;
}

export interface RednoteAuditEntry {
  id: string;
  action: string;
  objectType: string;
  objectId: string;
  summary: string;
  createdAt: string;
}

export interface ProcessedCommand {
  commandId: string;
  operation: string;
  inputHash: string;
  result: unknown;
  processedAt: string;
}

export interface RednoteCommerceState {
  schemaVersion: typeof REDNOTE_STATE_SCHEMA_VERSION;
  dataMode: RednoteDataMode;
  revision: number;
  products: RednoteProduct[];
  notes: RednoteNote[];
  campaigns: RednoteCampaign[];
  promotions: RednotePromotion[];
  enrollments: CampaignEnrollment[];
  approvals: RednoteApproval[];
  auditLog: RednoteAuditEntry[];
  metrics: RednoteDailyMetric[];
  processedCommands: ProcessedCommand[];
}

export interface RednoteStateRepository {
  load(): Promise<RednoteCommerceState | null>;
  save(state: RednoteCommerceState): Promise<void>;
}

export interface ProductFilter {
  query?: string;
  status?: ProductStatus | 'all';
  limit?: number;
}

export interface NoteFilter {
  productId?: string;
  status?: NoteStatus | 'all';
  limit?: number;
}

export interface CampaignFilter {
  status?: CampaignStatus | 'all';
  limit?: number;
}

export interface PromotionFilter {
  status?: PromotionStatus | 'all';
  limit?: number;
}

export interface ApprovalFilter {
  status?: ApprovalStatus | 'all';
  limit?: number;
}

export interface SaveNoteDraftInput {
  id?: string;
  productId: string;
  title: string;
  body: string;
  tags: string[];
  angle: string;
}

export interface UpdateProductDraftInput {
  productId: string;
  name?: string;
  priceCents?: number;
  inventory?: number;
  sellingPoints?: string[];
}

export interface CampaignProfitInput {
  productId: string;
  campaignId: string;
  plannedStock: number;
  promotionBudgetCents?: number;
}

export interface CampaignProfitPreview {
  productId: string;
  campaignId: string;
  plannedStock: number;
  transactionPriceCents: number;
  projectedRevenueCents: number;
  productCostCents: number;
  shippingCostCents: number;
  platformFeeCents: number;
  refundLossCents: number;
  promotionBudgetCents: number;
  projectedNetProfitCents: number;
  projectedMarginBps: number;
  risks: string[];
}

export interface PromotionPreviewInput {
  promotionId: string;
  dailyBudgetCents?: number;
}

export interface PromotionPreview {
  promotionId: string;
  productId: string;
  currentRoasBps: number;
  projectedRoasBps: number;
  dailyBudgetCents: number;
  projectedRevenueCents: number;
  projectedNetProfitCents: number;
  risks: string[];
}

export interface RednoteOverview {
  dataMode: RednoteDataMode;
  revision: number;
  gmvCents: number;
  orderCount: number;
  estimatedNetProfitCents: number;
  adSpendCents: number;
  activeProducts: number;
  lowStockProducts: number;
  draftNotes: number;
  openCampaigns: number;
  pendingApprovals: number;
  activePromotions: number;
  alerts: Array<{ kind: 'inventory' | 'promotion' | 'approval'; message: string; objectId: string }>;
}

export interface RednoteDailyReport {
  dataMode: RednoteDataMode;
  generatedAt: string;
  headline: string;
  overview: RednoteOverview;
  highlights: string[];
  risks: string[];
  recommendedActions: string[];
}

export interface MutationMeta {
  commandId: string;
  expectedRevision: number;
}

export interface RednoteMutationResult {
  revision: number;
}

export interface RednoteServiceOptions {
  repository: RednoteStateRepository;
  now?: () => Date;
  createId?: (prefix: string) => string;
}
