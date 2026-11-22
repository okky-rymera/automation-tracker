import { useEffect, useRef, useState } from 'react';
import { getJson, mutate, reloadAll, useApi } from '../../api';
import { when, type Tracker } from '../data';
import { link } from '../route';
import { useAct } from '../ui';
import { ParkedUnits } from './ParkedUnits';

interface MapRun {
  id: number; loop_id: number; unit_kind: 'playwright' | 'cypress' | 'code'; unit_ref: string; started_at: string; finished_at: string | null;
  status: 'running' | 'done' | 'skipped' | 'failed' | 'stopped'; cost_usd: number | null; duration_ms: number | null; features: number[]; has_report: boolean; error: string | null;
}
interface MapLoop { id: number; started_at: string; finished_at: string | null; status: 'running' | 'done' | 'stopped' | 'failed'; started_by: string; model: string; max_units: number; stop_reason: string | null }
interface MapLoopState {
  running: boolean; loops: MapLoop[]; loopDone: number; runs: MapRun[]; totalUsd: number; count: number; pageSize: number; defaults: { model: string; maxUnits: number }; limits: { maxUnits: number }; log: string[]; error: string | null;
}
const usd = (n: number | null) => (n === null ? '' : `$${n.toFixed(2)}`);
const KIND: Record<MapRun['unit_kind'], string> = { playwright: 'Playwright file', cypress: 'Cypress file', code: 'Code area' };
const STATUS: Record<MapRun['status'], [string, string]> = {
  running: ['Running…', 'tag-new'], done: ['Saved', 'tag-ok'], skipped: ['Skipped (no feature)', 'tag-ro'], failed: ['Failed', 'tag-fail'], stopped: ['Stopped (not saved)', 'tag-skip'],
};

/**
 * Map features with AI: headless Claude maps one unit after the other with the map-features skill
 * (server/map-loop.ts). What it saves shows on the Changes page.
 */
