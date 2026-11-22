import { useEffect, useState } from 'react';
import { mutate, reloadAll, useApi } from '../api';
import { href } from '../router';

interface MapRun {
  id: number;
  loop_id: number;
  unit_kind: 'playwright' | 'cypress' | 'code';
  unit_ref: string;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'done' | 'skipped' | 'failed' | 'stopped';
  cost_usd: number | null;
  duration_ms: number | null;
  features: number[];
  has_report: boolean;
  error: string | null;
}
interface MapLoop {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'done' | 'stopped' | 'failed';
  started_by: string;
  model: string;
  max_units: number;
  stop_reason: string | null;
}
interface MapLoopState {
  running: boolean;
  loops: MapLoop[];
  runs: MapRun[];
  totalUsd: number;
  count: number;
  defaults: { model: string; maxUnits: number };
  /** The highest unit limit. The server refuses a value above it. */
  limits: { maxUnits: number };
  log: string[];
  error: string | null;
}

const usd = (n: number | null) => (n === null ? '' : `$${n.toFixed(2)}`);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const KIND: Record<MapRun['unit_kind'], string> = { playwright: 'Playwright file', cypress: 'Cypress file', code: 'Code area' };
const STATUS: Record<MapRun['status'], [string, string]> = {
  running: ['running…', 'var(--accent)'],
  done: ['saved', 'var(--good)'],
  skipped: ['skipped (no feature)', 'var(--text-2)'],
  failed: ['failed', 'var(--bad)'],
  // A plan limit or a person stopped the unit. It was not saved, and it runs again at the next start.
  stopped: ['stopped (not saved)', 'var(--text-2)'],
};

/**
 * Mapping loop: headless Claude maps one unit after the other with the map-features skill
 * (server/map-loop.ts). What it saves shows as "New" or "Changed" in the feature list.
 */
