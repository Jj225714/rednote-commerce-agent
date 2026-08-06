import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import {
  RednoteDomainError,
  type CampaignProfitInput,
  type MutationMeta,
  type PromotionPreviewInput,
  type RednoteCommerceService,
  type SaveNoteDraftInput,
  type UpdateProductDraftInput,
} from '@rednote/commerce-core';

import { REDNOTE_COMMERCE_CHANNELS } from '../../shared/rednoteCommerce.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { getRednoteCommerceService } from './service.js';

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throwIpcError('INVALID_PARAMS', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string, maxLength = 200): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maxLength) {
    throwIpcError('INVALID_PARAMS', `${label} must be a non-empty string up to ${maxLength} characters`);
  }
  return normalized;
}

function asOptionalString(value: unknown, label: string, maxLength = 200): string | undefined {
  return value === undefined ? undefined : asString(value, label, maxLength);
}

function asInteger(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throwIpcError('INVALID_PARAMS', `${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function asOptionalInteger(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number | undefined {
  return value === undefined ? undefined : asInteger(value, label, min, max);
}

function asStringArray(
  value: unknown,
  label: string,
  maxItems: number,
  maxItemLength: number,
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throwIpcError('INVALID_PARAMS', `${label} must be an array with at most ${maxItems} items`);
  }
  return value.map((item, index) => asString(item, `${label}[${index}]`, maxItemLength));
}

function assertAllowedKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unexpected = Object.keys(record).find((key) => !allowed.includes(key));
  if (unexpected) throwIpcError('INVALID_PARAMS', `${label}.${unexpected} is not allowed`);
}

function parseCampaignProfitInput(value: unknown): CampaignProfitInput {
  const record = asRecord(value, 'input');
  assertAllowedKeys(
    record,
    ['productId', 'campaignId', 'plannedStock', 'promotionBudgetCents'],
    'input',
  );
  const promotionBudgetCents = asOptionalInteger(
    record.promotionBudgetCents,
    'input.promotionBudgetCents',
    0,
    100_000_000,
  );
  return {
    productId: asString(record.productId, 'input.productId', 120),
    campaignId: asString(record.campaignId, 'input.campaignId', 120),
    plannedStock: asInteger(record.plannedStock, 'input.plannedStock', 1, 100_000),
    ...(promotionBudgetCents !== undefined ? { promotionBudgetCents } : {}),
  };
}

function parsePromotionPreviewInput(value: unknown): PromotionPreviewInput {
  const record = asRecord(value, 'input');
  assertAllowedKeys(record, ['promotionId', 'dailyBudgetCents'], 'input');
  const dailyBudgetCents = asOptionalInteger(
    record.dailyBudgetCents,
    'input.dailyBudgetCents',
    100,
    10_000_000,
  );
  return {
    promotionId: asString(record.promotionId, 'input.promotionId', 120),
    ...(dailyBudgetCents !== undefined ? { dailyBudgetCents } : {}),
  };
}

function parseSaveNoteDraftInput(value: unknown): SaveNoteDraftInput {
  const record = asRecord(value, 'input');
  assertAllowedKeys(record, ['id', 'productId', 'title', 'body', 'tags', 'angle'], 'input');
  const id = asOptionalString(record.id, 'input.id', 120);
  return {
    ...(id !== undefined ? { id } : {}),
    productId: asString(record.productId, 'input.productId', 120),
    title: asString(record.title, 'input.title', 60),
    body: asString(record.body, 'input.body', 2_000),
    tags: asStringArray(record.tags, 'input.tags', 10, 30),
    angle: asString(record.angle, 'input.angle', 120),
  };
}

function parseUpdateProductDraftInput(value: unknown): UpdateProductDraftInput {
  const record = asRecord(value, 'input');
  assertAllowedKeys(
    record,
    ['productId', 'name', 'priceCents', 'inventory', 'sellingPoints'],
    'input',
  );
  const name = asOptionalString(record.name, 'input.name', 100);
  const priceCents = asOptionalInteger(record.priceCents, 'input.priceCents', 1, 100_000_000);
  const inventory = asOptionalInteger(record.inventory, 'input.inventory', 0, 10_000_000);
  const sellingPoints = record.sellingPoints === undefined
    ? undefined
    : asStringArray(record.sellingPoints, 'input.sellingPoints', 10, 120);
  return {
    productId: asString(record.productId, 'input.productId', 120),
    ...(name !== undefined ? { name } : {}),
    ...(priceCents !== undefined ? { priceCents } : {}),
    ...(inventory !== undefined ? { inventory } : {}),
    ...(sellingPoints !== undefined ? { sellingPoints } : {}),
  };
}

function parseMeta(value: unknown): MutationMeta {
  const record = asRecord(value, 'meta');
  assertAllowedKeys(record, ['commandId', 'expectedRevision'], 'meta');
  return {
    commandId: asString(record.commandId, 'meta.commandId', 120),
    expectedRevision: asInteger(record.expectedRevision, 'meta.expectedRevision', 0, Number.MAX_SAFE_INTEGER),
  };
}

function mapDomainError(error: unknown): never {
  if (error instanceof RednoteDomainError) {
    if (error.code === 'NOT_FOUND') throwIpcError('NOT_FOUND', error.message);
    if (error.code === 'INVALID_INPUT') throwIpcError('INVALID_PARAMS', error.message);
    if (
      error.code === 'REVISION_CONFLICT'
      || error.code === 'APPROVAL_EXPIRED'
      || error.code === 'APPROVAL_ALREADY_PENDING'
      || error.code === 'APPROVAL_NOT_PENDING'
      || error.code === 'PROPOSAL_CHANGED'
    ) {
      throwIpcError('PRECONDITION_FAILED', error.message);
    }
    throwIpcError('INTERNAL', 'Rednote local commerce data is temporarily unavailable');
  }
  if (isIpcError(error)) throw error;
  console.error('[rednote-commerce] unexpected domain failure', error);
  throwIpcError('INTERNAL', 'Rednote local commerce data is temporarily unavailable');
}

async function callDomain<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    return mapDomainError(error);
  }
}

export interface RednoteCommerceIpcDeps {
  service: RednoteCommerceService;
  assertTrustedSender: (event: IpcMainInvokeEvent) => void;
}

export function createRednoteCommerceIpcHandlers(deps: RednoteCommerceIpcDeps) {
  const trusted = <TArgs extends unknown[], TResult>(
    handler: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult>,
  ) =>
    (event: IpcMainInvokeEvent, ...args: TArgs): Promise<TResult> => {
      deps.assertTrustedSender(event);
      return handler(event, ...args);
    };

  return {
    snapshot: trusted(() => callDomain(() => deps.service.getStateSnapshot())),
    campaignProfit: trusted((_event, rawInput: unknown) =>
      callDomain(() => deps.service.calculateCampaignProfit(parseCampaignProfitInput(rawInput))),
    ),
    promotionPreview: trusted((_event, rawInput: unknown) =>
      callDomain(() => deps.service.previewPromotion(parsePromotionPreviewInput(rawInput))),
    ),
    dailyReport: trusted(() => callDomain(() => deps.service.generateDailyReport())),
    saveNoteDraft: trusted((_event, rawInput: unknown, rawMeta: unknown) =>
      callDomain(() => deps.service.saveNoteDraft(parseSaveNoteDraftInput(rawInput), parseMeta(rawMeta))),
    ),
    updateProductDraft: trusted((_event, rawInput: unknown, rawMeta: unknown) =>
      callDomain(() => deps.service.updateProductDraft(
        parseUpdateProductDraftInput(rawInput),
        parseMeta(rawMeta),
      )),
    ),
    prepareProductPublish: trusted((_event, rawProductId: unknown, rawMeta: unknown) =>
      callDomain(() => deps.service.prepareProductPublish(
        asString(rawProductId, 'productId'),
        parseMeta(rawMeta),
      )),
    ),
    prepareNotePublish: trusted((_event, rawNoteId: unknown, rawMeta: unknown) =>
      callDomain(() => deps.service.prepareNotePublish(
        asString(rawNoteId, 'noteId'),
        parseMeta(rawMeta),
      )),
    ),
    prepareCampaignEnrollment: trusted((_event, rawInput: unknown, rawMeta: unknown) =>
      callDomain(() => deps.service.prepareCampaignEnrollment(
        parseCampaignProfitInput(rawInput),
        parseMeta(rawMeta),
      )),
    ),
    preparePromotionLaunch: trusted((_event, rawInput: unknown, rawMeta: unknown) =>
      callDomain(() => deps.service.preparePromotionLaunch(
        parsePromotionPreviewInput(rawInput),
        parseMeta(rawMeta),
      )),
    ),
    executeApproval: trusted((_event, rawApprovalId: unknown, rawMeta: unknown) =>
      callDomain(() => deps.service.executeApproval(
        asString(rawApprovalId, 'approvalId'),
        parseMeta(rawMeta),
      )),
    ),
    rejectApproval: trusted(
      (_event, rawApprovalId: unknown, rawReason: unknown, rawMeta: unknown) =>
        callDomain(() => deps.service.rejectApproval(
          asString(rawApprovalId, 'approvalId'),
          asString(rawReason, 'reason', 300),
          parseMeta(rawMeta),
        )),
    ),
    resetDemo: trusted((_event, rawMeta: unknown) =>
      callDomain(() => deps.service.resetDemoState(parseMeta(rawMeta))),
    ),
  };
}

export function registerRednoteCommerceIpc(): void {
  const handlers = createRednoteCommerceIpcHandlers({
    service: getRednoteCommerceService(),
    assertTrustedSender: assertTrustedAppRendererEvent,
  });
  ipcMain.handle(REDNOTE_COMMERCE_CHANNELS.snapshot, handlers.snapshot);
  ipcMain.handle(REDNOTE_COMMERCE_CHANNELS.campaignProfit, handlers.campaignProfit);
  ipcMain.handle(REDNOTE_COMMERCE_CHANNELS.promotionPreview, handlers.promotionPreview);
  ipcMain.handle(REDNOTE_COMMERCE_CHANNELS.dailyReport, handlers.dailyReport);
  ipcMain.handle(REDNOTE_COMMERCE_CHANNELS.saveNoteDraft, handlers.saveNoteDraft);
  ipcMain.handle(REDNOTE_COMMERCE_CHANNELS.updateProductDraft, handlers.updateProductDraft);
  ipcMain.handle(REDNOTE_COMMERCE_CHANNELS.prepareProductPublish, handlers.prepareProductPublish);
  ipcMain.handle(REDNOTE_COMMERCE_CHANNELS.prepareNotePublish, handlers.prepareNotePublish);
  ipcMain.handle(REDNOTE_COMMERCE_CHANNELS.prepareCampaignEnrollment, handlers.prepareCampaignEnrollment);
  ipcMain.handle(REDNOTE_COMMERCE_CHANNELS.preparePromotionLaunch, handlers.preparePromotionLaunch);
  ipcMain.handle(REDNOTE_COMMERCE_CHANNELS.executeApproval, handlers.executeApproval);
  ipcMain.handle(REDNOTE_COMMERCE_CHANNELS.rejectApproval, handlers.rejectApproval);
  ipcMain.handle(REDNOTE_COMMERCE_CHANNELS.resetDemo, handlers.resetDemo);
}
