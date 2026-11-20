import { useEffect, useState, type ReactNode } from 'react';
import { mutate, reloadAll, useApi } from '../../api';
import { short, when, type TestRef, type TestResult, type Tracker } from '../data';
import { link } from '../route';
import { useAct } from '../ui';
import { syncLine } from '../Shell';

interface AiUpdateRow {
  id: number; featureId: number; syncId: number | null; fromCommit: string; toCommit: string; model: string; startedAt: string; finishedAt: string | null;
  status: 'waiting' | 'running' | 'no-change' | 'applied' | 'proposed' | 'failed'; costUsd: number | null; durationMs: number | null; summary: string; applyReport: string[] | null; error: string | null;
}
interface AiState { running: boolean; rows: AiUpdateRow[]; totalUsd: number; count: number; defaults: { model: string; budgetUsd: number }; error: string | null }
const AI_STATUS: Record<AiUpdateRow['status'], [string, string]> = {
  waiting: ['Waiting', 'tag-ro'], running: ['Checking…', 'tag-new'], 'no-change': ['No change needed', 'tag-ok'], applied: ['Saved as AI draft', 'tag-ok'],
  proposed: ['Proposal only, not saved', 'tag-skip'], failed: ['Failed', 'tag-fail'],
};
const usd = (n: number | null) => (n === null ? '' : `$${n.toFixed(2)}`);
const STATUS: Record<string, [string, string]> = { done: ['Done', 'tag-ok'], failed: ['Failed', 'tag-fail'], interrupted: ['Stopped before the end', 'tag-fail'], cancelled: ['Cancelled', 'tag-skip'], running: ['Running', 'tag-new'] };
const FILE_KIND: Record<string, string> = {
  php: 'PHP', js: 'JavaScript', playwright: 'Playwright specs', 'playwright-support': 'Playwright helpers and config', cypress: 'Cypress', 'other-test': 'other tests', other: 'other files',
};

export function testText(r: TestResult): string {
  if (!r.ran) return `The tests did not run: ${r.reason}.`;
  const counts = r.total !== undefined ? `${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped in ${r.minutes} min` : '';
  return r.selected ? `New coverage run: ${counts}.` : `The test run is not used: ${r.reason}${counts ? ` (${counts})` : ''}.`;
}

function Sec({ title, count, children, sub }: { title: string; count: number; children: ReactNode; sub?: ReactNode }) {
  return (
    <section className="card">
      <div className="sec-head"><h2 className="h2">{title} <span className="faint" style={{ fontWeight: 400 }}>{count}</span></h2>{sub && <span className="faint" style={{ fontSize: 12 }}>{sub}</span>}</div>
      <div style={{ padding: '12px 16px', fontSize: 13 }}>{count ? children : <span className="faint">None.</span>}</div>
    </section>
  );
}

