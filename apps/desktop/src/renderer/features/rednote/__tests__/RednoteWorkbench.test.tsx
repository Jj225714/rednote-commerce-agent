// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRednoteDemoState, type RednoteCommerceState } from '@rednote/commerce-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

const confirm = vi.fn(async () => true);

vi.mock('@/features/cc-agent/useRegisterCCAgentSidebar', () => ({
  useRegisterCCAgentSidebar: () => undefined,
}));
vi.mock('@/components/layout/windowDrag', () => ({
  InvisibleWindowDragStrip: () => null,
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm }),
}));
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      if (vars && 'count' in vars) return `${key}:${String(vars.count)}`;
      if (vars && 'time' in vars) return `${key}:${String(vars.time)}`;
      return key;
    },
  }),
}));

const { RednoteWorkbench } = await import('../RednoteWorkbench');

function renderWorkbench() {
  return render(<MemoryRouter initialEntries={['/rednote']}><RednoteWorkbench /></MemoryRouter>);
}

describe('RednoteWorkbench', () => {
  let state: RednoteCommerceState;
  let changed: ((event: { revision: number }) => void) | null;
  let getSnapshot: ReturnType<typeof vi.fn>;
  let resetDemo: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    state = createRednoteDemoState();
    changed = null;
    getSnapshot = vi.fn(async () => structuredClone(state));
    resetDemo = vi.fn();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        rednoteCommerce: {
          getSnapshot,
          onChanged: vi.fn((callback: (event: { revision: number }) => void) => {
            changed = callback;
            return vi.fn();
          }),
          generateDailyReport: vi.fn(),
          resetDemo,
          updateProductDraft: vi.fn(),
          prepareProductPublish: vi.fn(),
          saveNoteDraft: vi.fn(),
          prepareNotePublish: vi.fn(),
          calculateCampaignProfit: vi.fn(),
          prepareCampaignEnrollment: vi.fn(),
          previewPromotion: vi.fn(),
          preparePromotionLaunch: vi.fn(),
          executeApproval: vi.fn(),
          rejectApproval: vi.fn(),
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('loads the demo snapshot and switches between all commerce sections', async () => {
    renderWorkbench();

    expect(await screen.findByText('rednote.title')).toBeTruthy();
    expect(screen.getByText('revision 0')).toBeTruthy();
    expect(screen.getByText('rednote.demoNotice')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'rednote.sections.products' }));
    expect(await screen.findByText('通勤陶瓷随行杯')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'rednote.sections.content' }));
    expect(screen.getByText('rednote.content.newDraft')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'rednote.sections.campaigns' }));
    expect(screen.getByText('rednote.campaigns.profit')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'rednote.sections.promotions' }));
    expect(screen.getByText('rednote.promotions.preview')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'rednote.sections.approvals' }));
    expect(screen.getByText('rednote.approvals.audit')).toBeTruthy();
  });

  it('atomically refreshes when Main announces a newer revision', async () => {
    renderWorkbench();
    await screen.findByText('revision 0');
    expect(changed).not.toBeNull();

    state = { ...state, revision: 1 };
    await act(async () => {
      changed?.({ revision: 1 });
    });

    await waitFor(() => expect(screen.getByText('revision 1')).toBeTruthy());
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });

  it('offers a confirmed demo reset when persisted state cannot be loaded', async () => {
    getSnapshot.mockRejectedValueOnce(new Error('invalid persisted state'));
    resetDemo.mockImplementation(async () => {
      state = { ...createRednoteDemoState(), revision: 1 };
      return { revision: 1 };
    });
    renderWorkbench();

    expect(await screen.findByText('rednote.messages.loadFailed')).toBeTruthy();
    const resetButton = screen
      .getAllByRole('button', { name: 'rednote.actions.reset' })
      .find((button) => !button.hasAttribute('disabled'));
    if (!resetButton) throw new Error('missing enabled recovery reset button');
    fireEvent.click(resetButton);

    await waitFor(() => expect(resetDemo).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 0,
      commandId: expect.stringMatching(/^reset-demo-/),
    })));
    expect(confirm).toHaveBeenCalledOnce();
    expect(await screen.findByText('revision 1')).toBeTruthy();
  });

  it('refreshes when the nearest pending approval reaches its expiry time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T00:00:00.000Z'));
    state.approvals = [{
      id: 'approval-expiring',
      kind: 'product.publish',
      status: 'pending',
      proposal: {
        kind: 'product.publish',
        productId: 'product-storage',
        productName: '桌面模块化收纳盒',
        priceCents: 4_590,
        inventory: 24,
        sellingPoints: ['模块组合'],
      },
      proposalHash: 'test-hash',
      createdAt: '2026-08-05T00:00:00.000Z',
      expiresAt: '2026-08-05T00:00:00.100Z',
      decidedAt: null,
      decisionReason: null,
    }];
    renderWorkbench();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getSnapshot).toHaveBeenCalledTimes(1);

    state = {
      ...state,
      approvals: state.approvals.map((approval) => ({
        ...approval,
        status: 'expired' as const,
        decidedAt: approval.expiresAt,
        decisionReason: '审批已过期',
      })),
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });
});
