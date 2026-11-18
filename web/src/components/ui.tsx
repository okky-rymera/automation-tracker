import type { ReactNode } from 'react';
import { featurePct, featureTotal, type FunctionState, type LineCounts, type View } from '../api';

export const STATE_META: Record<FunctionState | 'none', { label: string; icon: string; color: string; tint: string }> = {
  library: { label: 'Library (runs on every request)', icon: '▣', color: 'var(--lib)', tint: 'var(--lib-tint)' },
  tested: { label: 'Run by tests', icon: '✓', color: 'var(--good)', tint: 'var(--good-tint)' },
  setup: { label: 'Run only in test setup', icon: '◐', color: 'var(--warn)', tint: 'var(--warn-tint)' },
  background: { label: 'Run only in background', icon: '◌', color: 'var(--warn)', tint: 'var(--warn-tint)' },
  never: { label: 'Never run', icon: '✕', color: 'var(--bad)', tint: 'var(--bad-tint)' },
  unknown: { label: 'File never loaded', icon: '?', color: 'var(--bad)', tint: 'var(--bad-tint)' },
  none: { label: 'Not measured', icon: '–', color: 'var(--none)', tint: 'transparent' },
};

/** "Both" view: lines or functions that only Cypress tests ran. They are what the Playwright tests still need to reach. */
export const CY_ONLY_META = { label: 'Run only by Cypress', icon: '◆', color: 'var(--cy)', tint: 'var(--cy-tint)' };

export const VIEW_LABEL: Record<View, string> = { playwright: 'Playwright', cypress: 'Cypress', both: 'Playwright + Cypress' };

export function StateBadge({ state, cypressOnly = false, label }: { state: FunctionState | 'none'; cypressOnly?: boolean; label?: string }) {
  const m = { ...(cypressOnly ? CY_ONLY_META : STATE_META[state]), ...(label ? { label } : {}) };
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs text-ink-2" style={{ background: m.tint }}>
      <span style={{ color: m.color }} aria-hidden>
        {m.icon}
      </span>
      {m.label}
    </span>
  );
}

/**
 * Stacked bar of runnable lines: tested / setup only / never run, with a 2px gap.
 * In the "both" view the tested part splits: run by Playwright (green) and run only by Cypress (purple).
 * withLibrary adds the library lines in front (the "all code" view).
 */
export function CoverageBar({ c, height = 8, withLibrary = false, className = '' }: { c: LineCounts; height?: number; withLibrary?: boolean; className?: string }) {
  const parts = [
    ...(withLibrary ? [{ n: c.library, color: 'var(--lib)' }] : []),
    { n: c.tested - c.cypressOnly, color: 'var(--good)' },
    { n: c.cypressOnly, color: 'var(--cy)' },
    { n: c.setup + c.background, color: 'var(--warn)' },
    { n: c.never, color: 'var(--bad)' },
  ].filter((p) => p.n > 0);
  const ft = featureTotal(c);
  const cy = c.cypressOnly ? ` (${c.cypressOnly} only by Cypress)` : '';
  const title = withLibrary
    ? `${c.runnable} runnable lines: ${c.library} library · ${c.tested} feature lines run by tests${cy} · ${c.setup + c.background} setup only · ${c.never} never run`
    : `${c.tested} of ${ft} feature lines run by tests (${featurePct(c)}%)${cy} · ${c.setup + c.background} setup only · ${c.never} never run`;
  const empty = withLibrary ? c.runnable === 0 : ft === 0;
  return (
    <div className={`flex w-full gap-[2px] ${className}`} style={{ height }} title={title} role="img" aria-label={title}>
      {empty ? (
        <div className="h-full w-full rounded-full bg-surface-2" />
      ) : (
        parts.map((p, i) => (
          <div key={i} className="h-full first:rounded-l-full last:rounded-r-full" style={{ flexGrow: p.n, flexBasis: 0, background: p.color, minWidth: 2 }} />
        ))
      )}
    </div>
  );
}

export function Stat({ label, value, sub, children }: { label: string; value: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-ink-3">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-2">{sub}</div>}
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="inline-block rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-2">{children}</span>;
}

export function Swatch({ color, label, outline }: { color: string; label: string; outline?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block h-2.5 w-2.5 rounded-sm ${outline ? 'border border-line' : ''}`} style={{ background: color }} />
      {label}
    </span>
  );
}

export function Legend({ view }: { view?: View | null }) {
  const both = view === 'both';
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
      {(['library', 'tested', 'setup', 'never', 'none'] as const).flatMap((s) => [
        <Swatch key={s} color={STATE_META[s].color} label={s === 'tested' && both ? 'Run by Playwright tests' : STATE_META[s].label} />,
        ...(s === 'tested' && both ? [<Swatch key="cy" color={CY_ONLY_META.color} label={`${CY_ONLY_META.label} (not by Playwright yet)`} />] : []),
      ])}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="p-8 text-center text-sm text-ink-3">{children}</div>;
}

export function Loading({ error }: { error?: string | null }) {
  return <Empty>{error ? `Could not load: ${error}` : 'Loading…'}</Empty>;
}
