import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

import {
  RednoteCommerceService,
  type RednoteCommerceState,
  type RednoteStateRepository,
} from '@rednote/commerce-core';
import { createRednoteCommerceIpcHandlers } from '../ipc.js';

class MemoryRepository implements RednoteStateRepository {
  state: RednoteCommerceState | null = null;
  async load() {
    return this.state ? structuredClone(this.state) : null;
  }
  async save(state: RednoteCommerceState) {
    this.state = structuredClone(state);
  }
}

function createHandlers(assertTrustedSender = vi.fn()) {
  const repository = new MemoryRepository();
  const service = new RednoteCommerceService({
    repository,
    now: () => new Date('2026-08-05T00:00:00.000Z'),
    createId: (prefix) => `${prefix}-ipc-test`,
  });
  return {
    repository,
    assertTrustedSender,
    handlers: createRednoteCommerceIpcHandlers({
      service,
      assertTrustedSender,
    }),
  };
}

const event = {} as never;

describe('rednote commerce IPC', () => {
  beforeEach(() => vi.clearAllMocks());

  it('checks the trusted renderer before every operation', async () => {
    const assertTrustedSender = vi.fn(() => {
      throw new Error('untrusted sender');
    });
    const { handlers } = createHandlers(assertTrustedSender);

    expect(() => handlers.snapshot(event)).toThrow('untrusted sender');
    expect(assertTrustedSender).toHaveBeenCalledOnce();
  });

  it('returns the shared demo snapshot to a trusted renderer', async () => {
    const { handlers, assertTrustedSender } = createHandlers();
    const snapshot = await handlers.snapshot(event);

    expect(snapshot.dataMode).toBe('demo');
    expect(snapshot.products).toHaveLength(6);
    expect(assertTrustedSender).toHaveBeenCalledWith(event);
  });

  it('rejects malformed mutation metadata before writing', async () => {
    const { handlers, repository } = createHandlers();
    await handlers.snapshot(event);

    await expect(
      handlers.prepareProductPublish(event, 'product-storage', {
        commandId: '',
        expectedRevision: '0',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(repository.state?.revision).toBe(0);
  });

  it('rejects malformed nested payloads at the IPC boundary before domain code runs', async () => {
    const { handlers, repository } = createHandlers();
    await handlers.snapshot(event);

    await expect(
      handlers.saveNoteDraft(
        event,
        {
          productId: 'product-ceramic-cup',
          title: 'Valid title',
          body: 'This body is long enough for the domain rules.',
          tags: 'not-an-array',
          angle: 'portable',
        },
        { commandId: 'malformed-note', expectedRevision: 0 },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(repository.state?.revision).toBe(0);
    expect(repository.state?.notes).toHaveLength(4);
  });

  it('rejects unknown fields and out-of-range numbers at the IPC boundary', async () => {
    const { handlers, repository } = createHandlers();
    await handlers.snapshot(event);

    await expect(
      handlers.prepareCampaignEnrollment(
        event,
        {
          productId: 'product-ceramic-cup',
          campaignId: 'campaign-summer-home',
          plannedStock: -1,
          bypassApproval: true,
        },
        { commandId: 'malformed-campaign', expectedRevision: 0 },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(repository.state?.revision).toBe(0);
    expect(repository.state?.approvals).toHaveLength(0);
  });

  it('maps stale revisions to the shared precondition error', async () => {
    const { handlers, repository } = createHandlers();
    await handlers.snapshot(event);

    await expect(
      handlers.prepareProductPublish(event, 'product-storage', {
        commandId: 'prepare-stale',
        expectedRevision: 99,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(repository.state?.approvals).toHaveLength(0);
  });

  it('creates a local approval but does not execute it', async () => {
    const { handlers, repository } = createHandlers();
    const snapshot = await handlers.snapshot(event);
    const approval = await handlers.prepareNotePublish(event, 'note-cup-commute', {
      commandId: 'prepare-note-ipc',
      expectedRevision: snapshot.revision,
    });

    expect(approval.status).toBe('pending');
    expect(repository.state?.notes.find((note) => note.id === 'note-cup-commute')?.status).toBe('pending_approval');
    expect(repository.state?.approvals).toHaveLength(1);
  });

  it('maps unexpected repository failures to a generic IPC error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const service = {
      getStateSnapshot: vi.fn().mockRejectedValue(new Error('secret local store path')),
    } as unknown as RednoteCommerceService;
    const handlers = createRednoteCommerceIpcHandlers({
      service,
      assertTrustedSender: vi.fn(),
    });

    await expect(handlers.snapshot(event)).rejects.toMatchObject({
      code: 'INTERNAL',
      message: expect.not.stringContaining('secret local store path'),
    });
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