export function MapPage({ t }: { t: Tracker }) {
  const p = t.project;
  const act = useAct();
  const [tick, setTick] = useState(0);
  const { data } = useApi<MapLoopState>(`/api/projects/${p}/map-loop?t=${tick}`);
  // The state has only the newest page of units. "Show older units" adds a page here, one time.
  const [older, setOlder] = useState<MapRun[]>([]);
  const [olderState, setOlderState] = useState<'idle' | 'loading' | 'end'>('idle');
  const project = useRef(p);
  const [s, setS] = useState<MapLoopState | null>(null);
  // The newest state, for "Show older units": its reply can come after one or more refreshes.
  const latest = useRef<MapLoopState | null>(null);
  latest.current = s;
  useEffect(() => {
    project.current = p;
    // Forget the last project's units. Else "Show older units" can add them to this project's list.
    setS(null);
    setOlder([]);
    setOlderState('idle');
  }, [p]);
  const [form, setForm] = useState<{ model: string; maxUnits: number } | null>(null);
  useEffect(() => {
    if (data) setS(data);
    // Keep the kept copy of a unit up to date while it is still in the newest page.
    if (data) setOlder((o) => (o.length ? merge(data.runs, o) : o));
  }, [data]);
  // New units can make older units come back after an empty "older" page.
  const count = s?.count;
  useEffect(() => setOlderState((o) => (o === 'end' ? 'idle' : o)), [count]);
  const running = !!s?.running;
  // While no loop runs, check every 30 s: a loop can start from the command line.
  useEffect(() => {
    const i = setInterval(() => setTick((n) => n + 1), running ? 5000 : 30000);
    return () => {
      clearInterval(i);
      if (running) reloadAll();
    };
  }, [running]);
  if (!s) return <main className="page"><div className="muted">Loading…</div></main>;
  const f = form ?? s.defaults;
  const loop = s.loops[0];
  // Newest first. The newest page comes from each refresh, the older units from "Show older units".
  const runs = older.length ? merge(s.runs, older) : s.runs;
  const hidden = Math.max(0, s.count - runs.length);
  const showOlder = () =>
    act(async () => {
      const before = runs[runs.length - 1]?.id;
      if (!before) return;
      setOlderState('loading');
      try {
        const out = (await getJson(`/api/projects/${p}/map-loop/runs?before=${before}`)) as { runs: MapRun[] };
        if (project.current !== p) return; // The user opened another project meanwhile.
        const page = out.runs;
        // Keep the newest page too: when new units start, it moves up, and the units under it must stay.
        // Use the newest refresh, not the one of the click: a refresh during the request has newer copies.
        setOlder((o) => merge(merge(latest.current?.runs ?? [], o), page));
        setOlderState(page.length ? 'idle' : 'end');
      } catch (e) {
        if (project.current === p) setOlderState('idle');
        throw e;
      }
    });
  const call = (path: string, body: unknown, msg: string) => act(async () => (await mutate('POST', `/api/projects/${p}/map-loop${path}`, body, { quiet: true }), setTick((n) => n + 1)), msg);
  return (
    <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1100 }}>
      <nav className="crumbs" aria-label="Breadcrumb"><a className="linkbtn" href={link(p, 'flist')}>Features</a><span className="faint" aria-hidden="true">/</span><span className="faint">Map with AI</span></nav>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h1 className="h1">Map features with AI</h1>
        <p className="muted" style={{ margin: 0, maxWidth: '80ch' }}>
          Claude runs the map-features skill without you, one unit after the other: first the Playwright files, then the Cypress files, then the plugin code. For each unit
          it runs or tries the feature on the tracker's own test site, and saves the result as AI draft. The changes then wait for you on the Changes page.
        </p>
        <p className="faint" style={{ margin: 0, fontSize: 13, maxWidth: '80ch' }}>
          It uses your Claude plan (claude.ai login), not an API key. It stops when no unit is left, at the unit limit, or when you click Stop. A unit that fails two times is parked until its files change, and the loop goes on.
          When the 5-hour or weekly limit of the plan is reached, or the run starts to use paid extra usage, it stops the unit at once and ends the loop. That unit is not saved:
          it runs again at the next start. A unit that takes more than 60 minutes is stopped and counts as failed. The cost is a list-price estimate of the plan use, not a bill.
          A sync and an AI update wait while the loop runs.
        </p>
      </div>
      <div className="card" style={{ padding: 16, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        {running ? (
          <>
            <span className="dot dot-run" aria-hidden="true" />
            <span>Mapping… {loop && `${s.loopDone} of at most ${loop.max_units} units done`}</span>
            <button className="btn btn-sm" onClick={() => call('/stop', {}, 'Stopping after this step')}>Stop</button>
          </>
        ) : (
          <>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
              <span className="faint">Model</span>
              <select className="input sel-sm" value={f.model} onChange={(e) => setForm({ ...f, model: e.target.value })}>
                <option value="opus">Opus (more detail)</option><option value="sonnet">Sonnet (uses less of the plan)</option>
              </select>
            </label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
              <span className="faint">Units</span>
              <input className="input sel-sm" style={{ width: 72 }} type="number" min={1} max={s.limits.maxUnits} value={f.maxUnits} onChange={(e) => setForm({ ...f, maxUnits: Number(e.target.value) })} />
            </label>
            <button className="btn btn-primary btn-sm" onClick={() => call('', f, 'Mapping started')}>Start mapping</button>
          </>
        )}
        <span style={{ flex: 1 }} />
        <span className="faint" style={{ fontSize: 13 }}>{s.count} {s.count === 1 ? 'unit' : 'units'} so far · {usd(s.totalUsd)} in total</span>
      </div>
      {s.error && <div className="err">{s.error}</div>}
      {loop && !running && <div className="faint" style={{ fontSize: 13 }}>Last loop ({when(loop.started_at)}, {loop.model}): {loop.stop_reason ?? loop.status}</div>}
      {running && s.log.length > 0 && <pre className="log">{s.log.slice(-15).join('\n')}</pre>}
      <ParkedUnits project={p} tick={tick} />
      <section className="card">
        <div className="sec-head"><h2 className="h2">Units <span className="faint" style={{ fontWeight: 400 }}>{hidden ? `newest ${runs.length} of ${s.count}` : runs.length}</span></h2></div>
        <div>
          {runs.map((r) => (
            <div key={r.id} className="draft" style={{ flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
                <span className={`tag ${STATUS[r.status][1]}`}>{STATUS[r.status][0]}</span>
                <span className="faint">{KIND[r.unit_kind]}</span>
                <span className="mono" style={{ overflowWrap: 'anywhere' }}>{r.unit_ref}</span>
                <span className="faint">· {when(r.started_at)}{r.cost_usd !== null && ` · ${usd(r.cost_usd)}`}{r.duration_ms !== null && ` · ${Math.round(r.duration_ms / 60000)} min`}</span>
                {r.features.map((id) => <a key={id} className="linkbtn mono" href={link(p, 'feature', id)}>F-{id}</a>)}
              </div>
              {r.error && <div className="err">{r.error}</div>}
              {r.has_report && <RunReport project={p} runId={r.id} />}
            </div>
          ))}
          {!runs.length && <div className="lc-empty" style={{ borderBottom: 0 }}>No unit yet.</div>}
          {hidden > 0 && (
            <div style={{ padding: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
              {olderState !== 'end' && <button className="btn btn-sm" disabled={olderState === 'loading'} onClick={showOlder}>
                {olderState === 'loading' ? 'Loading…' : `Show ${Math.min(s.pageSize, hidden)} older units`}
              </button>}
              <span className="faint" style={{ fontSize: 13 }}>{hidden} older {hidden === 1 ? 'unit is' : 'units are'} not shown</span>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

/** The units of both lists, one time each, newest first. A unit in `a` wins over the same unit in `b`. */
function merge(a: MapRun[], b: MapRun[]): MapRun[] {
  const ids = new Set(a.map((r) => r.id));
  return [...a, ...b.filter((r) => !ids.has(r.id))].sort((x, y) => y.id - x.id);
}

/** The report of one unit. It loads when you open it: the unit list does not carry the report text. */
function RunReport({ project, runId }: { project: string; runId: number }) {
  const [open, setOpen] = useState(false);
  const { data, error } = useApi<{ report: string }>(open ? `/api/projects/${project}/map-loop/runs/${runId}/report` : null);
  return (
    <details onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="faint" style={{ cursor: 'pointer', fontSize: 13 }}>Report of the run</summary>
      {open && (error ? <div className="err">{error}</div> : <div className="muted" style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{data ? data.report : 'Loading…'}</div>)}
    </details>
  );
}
