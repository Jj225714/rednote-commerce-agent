import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  CampaignProfitPreview,
  PromotionPreview,
  RednoteApproval,
  RednoteCommerceState,
  RednoteDailyReport,
} from '@rednote/commerce-core';
import {
  BarChart3,
  Boxes,
  CheckCircle2,
  FileText,
  Megaphone,
  RefreshCw,
  RotateCcw,
  ShoppingBag,
  Store,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';

import { InvisibleWindowDragStrip } from '@/components/layout/windowDrag';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { useRegisterCCAgentSidebar } from '@/features/cc-agent/useRegisterCCAgentSidebar';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { extractIpcError } from '@/utils/ipcError';

const SECTIONS = ['overview', 'products', 'content', 'campaigns', 'promotions', 'approvals'] as const;
type Section = (typeof SECTIONS)[number];

const SECTION_ICONS = {
  overview: BarChart3,
  products: ShoppingBag,
  content: FileText,
  campaigns: Boxes,
  promotions: Megaphone,
  approvals: CheckCircle2,
} satisfies Record<Section, typeof Store>;

const PANEL = 'rounded-xl border border-border bg-[var(--surface-elevated)]';
const INPUT = cn(
  'h-9 w-full rounded-lg border border-border bg-[var(--surface)] px-3 text-13 text-foreground outline-none',
  'placeholder:text-[var(--text-placeholder)] focus:border-[var(--focus-ring)]',
);
const BUTTON = cn(
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-full px-3 text-12 font-medium transition-colors',
  'bg-[var(--surface-chip)] text-foreground hover:bg-[var(--surface-chip-hover)] disabled:pointer-events-none disabled:opacity-45',
);
const PRIMARY_BUTTON = cn(BUTTON, 'bg-foreground text-background hover:opacity-85');

function formatMoney(cents: number): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'CNY' }).format(cents / 100);
}

function commandMeta(revision: number, prefix: string) {
  return { expectedRevision: revision, commandId: `${prefix}-${crypto.randomUUID()}` };
}

function normalizeSection(raw: string | null): Section {
  return SECTIONS.includes(raw as Section) ? (raw as Section) : 'overview';
}

