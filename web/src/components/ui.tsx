import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
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

export function StateBadge({ state, cypressOnly = false }: { state: FunctionState | 'none'; cypressOnly?: boolean }) {
  const m = cypressOnly ? CY_ONLY_META : STATE_META[state];
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

/** Puts text on the clipboard. The fallback works on a plain-http address, where the clipboard API is not available. */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const before = document.activeElement as HTMLElement | null;
    const box = document.createElement('textarea');
    box.value = text;
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.appendChild(box);
    box.focus();
    box.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    box.remove();
    before?.focus();
    return ok;
  }
}

/**
 * An ID (F-1, S-3, a test ID) with a small button that copies it.
 * text is what goes on the clipboard. It can say more than the label, for example "F-1/S-3".
 */
export function CopyId({ label, text = label, className = '' }: { label: string; text?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  // One timer at a time. A new click restarts it, and leaving the page stops it.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  const copy = async (e: MouseEvent) => {
    // The ID can be inside a link or a clickable row. Copy only, do not open it.
    e.preventDefault();
    e.stopPropagation();
    const ok = await copyText(text);
    // The ID can leave the page while the copy runs. Then do not show the mark or start the timer.
    if (!mounted.current) return;
    setState(ok ? 'done' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1200);
  };
  return (
    <span className={`inline-flex items-center gap-0.5 font-mono ${className}`}>
      {label}
      <button
        type="button"
        onClick={copy}
        title={state === 'done' ? 'Copied' : state === 'failed' ? 'Could not copy' : `Copy “${text}”`}
        aria-label={`Copy ${text}`}
        className="rounded px-0.5 text-ink-3 opacity-60 hover:bg-surface-2 hover:text-ink hover:opacity-100"
      >
        {state === 'done' ? (
          <span style={{ color: 'var(--good)' }}>✓</span>
        ) : state === 'failed' ? (
          <span style={{ color: 'var(--bad)' }}>✕</span>
        ) : (
          <svg aria-hidden width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="inline-block align-[-1px]">
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
            <path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
          </svg>
        )}
      </button>
      {/* Always on the page: screen readers read a change of text in a status area, not a new area. */}
      <span className="sr-only" role="status">{state === 'done' ? 'Copied' : state === 'failed' ? 'Could not copy' : ''}</span>
    </span>
  );
}
