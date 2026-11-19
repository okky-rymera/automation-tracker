import { useEffect, useState } from 'react';
import { mutate, reloadAll, useApi } from '../api';
import { href } from '../router';

/** Types of GET /api/projects/:id/sync (server/sync.ts and server/changes.ts). */
interface TestRef {
  id: string;
  framework: 'playwright' | 'cypress';
  file: string;
  title: string;
  links: number;
}
interface ChangeReport {
  from: string;
  to: string;
  commits: number;
  files: { status: string; path: string; oldPath?: string; kind: string }[];
  functions: { file: string; name: string; change: 'added' | 'changed' | 'removed' }[];
  tests: { added: TestRef[]; changed: TestRef[]; removed: TestRef[] };
  renames: { from: TestRef; to: TestRef; reason: 'same-code' | 'similar-title' }[];
  codeGone: { entryId: number; featureId: number; featureTitle: string; file: string; function: string; reason: string; movedTo?: string }[];
  review: { featureId: number; title: string; reasons: string[] }[];
  parseErrors: string[];
}
interface TestResult {
  ran: boolean;
  reason?: string;
  selected?: boolean;
  runDir?: string;
  total?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  minutes?: number;
}
interface SyncState {
  enabled: boolean;
  branch: string | null;
  siteUrl: string | null;
  syncedCommit: string | null;
  syncedAt: string | null;
  last: null | {
    id: number;
    status: 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled';
    step: string;
    startedAt: string;
    finishedAt: string | null;
    fromCommit: string | null;
    toCommit: string | null;
    report: ChangeReport | null;
    tests: TestResult | null;
    error: string | null;
    log: string;
  };
  progress: { total: number; done: number; failed: number; current: string } | null;
}