export function MapLoopPanel({ project }: { project: string }) {
  const [tick, setTick] = useState(0);
  const { data } = useApi<MapLoopState>(`/api/projects/${project}/map-loop?t=${tick}`);
  const [s, setS] = useState<MapLoopState | null>(null);
  useEffect(() => {
    if (data) setS(data);
  }, [data]);
  const [form, setForm] = useState<{ model: string; maxUnits: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = !!s?.running;
  // While no loop runs, check every 30 s: a loop can start from the command line.
  useEffect(() => {
    if (running) return;
    const t = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, [running]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((n) => n + 1), 5000);
    return () => {
      clearInterval(t);
      reloadAll();
    };
  }, [running]);
  if (!s) return <div className="p-6 text-sm text-ink-3">Loading…</div>;
  const f = form ?? s.defaults;
  const set = (k: keyof typeof f, v: string) => setForm({ ...f, [k]: k === 'model' ? v : Number(v) });
  const call = async (path: string, body: unknown) => {
    setError(null);
    try {
      await mutate('POST', `/api/projects/${project}/map-loop${path}`, body, { quiet: true });
      setTick((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const loop = s.loops[0];
  const numInput = (k: 'maxUnits', label: string, step: string) => (
    <label className="inline-flex items-center gap-1 text-ink-3">
      {label}
      <input type="number" min="1" max={s.limits[k]} step={step} value={f[k]} onChange={(e) => set(k, e.target.value)} className="w-16 rounded border border-line bg-bg px-1 py-0.5 text-ink" />
    </label>
  );

  return (
    <div className="max-w-4xl space-y-4 p-6 text-sm">
      <div>
        <h2 className="text-lg font-semibold">Map features with AI</h2>
        <p className="mt-1 text-ink-2">
          Claude runs the map-features skill without you, one unit after the other: first the Playwright files, then the Cypress files, then the plugin code. For each
          unit it runs or tries the feature on the tracker's own test site, and saves the result as AI draft. The feature list then shows the features as “New” or
          “Changed”, so you review only those.
        </p>
        <p className="mt-1 text-ink-3">
          It uses your Claude plan (claude.ai login), not an API key. It stops when no unit is left, at the unit limit, when a unit fails two times, or when you
          click Stop. When the 5-hour or weekly limit of the plan is reached, or the run starts to use paid extra usage, it stops the unit at once and ends the
          loop. That unit is not saved: it runs again at the next start. When a unit takes more than 60 minutes, the loop stops it, and the unit counts as failed.
          The cost is a list-price estimate of the plan use, not a bill. A sync and an AI update wait while the loop runs.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-md border border-line p-3">
        {running ? (
          <>
            <span>
              Mapping… {loop && `(${s.runs.filter((r) => r.loop_id === loop.id && r.status !== 'running').length} of at most ${loop.max_units} units done)`}
            </span>
            <button onClick={() => call('/stop', {})} className="rounded-md border border-line px-2 py-0.5 hover:bg-surface-2">
              Stop
            </button>
          </>
        ) : (
          <>
            <label className="inline-flex items-center gap-1 text-ink-3">
              Model
              <select value={f.model} onChange={(e) => set('model', e.target.value)} className="rounded border border-line bg-bg px-1 py-0.5 text-ink">
                <option value="opus">Opus (more detail)</option>
                <option value="sonnet">Sonnet (uses less of the plan)</option>
              </select>
            </label>
            {numInput('maxUnits', 'Units', '1')}
            <button onClick={() => call('', f)} className="rounded-md bg-accent px-2.5 py-0.5 font-medium text-white hover:opacity-90">
              Start mapping
            </button>
          </>
        )}
        <span className="ml-auto text-ink-3">
          {s.count} unit{s.count === 1 ? "" : "s"} so far · {usd(s.totalUsd)} in total
        </span>
      </div>
      {(error ?? s.error) && <div style={{ color: 'var(--bad)' }}>{error ?? s.error}</div>}
      {loop && !running && (
        <div className="text-ink-3">
          Last loop ({when(loop.started_at)}, {loop.model}): {loop.stop_reason ?? loop.status}
        </div>
      )}
      {running && s.log.length > 0 && (
        <pre className="max-h-40 overflow-auto rounded-md bg-surface-2 p-2 text-xs text-ink-2">{s.log.slice(-15).join('\n')}</pre>
      )}

      <ul className="space-y-2">
        {s.runs.map((r) => {
          const [text, color] = STATUS[r.status];
          return (
            <li key={r.id} className="rounded-md border border-line p-2">
              <div>
                <span className="text-ink-3">{KIND[r.unit_kind]}</span> <span className="font-medium">{r.unit_ref}</span> <span style={{ color }}>{text}</span>
                <span className="text-ink-3">
                  {' '}
                  · {when(r.started_at)}
                  {r.cost_usd !== null && ` · ${usd(r.cost_usd)}`}
                  {r.duration_ms !== null && ` · ${Math.round(r.duration_ms / 60000)} min`}
                </span>
                {r.features.length > 0 && (
                  <span>
                    {' '}
                    ·{' '}
                    {r.features.map((id, i) => (
                      <span key={id}>
                        {i > 0 && ', '}
                        <a href={href({ project, tab: 'features', sel: `f:${id}` })} className="text-accent hover:underline">
                          F-{id}
                        </a>
                      </span>
                    ))}
                  </span>
                )}
              </div>
              {r.error && <div style={{ color: 'var(--bad)' }}>{r.error}</div>}
              {r.has_report && <RunReport project={project} runId={r.id} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The report of one unit. It loads when you open it: the unit list does not carry the report text. */
function RunReport({ project, runId }: { project: string; runId: number }) {
  const [open, setOpen] = useState(false);
  const { data, error } = useApi<{ report: string }>(open ? `/api/projects/${project}/map-loop/runs/${runId}/report` : null);
  return (
    <details onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer text-ink-3">Report of the run</summary>
      {open && (error ? <div style={{ color: 'var(--bad)' }}>{error}</div> : <div className="mt-1 whitespace-pre-wrap text-ink-2">{data ? data.report : 'Loading…'}</div>)}
    </details>
  );
}
