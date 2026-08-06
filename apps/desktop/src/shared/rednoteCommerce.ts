import type {
  CampaignProfitInput,
  CampaignProfitPreview,
  MutationMeta,
  PromotionPreview,
  PromotionPreviewInput,
  RednoteApproval,
  RednoteCommerceState,
  RednoteDailyReport,
  RednoteMutationResult,
  RednoteNote,
  RednoteProduct,
  SaveNoteDraftInput,
  UpdateProductDraftInput,
} from '@rednote/commerce-core';

export const REDNOTE_COMMERCE_CHANNELS = {
  snapshot: 'rednote-commerce:snapshot',
  campaignProfit: 'rednote-commerce:campaign-profit',
  promotionPreview: 'rednote-commerce:promotion-preview',
  dailyReport: 'rednote-commerce:daily-report',
  saveNoteDraft: 'rednote-commerce:save-note-draft',
  updateProductDraft: 'rednote-commerce:update-product-draft',
  prepareProductPublish: 'rednote-commerce:prepare-product-publish',
  prepareNotePublish: 'rednote-commerce:prepare-note-publish',
  prepareCampaignEnrollment: 'rednote-commerce:prepare-campaign-enrollment',
  preparePromotionLaunch: 'rednote-commerce:prepare-promotion-launch',
  executeApproval: 'rednote-commerce:execute-approval',
  rejectApproval: 'rednote-commerce:reject-approval',
  resetDemo: 'rednote-commerce:reset-demo',
  changed: 'rednote-commerce:changed',
} as const;

export interface RednoteCommerceChangedEvent {
  revision: number;
}

export interface RednoteCommerceRendererApi {
  getSnapshot(): Promise<RednoteCommerceState>;
  calculateCampaignProfit(input: CampaignProfitInput): Promise<CampaignProfitPreview>;
  previewPromotion(input: PromotionPreviewInput): Promise<PromotionPreview>;
  generateDailyReport(): Promise<RednoteDailyReport>;
  saveNoteDraft(input: SaveNoteDraftInput, meta: MutationMeta): Promise<RednoteNote>;
  updateProductDraft(input: UpdateProductDraftInput, meta: MutationMeta): Promise<RednoteProduct>;
  prepareProductPublish(productId: string, meta: MutationMeta): Promise<RednoteApproval>;
  prepareNotePublish(noteId: string, meta: MutationMeta): Promise<RednoteApproval>;
  prepareCampaignEnrollment(input: CampaignProfitInput, meta: MutationMeta): Promise<RednoteApproval>;
  preparePromotionLaunch(input: PromotionPreviewInput, meta: MutationMeta): Promise<RednoteApproval>;
  executeApproval(approvalId: string, meta: MutationMeta): Promise<RednoteApproval>;
  rejectApproval(approvalId: string, reason: string, meta: MutationMeta): Promise<RednoteApproval>;
  resetDemo(meta: MutationMeta): Promise<RednoteMutationResult>;
  onChanged(callback: (event: RednoteCommerceChangedEvent) => void): () => void;
}
