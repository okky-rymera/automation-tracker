import { useEffect, useState } from 'react';
import { mutate, reloadAll, useApi } from '../../api';
import { when, type Tracker } from '../data';
import { link } from '../route';
import { useAct } from '../ui';

interface MapRun {
  id: number; loop_id: number; unit_kind: 'playwright' | 'cypress' | 'code'; unit_ref: string; started_at: string; finished_at: string | null;
  status: 'running' | 'done' | 'skipped' | 'failed' | 'stopped'; cost_usd: number | null; duration_ms: number | null; features: number[]; report: string; error: string | null;
}
interface MapLoop { id: number; started_at: string; finished_at: string | null; status: 'running' | 'done' | 'stopped' | 'failed'; started_by: string; model: string; max_units: number; stop_reason: string | null }
interface MapLoopState {
  running: boolean; loops: MapLoop[]; runs: MapRun[]; totalUsd: number; count: number; defaults: { model: string; maxUnits: number }; limits: { maxUnits: number }; log: string[]; error: string | null;
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
  const [s, setS] = useState<MapLoopState | null>(null);
  const [form, setForm] = useState<{ model: string; maxUnits: number } | null>(null);
  useEffect(() => {
    if (data) setS(data);
  }, [data]);
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
          It uses your Claude plan (claude.ai login), not an API key. It stops when no unit is left, at the unit limit, when a unit fails two times, or when you click Stop.
          When the 5-hour or weekly limit of the plan is reached, or the run starts to use paid extra usage, it stops the unit at once and ends the loop. That unit is not saved:
          it runs again at the next start. A unit that takes more than 60 minutes is stopped and counts as failed. The cost is a list-price estimate of the plan use, not a bill.
          A sync and an AI update wait while the loop runs.
        </p>
      </div>
      <div className="card" style={{ padding: 16, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        {running ? (
          <>
            <span className="dot dot-run" aria-hidden="true" />
            <span>Mapping… {loop && `${s.runs.filter((r) => r.loop_id === loop.id && r.status !== 'running').length} of at most ${loop.max_units} units done`}</span>
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
      <section className="card">
        <div className="sec-head"><h2 className="h2">Units <span className="faint" style={{ fontWeight: 400 }}>{s.runs.length}</span></h2></div>
        <div>
          {s.runs.map((r) => (
            <div key={r.id} className="draft" style={{ flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
                <span className={`tag ${STATUS[r.status][1]}`}>{STATUS[r.status][0]}</span>
                <span className="faint">{KIND[r.unit_kind]}</span>
                <span className="mono" style={{ overflowWrap: 'anywhere' }}>{r.unit_ref}</span>
                <span className="faint">· {when(r.started_at)}{r.cost_usd !== null && ` · ${usd(r.cost_usd)}`}{r.duration_ms !== null && ` · ${Math.round(r.duration_ms / 60000)} min`}</span>
                {r.features.map((id) => <a key={id} className="linkbtn mono" href={link(p, 'feature', id)}>F-{id}</a>)}
              </div>
              {r.error && <div className="err">{r.error}</div>}
              {r.report && <details><summary className="faint" style={{ cursor: 'pointer', fontSize: 13 }}>Report of the run</summary><div className="muted" style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{r.report}</div></details>}
            </div>
          ))}
          {!s.runs.length && <div className="lc-empty" style={{ borderBottom: 0 }}>No unit yet.</div>}
        </div>
      </section>
    </main>
  );
}