const STEP_TEXT: Record<string, string> = {
  check: 'Checking the copy',
  fetch: 'Getting new commits',
  packages: 'Installing test packages',
  scan: 'Reading files and tests',
  report: 'Writing the change report',
  tests: 'Running the Playwright tests',
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const short = (c: string | null) => c?.slice(0, 7) ?? '';

/**
 * Sync bar on the project page: when the tracker's copy last got the remote branch, a button to
 * sync now, the progress of a running sync, and the change report of the last sync.
 */
export function SyncPanel({ project }: { project: string }) {
  const [tick, setTick] = useState(0);
  const { data } = useApi<SyncState>(`/api/projects/${project}/sync?t=${tick}`);
  // Keep the last answer while the next poll loads, so the bar does not blink.
  const [s, setS] = useState<SyncState | null>(null);
  useEffect(() => {
    if (data) setS(data);
  }, [data]);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'auto' | 'always' | 'never'>('auto');
  const [error, setError] = useState<string | null>(null);
  const running = s?.last?.status === 'running';

  // Poll while a sync runs. When it ends, every view loads again (new files, tests and run).
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((n) => n + 1), 2000);
    return () => {
      clearInterval(t);
      reloadAll();
    };
  }, [running]);

  if (!s) return null;
  if (!s.enabled) {
    return (
      <div className="mt-2 text-xs text-ink-3">
        Sync is off for this project. To turn it on for the tracker's own copy of the plugin, run{' '}
        <code>npm run project -- set-sync {project} --branch trunk --site &lt;local site URL&gt;</code>.
      </div>
    );
  }

  const start = async () => {
    setError(null);
    try {
      await mutate('POST', `/api/projects/${project}/sync`, { tests: mode }, { quiet: true });
      setTick((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const cancel = async () => {
    try {
      await mutate('POST', `/api/projects/${project}/sync/cancel`, {}, { quiet: true });
      setTick((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const last = s.last;
  const r = last?.report;
  const p = s.progress;
  return (
    <div className="mt-2 rounded-md border border-line px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-ink-2">
          {s.syncedAt ? (
            <>
              Synced with <b>{s.branch}</b> on {when(s.syncedAt)} · commit <code>{short(s.syncedCommit)}</code>
            </>
          ) : (
            <>Not synced yet with {s.branch}.</>
          )}
        </span>
        {running ? (
          <>
            <span>
              {STEP_TEXT[last!.step] ?? last!.step}
              {last!.step === 'tests' && p && p.total > 0 && ` · ${p.done} of ${p.total} tests${p.failed ? `, ${p.failed} failed` : ''}`}…
            </span>
            {last!.step === 'tests' && p && p.total > 0 && (
              <div className="h-1.5 w-32 rounded-full bg-surface-2" role="progressbar" aria-valuenow={p.done} aria-valuemax={p.total}>
                <div className="h-full rounded-full bg-accent" style={{ width: `${(p.done / p.total) * 100}%` }} />
              </div>
            )}
            <button onClick={cancel} className="rounded-md border border-line px-2 py-0.5 hover:bg-surface-2">
              Cancel
            </button>
          </>
        ) : (
          <>
            <label className="inline-flex items-center gap-1 text-ink-3">
              Tests
              <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} className="rounded border border-line bg-bg px-1 py-0.5">
                <option value="auto">when code changed</option>
                <option value="always">always</option>
                <option value="never">never</option>
              </select>
            </label>
            <button onClick={start} className="rounded-md bg-accent px-2.5 py-0.5 font-medium text-white hover:opacity-90">
              Sync now
            </button>
          </>
        )}
        {last && !running && (
          <span className="text-ink-3">
            Last sync: <SyncStatus status={last.status} />
            {r && ` · ${r.commits} new commits · ${r.review.length} features to review`}
            {last.tests && ` · ${testText(last.tests)}`}
          </span>
        )}
        {last && (r || last.error) && (
          <button onClick={() => setOpen(!open)} className="ml-auto text-accent hover:underline">
            {open ? 'Hide report' : 'Show report'}
          </button>
        )}
      </div>
      {running && last?.step === 'tests' && (
        <div className="mt-1 text-ink-3">Keep the test site idle until the run ends: page loads outside a test count as test setup.{p?.current && ` Now: ${p.current}`}</div>
      )}
      {error && <div className="mt-1" style={{ color: 'var(--bad)' }}>{error}</div>}
      {open && last && <Report project={project} last={last} />}
    </div>
  );
}

function SyncStatus({ status }: { status: string }) {
  const color = status === 'done' ? 'var(--good)' : status === 'running' ? 'var(--text-2)' : 'var(--bad)';
  const text: Record<string, string> = { done: 'done', failed: 'failed', interrupted: 'stopped before the end', cancelled: 'cancelled', running: 'running' };
  return <span style={{ color }}>{text[status] ?? status}</span>;
}

function testText(t: TestResult): string {
  if (!t.ran) return `tests not run (${t.reason})`;
  const counts = t.total !== undefined ? `${t.passed} passed, ${t.failed} failed, ${t.skipped} skipped in ${t.minutes} min` : '';
  return t.selected ? `new coverage run: ${counts}` : `test run not used: ${t.reason}${counts ? ` (${counts})` : ''}`;
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <details className="mt-2" open={count > 0 && count <= 10}>
      <summary className="cursor-pointer font-medium">
        {title} ({count})
      </summary>
      <div className="mt-1 pl-4">{count ? children : <span className="text-ink-3">None.</span>}</div>
    </details>
  );
}

function TestLink({ project, t }: { project: string; t: TestRef }) {
  return (
    <a href={href({ project, tab: t.framework, sel: t.id })} className="hover:underline">
      <code className="text-ink-3">{t.id}</code> {t.title}
    </a>
  );
}

function Report({ project, last }: { project: string; last: NonNullable<SyncState['last']> }) {
  const r = last.report;
  const [moved, setMoved] = useState<Record<string, string>>({});
  const move = async (from: string, to: string) => {
    try {
      await mutate('POST', `/api/projects/${project}/links/move-test`, { from, to });
      setMoved((m) => ({ ...m, [from]: 'Links moved.' }));
    } catch (e) {
      setMoved((m) => ({ ...m, [from]: (e as Error).message }));
    }
  };
  const kinds = r ? r.files.reduce<Record<string, number>>((m, f) => ((m[f.kind] = (m[f.kind] ?? 0) + 1), m), {}) : {};
  const KIND: Record<string, string> = {
    php: 'PHP', js: 'JavaScript', playwright: 'Playwright specs', 'playwright-support': 'Playwright helpers and config',
    cypress: 'Cypress', 'other-test': 'other tests', other: 'other files',
  };
  return (
    <div className="mt-2 border-t border-line pt-2">
      <div className="text-ink-3">
        Sync {last.id}, started {when(last.startedAt)}
        {last.fromCommit && last.toCommit && (
          <>
            {' '}
            · <code>{short(last.fromCommit)}</code> → <code>{short(last.toCommit)}</code>
          </>
        )}
      </div>
      {last.error && <div className="mt-1 whitespace-pre-wrap" style={{ color: 'var(--bad)' }}>{last.error}</div>}
      {r && (
        <>
          <div className="mt-1">
            {r.files.length} files changed{r.files.length > 0 && `: ${Object.entries(kinds).map(([k, n]) => `${n} ${KIND[k] ?? k}`).join(', ')}`}.
          </div>
          <Section title="Features to review" count={r.review.length}>
            <ul className="space-y-1">
              {r.review.map((f) => (
                <li key={f.featureId}>
                  <a href={href({ project, tab: 'features', sel: `f:${f.featureId}` })} className="font-medium hover:underline">
                    F-{f.featureId} {f.title}
                  </a>
                  <ul className="list-disc pl-5 text-ink-2">
                    {f.reasons.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Likely renamed tests" count={r.renames.length}>
            <p className="mb-1 text-ink-3">A new title or file gives a test a new ID. Its links stay on the old ID. Move them to the new test if it is the same test.</p>
            <ul className="space-y-1.5">
              {r.renames.map((x) => (
                <li key={x.from.id}>
                  <div>
                    <span className="text-ink-3">Old:</span> <code className="text-ink-3">{x.from.id}</code> {x.from.title}
                  </div>
                  <div>
                    <span className="text-ink-3">New:</span> <TestLink project={project} t={x.to} />
                  </div>
                  <div className="text-ink-3">
                    {x.reason === 'same-code' ? 'Same test code.' : 'Same file, similar title.'} {x.from.links} links on the old test.{' '}
                    {moved[x.from.id] ? (
                      <span>{moved[x.from.id]}</span>
                    ) : (
                      x.from.links > 0 && (
                        <button onClick={() => move(x.from.id, x.to.id)} className="rounded border border-line px-1.5 hover:bg-surface-2">
                          Move links to the new test
                        </button>
                      )
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Feature code not in the code now" count={r.codeGone.length}>
            <ul className="space-y-0.5">
              {r.codeGone.map((g) => (
                <li key={g.entryId}>
                  <a href={href({ project, tab: 'features', sel: `f:${g.featureId}` })} className="hover:underline">
                    F-{g.featureId}
                  </a>{' '}
                  <code>{g.file}</code> {g.function || '(whole file)'}:{' '}
                  {g.reason === 'file-moved' ? `the file moved to ${g.movedTo}` : g.reason === 'file-gone' ? 'the file is gone' : 'the function is gone or renamed'}
                </li>
              ))}
            </ul>
          </Section>
          {(['added', 'changed', 'removed'] as const).map((k) => (
            <Section key={k} title={`Tests ${k}`} count={r.tests[k].length}>
              <ul className="space-y-0.5">
                {r.tests[k].map((t) => (
                  <li key={t.id}>
                    {k === 'removed' ? (
                      <>
                        <code className="text-ink-3">{t.id}</code> {t.title}
                      </>
                    ) : (
                      <TestLink project={project} t={t} />
                    )}
                    {t.links > 0 && <span className="text-ink-3"> · {t.links} links</span>}
                  </li>
                ))}
              </ul>
            </Section>
          ))}
          <Section title="PHP functions changed" count={r.functions.length}>
            <ul className="space-y-0.5">
              {r.functions.map((f) => (
                <li key={`${f.file} ${f.name}`}>
                  <span className="text-ink-3">{f.change}</span> <code>{f.file}</code> {f.name}
                </li>
              ))}
            </ul>
          </Section>
          {r.parseErrors.length > 0 && <div className="mt-2" style={{ color: 'var(--warn)' }}>Spec files that could not be read: {r.parseErrors.join(', ')}</div>}
        </>
      )}
      <details className="mt-2">
        <summary className="cursor-pointer text-ink-3">Log</summary>
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-surface-2 p-2">{last.log}</pre>
      </details>
    </div>
  );
}