function useRednoteCommerce() {
  const [snapshot, setSnapshot] = useState<RednoteCommerceState | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const snapshotRef = useRef<RednoteCommerceState | null>(null);

  const refresh = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true);
    else if (!snapshotRef.current) setLoading(true);
    try {
      const next = await window.electronAPI.rednoteCommerce.getSnapshot();
      setSnapshot((current) => {
        const resolved = !current || next.revision >= current.revision ? next : current;
        snapshotRef.current = resolved;
        return resolved;
      });
      setError(null);
      return next;
    } catch (nextError) {
      setError(nextError);
      throw nextError;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  useEffect(() => window.electronAPI.rednoteCommerce.onChanged(({ revision }) => {
    if (!snapshotRef.current || revision > snapshotRef.current.revision) {
      void refresh(true).catch(() => undefined);
    }
  }), [refresh]);

  useEffect(() => {
    const nextExpiry = snapshot?.approvals
      .filter((approval) => approval.status === 'pending')
      .map((approval) => new Date(approval.expiresAt).getTime())
      .filter(Number.isFinite)
      .sort((left, right) => left - right)[0];
    if (nextExpiry === undefined) return undefined;
    const delay = Math.min(Math.max(nextExpiry - Date.now() + 50, 50), 2_147_483_647);
    const timer = window.setTimeout(() => {
      void refresh(true).catch(() => undefined);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [refresh, snapshot]);

  return { snapshot, loading, refreshing, error, refresh };
}

export function RednoteWorkbench() {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [searchParams, setSearchParams] = useSearchParams();
  const section = normalizeSection(searchParams.get('section'));
  const { snapshot, loading, refreshing, error, refresh } = useRednoteCommerce();
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<RednoteDailyReport | null>(null);

  useRegisterCCAgentSidebar();

  const selectSection = (next: Section) => {
    const params = new URLSearchParams(searchParams);
    if (next === 'overview') params.delete('section');
    else params.set('section', next);
    setSearchParams(params, { replace: true });
  };

  const runMutation = useCallback(async <T,>(operation: () => Promise<T>, success: string) => {
    setBusy(true);
    try {
      const result = await operation();
      await refresh(true);
      toast.success(success);
      return result;
    } catch (operationError) {
      const ipcError = extractIpcError(operationError);
      if (ipcError?.code === 'PRECONDITION_FAILED') {
        await refresh(true).catch(() => undefined);
        toast.warning(t('rednote.messages.stale'));
      } else {
        toast.error(ipcError?.message ?? t('rednote.messages.failed'));
      }
      return null;
    } finally {
      setBusy(false);
    }
  }, [refresh, t]);

  const resetDemo = async () => {
    const accepted = await confirm({
      title: t('rednote.reset.title'),
      description: t('rednote.reset.description'),
      confirmText: t('rednote.reset.confirm'),
      cancelText: t('rednote.actions.cancel'),
    });
    if (!accepted) return;
    await runMutation(
      () => window.electronAPI.rednoteCommerce.resetDemo(commandMeta(snapshot?.revision ?? 0, 'reset-demo')),
      t('rednote.messages.reset'),
    );
    setReport(null);
  };

  const generateReport = async () => {
    setBusy(true);
    try {
      setReport(await window.electronAPI.rednoteCommerce.generateDailyReport());
    } catch (reportError) {
      toast.error(extractIpcError(reportError)?.message ?? t('rednote.messages.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col bg-content-area text-foreground">
      <InvisibleWindowDragStrip />
      <header className="shrink-0 border-b border-border px-5 pb-3 pt-8">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-xl border border-border bg-[var(--surface-elevated)]">
            <Store size={18} />
          </div>
          <div>
            <h1 className="text-15 font-medium">{t('rednote.title')}</h1>
            <p className="text-11 text-sidebar-muted">{t('rednote.demoNotice')}</p>
          </div>
          <div className="flex-1" />
          <span className="rounded-full bg-[var(--surface-chip)] px-2.5 py-1 text-11 text-sidebar-muted">
            {snapshot ? `revision ${snapshot.revision}` : t('rednote.loading')}
          </span>
          <button
            type="button"
            className={BUTTON}
            disabled={refreshing || loading}
            onClick={() => void refresh(true).catch(() => undefined)}
          >
            <span className={cn('inline-flex', refreshing && 'animate-spinner')}><RefreshCw size={13} /></span>
            {t('rednote.actions.refresh')}
          </button>
          <button type="button" className={BUTTON} disabled={!snapshot || busy} onClick={() => void resetDemo()}>
            <RotateCcw size={13} />
            {t('rednote.actions.reset')}
          </button>
        </div>
        <nav className="mt-4 flex gap-1 overflow-x-auto" aria-label={t('rednote.nav.workbench')}>
          {SECTIONS.map((item) => {
            const Icon = SECTION_ICONS[item];
            const active = item === section;
            return (
              <button
                key={item}
                type="button"
                onClick={() => selectSection(item)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-12 transition-colors',
                  active ? 'bg-foreground text-background' : 'text-sidebar-muted hover:bg-[var(--surface-chip)] hover:text-foreground',
                )}
              >
                <Icon size={13} />
                {t(`rednote.sections.${item}`)}
              </button>
            );
          })}
        </nav>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-5">
        {!snapshot && loading ? <LoadingState /> : null}
        {!snapshot && error ? (
          <ErrorState
            onRetry={() => void refresh().catch(() => undefined)}
            onReset={() => void resetDemo()}
          />
        ) : null}
        {snapshot ? (
          <>
            {section === 'overview' ? (
              <OverviewSection snapshot={snapshot} report={report} busy={busy} onGenerateReport={generateReport} />
            ) : null}
            {section === 'products' ? <ProductsSection snapshot={snapshot} busy={busy} runMutation={runMutation} /> : null}
            {section === 'content' ? <ContentSection snapshot={snapshot} busy={busy} runMutation={runMutation} /> : null}
            {section === 'campaigns' ? <CampaignsSection snapshot={snapshot} busy={busy} runMutation={runMutation} /> : null}
            {section === 'promotions' ? <PromotionsSection snapshot={snapshot} busy={busy} runMutation={runMutation} /> : null}
            {section === 'approvals' ? <ApprovalsSection snapshot={snapshot} busy={busy} runMutation={runMutation} /> : null}
          </>
        ) : null}
      </main>
    </div>
  );
}

function LoadingState() {
  const { t } = useTranslation();
  return <p className="text-13 text-sidebar-muted">{t('rednote.loading')}</p>;
}

function ErrorState({ onRetry, onReset }: { onRetry: () => void; onReset: () => void }) {
  const { t } = useTranslation();
  return (
    <div className={cn(PANEL, 'p-5')}>
      <p className="text-13">{t('rednote.messages.loadFailed')}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={BUTTON} onClick={onRetry}>{t('rednote.actions.retry')}</button>
        <button type="button" className={BUTTON} onClick={onReset}>{t('rednote.actions.reset')}</button>
      </div>
    </div>
  );
}

function OverviewSection({
  snapshot,
  report,
  busy,
  onGenerateReport,
}: {
  snapshot: RednoteCommerceState;
  report: RednoteDailyReport | null;
  busy: boolean;
  onGenerateReport: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const today = snapshot.metrics.at(-1);
  const estimatedProfit = (today?.gmvCents ?? 0) - (today?.refundCents ?? 0) - (today?.adSpendCents ?? 0);
  const cards = [
    [t('rednote.metrics.gmv'), formatMoney(today?.gmvCents ?? 0)],
    [t('rednote.metrics.orders'), String(today?.orderCount ?? 0)],
    [t('rednote.metrics.profit'), formatMoney(estimatedProfit)],
    [t('rednote.metrics.adSpend'), formatMoney(today?.adSpendCents ?? 0)],
    [t('rednote.metrics.lowStock'), String(snapshot.products.filter((item) => item.status === 'low_stock').length)],
    [t('rednote.metrics.pending'), String(snapshot.approvals.filter((item) => item.status === 'pending').length)],
  ];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {cards.map(([label, value]) => (
          <div key={label} className={cn(PANEL, 'p-4')}>
            <p className="text-11 text-sidebar-muted">{label}</p>
            <p className="mt-2 text-18 font-medium">{value}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <section className={cn(PANEL, 'p-4')}>
          <h2 className="text-13 font-medium">{t('rednote.overview.alerts')}</h2>
          <div className="mt-3 space-y-2">
            {snapshot.products.filter((item) => item.status === 'low_stock').map((product) => (
              <div key={product.id} className="flex items-center justify-between rounded-lg bg-[var(--surface-chip-alt)] px-3 py-2 text-12">
                <span>{product.name}</span><span className="text-sidebar-muted">{t('rednote.overview.inventory', { count: product.inventory })}</span>
              </div>
            ))}
            {snapshot.approvals.filter((item) => item.status === 'pending').slice(0, 3).map((approval) => (
              <div key={approval.id} className="flex items-center justify-between rounded-lg bg-[var(--surface-chip-alt)] px-3 py-2 text-12">
                <span>{t(`rednote.approvalKinds.${approval.kind}`)}</span><span className="text-sidebar-muted">{t('rednote.status.pending')}</span>
              </div>
            ))}
          </div>
        </section>
        <section className={cn(PANEL, 'p-4')}>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-13 font-medium">{t('rednote.overview.report')}</h2>
            <button type="button" className={PRIMARY_BUTTON} disabled={busy} onClick={() => void onGenerateReport()}>
              {t('rednote.actions.generateReport')}
            </button>
          </div>
          {report ? (
            <div className="mt-3 space-y-3 text-12">
              <p>{report.headline}</p>
              <ReportList title={t('rednote.overview.highlights')} items={report.highlights} />
              <ReportList title={t('rednote.overview.risks')} items={report.risks} />
              <ReportList title={t('rednote.overview.recommendations')} items={report.recommendedActions} />
            </div>
          ) : <p className="mt-3 text-12 text-sidebar-muted">{t('rednote.overview.reportEmpty')}</p>}
        </section>
      </div>
    </div>
  );
}

function ReportList({ title, items }: { title: string; items: string[] }) {
  return <div><p className="font-medium">{title}</p><ul className="mt-1 list-disc space-y-1 pl-4 text-sidebar-muted">{items.map((item) => <li key={item}>{item}</li>)}</ul></div>;
}

type MutationRunner = <T>(operation: () => Promise<T>, success: string) => Promise<T | null>;

function ProductsSection({ snapshot, busy, runMutation }: { snapshot: RednoteCommerceState; busy: boolean; runMutation: MutationRunner }) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState(snapshot.products[0]?.id ?? '');
  const selected = snapshot.products.find((item) => item.id === selectedId) ?? snapshot.products[0];
  const [name, setName] = useState(selected?.name ?? '');
  const [price, setPrice] = useState(selected ? String(selected.priceCents / 100) : '');
  const [inventory, setInventory] = useState(selected ? String(selected.inventory) : '');
  useEffect(() => {
    setName(selected?.name ?? '');
    setPrice(selected ? String(selected.priceCents / 100) : '');
    setInventory(selected ? String(selected.inventory) : '');
  }, [selected?.id, selected?.name, selected?.priceCents, selected?.inventory]);
  if (!selected) return null;

  const save = () => runMutation(
    () => window.electronAPI.rednoteCommerce.updateProductDraft({
      productId: selected.id,
      name,
      priceCents: Math.round(Number(price) * 100),
      inventory: Number(inventory),
    }, commandMeta(snapshot.revision, 'product-draft')),
    t('rednote.messages.productSaved'),
  );
  const prepare = () => runMutation(
    () => window.electronAPI.rednoteCommerce.prepareProductPublish(
      selected.id,
      commandMeta(snapshot.revision, 'product-publish'),
    ),
    t('rednote.messages.approvalCreated'),
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(260px,0.8fr)_minmax(320px,1.2fr)]">
      <section className={cn(PANEL, 'overflow-hidden')}>
        {snapshot.products.map((product) => (
          <button key={product.id} type="button" onClick={() => setSelectedId(product.id)} className={cn('flex w-full items-center justify-between border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-[var(--surface-chip-alt)]', selected.id === product.id && 'bg-[var(--surface-chip-alt)]')}>
            <span><span className="block text-13">{product.name}</span><span className="text-11 text-sidebar-muted">{product.sku}</span></span>
            <StatusBadge status={product.status} />
          </button>
        ))}
      </section>
      <section className={cn(PANEL, 'p-4')}>
        <h2 className="text-13 font-medium">{t('rednote.products.edit')}</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label={t('rednote.products.name')}><input className={INPUT} value={name} onChange={(event) => setName(event.target.value)} /></Field>
          <Field label={t('rednote.products.price')}><input className={INPUT} type="number" min="0.01" step="0.01" value={price} onChange={(event) => setPrice(event.target.value)} /></Field>
          <Field label={t('rednote.products.inventory')}><input className={INPUT} type="number" min="0" step="1" value={inventory} onChange={(event) => setInventory(event.target.value)} /></Field>
          <Field label={t('rednote.products.cost')}><div className="flex h-9 items-center text-13">{formatMoney(selected.costCents)}</div></Field>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className={PRIMARY_BUTTON} disabled={busy} onClick={() => void save()}>{t('rednote.actions.saveDraft')}</button>
          <button type="button" className={BUTTON} disabled={busy} onClick={() => void prepare()}>{t('rednote.actions.preparePublish')}</button>
        </div>
      </section>
    </div>
  );
}

function ContentSection({ snapshot, busy, runMutation }: { snapshot: RednoteCommerceState; busy: boolean; runMutation: MutationRunner }) {
  const { t } = useTranslation();
  const [productId, setProductId] = useState(snapshot.products[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState('');
  const [angle, setAngle] = useState('');
  const save = async () => {
    const result = await runMutation(
      () => window.electronAPI.rednoteCommerce.saveNoteDraft({
        productId,
        title,
        body,
        tags: tags.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
        angle,
      }, commandMeta(snapshot.revision, 'note-draft')),
      t('rednote.messages.noteSaved'),
    );
    if (result) { setTitle(''); setBody(''); setTags(''); setAngle(''); }
  };
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <section className={cn(PANEL, 'p-4')}>
        <h2 className="text-13 font-medium">{t('rednote.content.newDraft')}</h2>
        <div className="mt-4 space-y-3">
          <Field label={t('rednote.content.product')}><select className={INPUT} value={productId} onChange={(event) => setProductId(event.target.value)}>{snapshot.products.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
          <Field label={t('rednote.content.title')}><input className={INPUT} value={title} maxLength={60} onChange={(event) => setTitle(event.target.value)} /></Field>
          <Field label={t('rednote.content.body')}><textarea className={cn(INPUT, 'h-28 resize-y py-2')} value={body} maxLength={2000} onChange={(event) => setBody(event.target.value)} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('rednote.content.tags')}><input className={INPUT} value={tags} onChange={(event) => setTags(event.target.value)} /></Field>
            <Field label={t('rednote.content.angle')}><input className={INPUT} value={angle} onChange={(event) => setAngle(event.target.value)} /></Field>
          </div>
          <button type="button" className={PRIMARY_BUTTON} disabled={busy || !title || body.trim().length < 20 || !angle} onClick={() => void save()}>{t('rednote.actions.saveDraft')}</button>
        </div>
      </section>
      <section className={cn(PANEL, 'overflow-hidden')}>
        {snapshot.notes.map((note) => (
          <div key={note.id} className="border-b border-border p-4 last:border-b-0">
            <div className="flex items-start justify-between gap-3"><div><h3 className="text-13 font-medium">{note.title}</h3><p className="mt-1 line-clamp-2 text-12 text-sidebar-muted">{note.body}</p></div><StatusBadge status={note.status} /></div>
            <div className="mt-3 flex flex-wrap items-center gap-2">{note.tags.map((tag) => <span key={tag} className="rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-10 text-sidebar-muted">#{tag}</span>)}<div className="flex-1" />{note.status === 'draft' ? <button type="button" className={BUTTON} disabled={busy} onClick={() => void runMutation(() => window.electronAPI.rednoteCommerce.prepareNotePublish(note.id, commandMeta(snapshot.revision, 'note-publish')), t('rednote.messages.approvalCreated'))}>{t('rednote.actions.preparePublish')}</button> : null}</div>
          </div>
        ))}
      </section>
    </div>
  );
}

function CampaignsSection({ snapshot, busy, runMutation }: { snapshot: RednoteCommerceState; busy: boolean; runMutation: MutationRunner }) {
  const { t } = useTranslation();
  const [productId, setProductId] = useState(snapshot.products[0]?.id ?? '');
  const [campaignId, setCampaignId] = useState(snapshot.campaigns.find((item) => item.status !== 'closed')?.id ?? snapshot.campaigns[0]?.id ?? '');
  const [stock, setStock] = useState('20');
  const [budget, setBudget] = useState('0');
  const [preview, setPreview] = useState<CampaignProfitPreview | null>(null);
  const input = () => ({ productId, campaignId, plannedStock: Number(stock), promotionBudgetCents: Math.round(Number(budget) * 100) });
  const calculate = async () => {
    try { setPreview(await window.electronAPI.rednoteCommerce.calculateCampaignProfit(input())); }
    catch (error) { toast.error(extractIpcError(error)?.message ?? t('rednote.messages.failed')); }
  };
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <section className={cn(PANEL, 'p-4')}>
        <h2 className="text-13 font-medium">{t('rednote.campaigns.profit')}</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label={t('rednote.content.product')}><select className={INPUT} value={productId} onChange={(event) => setProductId(event.target.value)}>{snapshot.products.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
          <Field label={t('rednote.campaigns.campaign')}><select className={INPUT} value={campaignId} onChange={(event) => setCampaignId(event.target.value)}>{snapshot.campaigns.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
          <Field label={t('rednote.campaigns.stock')}><input className={INPUT} type="number" min="1" value={stock} onChange={(event) => setStock(event.target.value)} /></Field>
          <Field label={t('rednote.campaigns.budget')}><input className={INPUT} type="number" min="0" step="0.01" value={budget} onChange={(event) => setBudget(event.target.value)} /></Field>
        </div>
        <div className="mt-4 flex gap-2"><button type="button" className={BUTTON} onClick={() => void calculate()}>{t('rednote.actions.preview')}</button><button type="button" className={PRIMARY_BUTTON} disabled={busy || !preview} onClick={() => void runMutation(() => window.electronAPI.rednoteCommerce.prepareCampaignEnrollment(input(), commandMeta(snapshot.revision, 'campaign-enroll')), t('rednote.messages.approvalCreated'))}>{t('rednote.actions.prepareEnrollment')}</button></div>
      </section>
      <PreviewPanel title={t('rednote.campaigns.preview')} preview={preview ? [[t('rednote.campaigns.revenue'), formatMoney(preview.projectedRevenueCents)], [t('rednote.metrics.profit'), formatMoney(preview.projectedNetProfitCents)], [t('rednote.campaigns.margin'), `${(preview.projectedMarginBps / 100).toFixed(1)}%`]] : null} risks={preview?.risks} />
    </div>
  );
}

function PromotionsSection({ snapshot, busy, runMutation }: { snapshot: RednoteCommerceState; busy: boolean; runMutation: MutationRunner }) {
  const { t } = useTranslation();
  const [promotionId, setPromotionId] = useState(snapshot.promotions[0]?.id ?? '');
  const selected = snapshot.promotions.find((item) => item.id === promotionId) ?? snapshot.promotions[0];
  const [budget, setBudget] = useState(selected ? String(selected.dailyBudgetCents / 100) : '');
  const [preview, setPreview] = useState<PromotionPreview | null>(null);
  useEffect(() => { if (selected) { setBudget(String(selected.dailyBudgetCents / 100)); setPreview(null); } }, [selected?.id, selected?.dailyBudgetCents]);
  if (!selected) return null;
  const input = () => ({ promotionId: selected.id, dailyBudgetCents: Math.round(Number(budget) * 100) });
  const calculate = async () => {
    try { setPreview(await window.electronAPI.rednoteCommerce.previewPromotion(input())); }
    catch (error) { toast.error(extractIpcError(error)?.message ?? t('rednote.messages.failed')); }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(260px,0.8fr)_minmax(320px,1.2fr)]">
      <section className={cn(PANEL, 'overflow-hidden')}>{snapshot.promotions.map((item) => <button key={item.id} type="button" onClick={() => setPromotionId(item.id)} className={cn('flex w-full items-center justify-between border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-[var(--surface-chip-alt)]', selected.id === item.id && 'bg-[var(--surface-chip-alt)]')}><span><span className="block text-13">{item.name}</span><span className="text-11 text-sidebar-muted">ROI {item.spendCents ? (item.attributedRevenueCents / item.spendCents).toFixed(2) : '0.00'}</span></span><StatusBadge status={item.status} /></button>)}</section>
      <section className={cn(PANEL, 'p-4')}><h2 className="text-13 font-medium">{t('rednote.promotions.preview')}</h2><div className="mt-4 max-w-sm"><Field label={t('rednote.promotions.dailyBudget')}><input className={INPUT} type="number" min="1" step="0.01" value={budget} onChange={(event) => setBudget(event.target.value)} /></Field></div><div className="mt-4 flex gap-2"><button type="button" className={BUTTON} onClick={() => void calculate()}>{t('rednote.actions.preview')}</button><button type="button" className={PRIMARY_BUTTON} disabled={busy || !preview} onClick={() => void runMutation(() => window.electronAPI.rednoteCommerce.preparePromotionLaunch(input(), commandMeta(snapshot.revision, 'promotion-launch')), t('rednote.messages.approvalCreated'))}>{t('rednote.actions.prepareLaunch')}</button></div>{preview ? <div className="mt-4 grid grid-cols-2 gap-2 text-12"><Metric label="ROAS" value={`${(preview.projectedRoasBps / 100).toFixed(1)}%`} /><Metric label={t('rednote.metrics.profit')} value={formatMoney(preview.projectedNetProfitCents)} />{preview.risks.map((risk) => <p key={risk} className="col-span-2 text-[var(--warning-fg)]">{risk}</p>)}</div> : null}</section>
    </div>
  );
}

function ApprovalsSection({ snapshot, busy, runMutation }: { snapshot: RednoteCommerceState; busy: boolean; runMutation: MutationRunner }) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const execute = async (approval: RednoteApproval) => {
    const accepted = await confirm({ title: t('rednote.approvals.confirmTitle'), description: t('rednote.approvals.confirmDescription'), confirmText: t('rednote.actions.approve'), cancelText: t('rednote.actions.cancel') });
    if (!accepted) return;
    await runMutation(() => window.electronAPI.rednoteCommerce.executeApproval(approval.id, commandMeta(snapshot.revision, 'approval-execute')), t('rednote.messages.approvalExecuted'));
  };
  return (
    <div className="space-y-3">
      {snapshot.approvals.length === 0 ? <div className={cn(PANEL, 'p-6 text-13 text-sidebar-muted')}>{t('rednote.approvals.empty')}</div> : snapshot.approvals.slice().reverse().map((approval) => (
        <section key={approval.id} className={cn(PANEL, 'p-4')}>
          <div className="flex flex-wrap items-start gap-3"><div><h2 className="text-13 font-medium">{t(`rednote.approvalKinds.${approval.kind}`)}</h2><p className="mt-1 text-11 text-sidebar-muted">{new Date(approval.createdAt).toLocaleString()} · {t('rednote.approvals.expires', { time: new Date(approval.expiresAt).toLocaleTimeString() })}</p></div><div className="flex-1" /><StatusBadge status={approval.status} /></div>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-[var(--surface-chip-alt)] p-3 text-11 text-sidebar-muted">{JSON.stringify(approval.proposal, null, 2)}</pre>
          {approval.status === 'pending' ? <div className="mt-3 flex flex-wrap items-center gap-2"><button type="button" className={PRIMARY_BUTTON} disabled={busy} onClick={() => void execute(approval)}>{t('rednote.actions.approve')}</button><input className={cn(INPUT, 'max-w-xs')} value={reasons[approval.id] ?? ''} placeholder={t('rednote.approvals.reason')} onChange={(event) => setReasons((current) => ({ ...current, [approval.id]: event.target.value }))} /><button type="button" className={BUTTON} disabled={busy || !(reasons[approval.id]?.trim())} onClick={() => void runMutation(() => window.electronAPI.rednoteCommerce.rejectApproval(approval.id, reasons[approval.id]!.trim(), commandMeta(snapshot.revision, 'approval-reject')), t('rednote.messages.approvalRejected'))}>{t('rednote.actions.reject')}</button></div> : null}
        </section>
      ))}
      <section className={cn(PANEL, 'p-4')}><h2 className="text-13 font-medium">{t('rednote.approvals.audit')}</h2><div className="mt-3 space-y-2">{snapshot.auditLog.slice().reverse().map((entry) => <div key={entry.id} className="flex flex-wrap justify-between gap-2 border-b border-border pb-2 text-12 last:border-b-0"><span>{entry.summary}</span><span className="text-sidebar-muted">{new Date(entry.createdAt).toLocaleString()}</span></div>)}</div></section>
    </div>
  );
}

function PreviewPanel({ title, preview, risks }: { title: string; preview: Array<[string, string]> | null; risks?: string[] }) {
  const { t } = useTranslation();
  return <section className={cn(PANEL, 'p-4')}><h2 className="text-13 font-medium">{title}</h2>{preview ? <><div className="mt-4 grid grid-cols-2 gap-2">{preview.map(([label, value]) => <Metric key={label} label={label} value={value} />)}</div>{risks?.map((risk) => <p key={risk} className="mt-2 text-12 text-[var(--warning-fg)]">{risk}</p>)}</> : <p className="mt-3 text-12 text-sidebar-muted">{t('rednote.previewEmpty')}</p>}</section>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-[var(--surface-chip-alt)] p-3"><p className="text-10 text-sidebar-muted">{label}</p><p className="mt-1 text-14 font-medium">{value}</p></div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-11 text-sidebar-muted">{label}</span>{children}</label>;
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  return <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-10 text-sidebar-muted">{t(`rednote.status.${status}`)}</span>;
}