/** Sync with the remote branch: start, follow, and read the change report of the last sync. Also the AI updates. */
export function SyncPage({ t }: { t: Tracker }) {
  const act = useAct();
  const s = t.sync;
  const p = t.project;
  const [mode, setMode] = useState<'auto' | 'always' | 'never'>('auto');
  const [moved, setMoved] = useState<Record<string, string>>({});
  if (!s) return <main className="page"><div className="muted">Loading…</div></main>;
  const last = s.last;
  const r = last?.report;
  const running = last?.status === 'running';
  const testLink = (x: TestRef) => (
    <a className="linkbtn" href={link(p, 'test', x.id)}><span className="mono faint">{x.id}</span> {x.title}</a>
  );
  const kinds = r ? r.files.reduce<Record<string, number>>((m, f) => ((m[f.kind] = (m[f.kind] ?? 0) + 1), m), {}) : {};
  return (
    <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1100 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h1 className="h1">Sync</h1>
        <p className="muted" style={{ margin: 0 }}>The tracker keeps its own copy of the plugin. A sync gets the new commits of the branch, reads the files and tests again, and can run the Playwright tests for new coverage.</p>
      </div>
      <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {!s.enabled ? (
          <div className="muted" style={{ fontSize: 13 }}>Sync is off for this project. To turn it on, run <code className="mono">npm run project -- set-sync {p} --branch trunk</code>.</div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span className={`dot ${syncLine(s).dot}`} aria-hidden="true" />
              <span style={{ fontWeight: 600 }}>{s.syncedAt ? <>Synced with {s.branch} on {when(s.syncedAt)} · <span className="mono">{short(s.syncedCommit)}</span></> : `Not synced yet with ${s.branch}`}</span>
              <span style={{ flex: 1 }} />
              {running ? (
                <button className="btn btn-sm" onClick={() => act(() => mutate('POST', `/api/projects/${p}/sync/cancel`, {}), 'Sync cancelled')}>Cancel the sync</button>
              ) : (
                <>
                  <select className="input sel-sm" aria-label="When to run the tests" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                    <option value="auto">Tests: when code changed</option><option value="always">Tests: always</option><option value="never">Tests: never</option>
                  </select>
                  <button className="btn btn-primary btn-sm" onClick={() => act(() => mutate('POST', `/api/projects/${p}/sync`, { tests: mode }), 'Sync started')}>Sync now</button>
                </>
              )}
            </div>
            {running && last && (
              <>
                <div style={{ fontSize: 13 }}>{syncLine(s).text}</div>
                {last.step === 'tests' && s.progress?.total ? (
                  <>
                    <div className="bar" role="progressbar" aria-valuenow={s.progress.done} aria-valuemax={s.progress.total}>
                      <div className="fill" style={{ width: `${(s.progress.done / s.progress.total) * 100}%`, background: 'var(--accent)' }} />
                    </div>
                    <div className="faint" style={{ fontSize: 12 }}>The tests run on the tracker's own test site. Coverage records only the requests to this site.{s.progress.current && ` Now: ${s.progress.current}`}</div>
                  </>
                ) : null}
              </>
            )}
          </>
        )}
        {last && (
          <div className="kv">
            <span>Sync {last.id}: <span className={`tag ${STATUS[last.status]?.[1] ?? 'tag-ro'}`}>{STATUS[last.status]?.[0] ?? last.status}</span></span>
            <span>Started {when(last.startedAt)}</span>
            {last.fromCommit && last.toCommit && <span className="mono">{short(last.fromCommit)} → {short(last.toCommit)}</span>}
            {r && <span>{r.commits} new commits · {r.files.length} files changed{r.files.length > 0 && ` (${Object.entries(kinds).map(([k, n]) => `${n} ${FILE_KIND[k] ?? k}`).join(', ')})`}</span>}
            {last.tests && <span>{testText(last.tests)}</span>}
          </div>
        )}
        {last?.error && <pre className="log" style={{ color: 'var(--bad)' }}>{last.error}</pre>}
      </div>

      {r && (
        <>
          <Sec title="Features to review" count={r.review.length} sub="Their linked tests or their code changed.">
            <ul className="plain">
              {r.review.map((f) => (
                <li key={f.featureId}>
                  <a className="linkbtn" href={link(p, 'feature', f.featureId)}><span className="mono faint">F-{f.featureId}</span> {f.title}</a>
                  <ul className="plain faint">{f.reasons.map((x) => <li key={x}>{x}</li>)}</ul>
                </li>
              ))}
            </ul>
          </Sec>
          <AiUpdates t={t} canStart={!running && r.review.length > 0} />
          <Sec title="Likely renamed tests" count={r.renames.length} sub="A new title or file gives a test a new ID. Its links stay on the old ID.">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {r.renames.map((x) => (
                <div key={x.from.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div><span className="faint">Old:</span> <span className="mono faint">{x.from.id}</span> {x.from.title}</div>
                  <div><span className="faint">New:</span> {testLink(x.to)}</div>
                  <div className="faint" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    {x.reason === 'same-code' ? 'Same test code.' : 'Same file, similar title.'} {x.from.links} links on the old test.
                    {moved[x.from.id] ? <span>{moved[x.from.id]}</span> : x.from.links > 0 && (
                      <button className="btn btn-sm" onClick={() => mutate('POST', `/api/projects/${p}/links/move-test`, { from: x.from.id, to: x.to.id }).then(() => setMoved((m) => ({ ...m, [x.from.id]: 'Links moved.' })), (e) => setMoved((m) => ({ ...m, [x.from.id]: e.message })))}>Move the links to the new test</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Sec>
          <Sec title="Feature code not in the code now" count={r.codeGone.length}>
            <ul className="plain">
              {r.codeGone.map((g) => (
                <li key={g.entryId}>
                  <a className="linkbtn mono" href={link(p, 'feature', g.featureId, { tab: 'code' })}>F-{g.featureId}</a> <span className="mono">{g.file}</span> {g.function || '(whole file)'}:{' '}
                  {g.reason === 'file-moved' ? `the file moved to ${g.movedTo}` : g.reason === 'file-gone' ? 'the file is gone' : 'the function is gone or renamed'}
                </li>
              ))}
            </ul>
          </Sec>
          {(['added', 'changed', 'removed'] as const).map((k) => (
            <Sec key={k} title={`Tests ${k}`} count={r.tests[k].length}>
              <ul className="plain">
                {r.tests[k].map((x) => (
                  <li key={x.id}>{k === 'removed' ? <><span className="mono faint">{x.id}</span> {x.title}</> : testLink(x)}{x.links > 0 && <span className="faint"> · {x.links} links</span>}</li>
                ))}
              </ul>
            </Sec>
          ))}
          <Sec title="PHP functions changed" count={r.functions.length}>
            <ul className="plain">
              {r.functions.map((f) => (
                <li key={`${f.file} ${f.name}`}><span className="faint">{f.change}</span> <a className="linkbtn mono" href={link(p, 'codefile', null, { path: f.file })}>{f.file}</a> {f.name}</li>
              ))}
            </ul>
          </Sec>
          {r.parseErrors.length > 0 && <div className="banner banner-warn">Spec files that could not be read: {r.parseErrors.join(', ')}</div>}
        </>
      )}
      {last && (
        <section className="card">
          <div className="sec-head"><h2 className="h2">Log</h2><span className="faint" style={{ fontSize: 12 }}>The end of the log of sync {last.id}</span></div>
          <div style={{ padding: 12 }}><pre className="log">{last.log || 'Empty.'}</pre></div>
        </section>
      )}
    </main>
  );
}

/** AI update: headless Claude checks each feature to review and saves its changes as AI draft. */
function AiUpdates({ t, canStart }: { t: Tracker; canStart: boolean }) {
  const p = t.project;
  const act = useAct();
  const [tick, setTick] = useState(0);
  const { data } = useApi<AiState>(`/api/projects/${p}/ai-updates?t=${tick}`);
  const [s, setS] = useState<AiState | null>(null);
  const [model, setModel] = useState<string | null>(null);
  useEffect(() => {
    if (data) setS(data);
  }, [data]);
  const running = !!s?.running;
  useEffect(() => {
    if (!running) return;
    const i = setInterval(() => setTick((n) => n + 1), 3000);
    return () => (clearInterval(i), reloadAll());
  }, [running]);
  if (!s) return null;
  return (
    <section className="card">
      <div className="sec-head">
        <h2 className="h2" style={{ flex: 1 }}>AI updates <span className="faint" style={{ fontWeight: 400 }}>{s.count}{s.count > 0 && ` · ${usd(s.totalUsd)} in total`}</span></h2>
        {running ? (
          <span className="muted" style={{ fontSize: 13 }}>Checking features…</span>
        ) : (
          <>
            <select className="input sel-sm" aria-label="Model" value={model ?? s.defaults.model} onChange={(e) => setModel(e.target.value)}>
              <option value="sonnet">Sonnet (uses less of the plan)</option><option value="opus">Opus (more detail)</option>
            </select>
            <button
              className="btn btn-sm" disabled={!canStart} title={canStart ? `At most ${usd(s.defaults.budgetUsd)} for each feature` : 'The last sync has no features to review'}
              onClick={() => act(async () => (await mutate('POST', `/api/projects/${p}/ai-update`, { model: model ?? s.defaults.model }, { quiet: true }), setTick((n) => n + 1)), 'AI update started')}
            >Check the features to review with AI</button>
          </>
        )}
      </div>
      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
        <span className="faint">Claude reads the changed code and checks each feature to review. It saves its changes as AI draft, and they show on the Changes page. It never changes text that a person wrote or checked: then it adds a question.</span>
        {s.error && <div className="err">{s.error}</div>}
        {s.rows.map((u) => (
          <div key={u.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <a className="linkbtn mono" href={link(p, 'feature', u.featureId)}>F-{u.featureId}</a>
              <span className={`tag ${AI_STATUS[u.status]?.[1] ?? 'tag-ro'}`}>{AI_STATUS[u.status]?.[0] ?? u.status}</span>
              <span className="faint">{u.model} · {usd(u.costUsd)}{u.durationMs !== null && ` · ${Math.round(u.durationMs / 1000)} s`} · {when(u.startedAt)} · <span className="mono">{short(u.fromCommit)} → {short(u.toCommit)}</span></span>
            </div>
            {u.summary && <div className="muted">{u.summary}</div>}
            {u.error && <div className="err">{u.error}</div>}
            {u.applyReport && u.applyReport.length > 0 && (
              <details><summary className="faint" style={{ cursor: 'pointer' }}>What was saved and kept ({u.applyReport.length})</summary><ul className="plain muted">{u.applyReport.map((x, k) => <li key={k}>{x}</li>)}</ul></details>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
