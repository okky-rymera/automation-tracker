import { useEffect, useMemo, useState } from 'react';
import { mutate, useApi } from '../api';
import './design.css';
import { useTracker, when, short, partialText, type Tracker, type SyncState } from './data';
import { go, link, useRoute, type Route } from './route';
import { Banner, IPrev, ISearch, Loading, ToastHost, useAct } from './ui';
import { Projects } from './screens/Projects';
import { Overview } from './screens/Overview';
import { FeatureList } from './screens/FeatureList';
import { FeaturePage } from './screens/Feature';
import { Changes } from './screens/Changes';
import { Tests } from './screens/Tests';
import { TestPage } from './screens/Test';
import { CodeList } from './screens/Code';
import { CodeFile } from './screens/CodeFile';
import { SyncPage } from './screens/Sync';
import { MapPage } from './screens/MapAi';
import { SettingsPage } from './screens/Settings';

export function App() {
  const route = useRoute();
  return (
    <ToastHost>
      <div className="app">{route.project ? <ProjectApp route={route} project={route.project} /> : <Projects />}</div>
    </ToastHost>
  );
}

function ProjectApp({ route, project }: { route: Route; project: string }) {
  const { t, error } = useTracker(project);
  const [pal, setPal] = useState(false);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName) || (e.target as HTMLElement)?.isContentEditable;
      if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        setPal(true);
      }
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, []);
  // A new screen starts at the top.
  useEffect(() => {
    if (!route.q.get('scope')) window.scrollTo(0, 0);
  }, [route.screen, route.id]);

  const back = route.q.get('back');
  return (
    <>
      <Header route={route} project={project} t={t} openPal={() => setPal(true)} />
      {back && (
        <div className="backbar">
          <button className="btn btn-ghost btn-sm" onClick={() => go(back)}><IPrev s={14} />{route.q.get('bl') ?? 'Back'}</button>
        </div>
      )}
      {!t ? <Loading error={error} /> : <Screen route={route} t={t} />}
      {pal && t && <Palette t={t} onClose={() => setPal(false)} />}
    </>
  );
}

function Screen({ route, t }: { route: Route; t: Tracker }) {
  switch (route.screen) {
    case 'flist': return <FeatureList t={t} />;
    case 'feature': return <FeaturePage t={t} route={route} />;
    case 'changes': return <Changes t={t} route={route} />;
    case 'tests': return <Tests t={t} route={route} />;
    case 'test': return <TestPage t={t} route={route} />;
    case 'code': return <CodeList t={t} route={route} />;
    case 'codefile': return <CodeFile t={t} route={route} />;
    case 'sync': return <SyncPage t={t} />;
    case 'map': return <MapPage t={t} />;
    case 'settings': return <SettingsPage />;
    default: return <Overview t={t} />;
  }
}

function Header({ route, project, t, openPal }: { route: Route; project: string; t: Tracker | null; openPal: () => void }) {
  const chg = t ? t.info.reduce((n, i) => n + i.nChanges, 0) : 0;
  const nav: [Route['screen'][], string, string, string][] = [
    [['overview'], 'Overview', '', link(project, 'overview')],
    [['flist', 'feature', 'map'], 'Features', t ? String(t.fd.features.length) : '', link(project, 'flist')],
    [['changes'], 'Changes', chg ? String(chg) : '', link(project, 'changes')],
    [['tests', 'test'], 'Tests', t ? String(t.tests.length) : '', link(project, 'tests')],
    [['code', 'codefile'], 'Code', '', link(project, 'code')],
    [['settings'], 'Settings', '', link(project, 'settings')],
  ];
  return (
    <header className="top">
      <a className="brand" href="#/" style={{ color: 'var(--ink)', textDecoration: 'none' }}>Automation Tracker</a>
      <span className="muted">{t?.summary.name ?? project}</span>
      <nav className="nav" aria-label="Main">
        {nav.map(([screens, label, badge, href]) => {
          const on = screens.includes(route.screen);
          return (
            <a key={label} href={href} className={`nav-item ${on ? 'nav-on' : ''}`} aria-current={on ? 'page' : undefined} style={{ textDecoration: 'none' }}>
              {label}
              {badge && <span className="badge">{badge}</span>}
            </a>
          );
        })}
      </nav>
      <button className="btn search-btn" onClick={openPal}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><ISearch s={15} />Search features, scopes, tests, IDs</span>
        <kbd>/</kbd>
      </button>
      {t && <SyncButton t={t} />}
    </header>
  );
}

const STEP_TEXT: Record<string, string> = {
  check: 'Checking the copy', fetch: 'Getting new commits', packages: 'Installing test packages', scan: 'Reading files and tests',
  report: 'Writing the change report', tests: 'Running the Playwright tests', cypress: 'Running the Cypress tests',
};
const STATUS_TEXT: Record<string, string> = { done: 'done', failed: 'failed', interrupted: 'stopped before the end', cancelled: 'cancelled', running: 'running' };

export function syncLine(s: SyncState): { dot: string; text: string } {
  const last = s.last;
  if (!s.enabled) return { dot: 'dot-off', text: 'Sync is off' };
  if (last?.status === 'running') {
    const p = s.progress;
    const counted = last.step === 'tests' || last.step === 'cypress';
    return { dot: 'dot-run', text: `${STEP_TEXT[last.step] ?? last.step}${counted && p?.total ? ` · ${p.done} of ${p.total}` : ''}…` };
  }
  if (last && last.status !== 'done') return { dot: 'dot-bad', text: `Last sync ${STATUS_TEXT[last.status] ?? last.status}` };
  if (!s.syncedAt) return { dot: 'dot-warn', text: `Not synced with ${s.branch}` };
  return { dot: 'dot-ok', text: `Synced with ${s.branch} · ` };
}

function SyncButton({ t }: { t: Tracker }) {
  const [open, setOpen] = useState(false);
  const s = t.sync;
  if (!s) return null;
  const l = syncLine(s);
  return (
    <>
      <button className="btn btn-sm sync" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`dot ${l.dot}`} aria-hidden="true" /> {l.text}
        {l.dot === 'dot-ok' && <span className="mono">{short(s.syncedCommit)}</span>}
      </button>
      {open && <SyncPop t={t} s={s} onClose={() => setOpen(false)} />}
    </>
  );
}

function SyncPop({ t, s, onClose }: { t: Tracker; s: SyncState; onClose: () => void }) {
  const [mode, setMode] = useState<'auto' | 'always' | 'never'>('auto');
  const act = useAct();
  const last = s.last;
  const running = last?.status === 'running';
  const chg = t.info.reduce((n, i) => n + i.nChanges, 0);
  const chgF = t.info.filter((i) => i.nChanges).length;
  const tests = last?.tests;
  const cyTests = last?.cypressTests;
  const result = (name: string, r: NonNullable<typeof tests>) => {
    if (!r.ran) return ` ${name}: not run (${r.reason}).`;
    const counts = r.total !== undefined ? `${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped` : '';
    const extra = partialText(r);
    return (r.selected ? ` ${name}: ${counts}.` : ` ${name}: run not used (${r.reason})${counts ? `, ${counts}` : ''}.`) + (extra ? ` ${extra}` : '');
  };
  const p = `/api/projects/${t.project}`;
  return (
    <div className="card pop" role="dialog" aria-label="Sync details">
      {!s.enabled ? (
        <>
          <div className="h2">Sync is off</div>
          <div className="muted" style={{ fontSize: 13 }}>
            To let the tracker follow a branch of the plugin, run <code className="mono">npm run project -- set-sync {t.project} --branch trunk</code>.
          </div>
        </>
      ) : (
        <>
          <div className="h2">{running ? 'Sync running' : s.syncedAt ? `Last sync: ${when(s.syncedAt)}` : 'Not synced yet'}</div>
          <div className="muted" style={{ fontSize: 13 }}>
            The tracker copy follows the {s.branch} branch{s.syncedCommit && <> at commit <span className="mono">{short(s.syncedCommit)}</span></>}.
            {last && !running && last.report && ` The last sync found ${last.report.commits} new commits.`}
            {tests && !running && result('Playwright', tests)}
            {cyTests && !running && result('Cypress', cyTests)}
          </div>
          {running && last && (
            <>
              <div style={{ fontSize: 13 }}>{syncLine(s).text}</div>
              {(last.step === 'tests' || last.step === 'cypress') && s.progress?.total ? (
                <div className="bar"><div className="fill c-good" style={{ width: `${(s.progress.done / s.progress.total) * 100}%`, background: 'var(--accent)' }} /></div>
              ) : null}
            </>
          )}
          {last && !running && last.status !== 'done' && last.error && <div className="err">{last.error.split('\n')[0]}</div>}
          <DailySyncLine project={t.project} />
          <div className="muted" style={{ fontSize: 13 }}>
            {chg ? `${chg} changes in ${chgF} features wait for you.` : 'No change waits for a review.'}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {chg > 0 && <button className="btn btn-primary btn-sm" onClick={() => (onClose(), go(link(t.project, 'changes')))}>Review the changes</button>}
            {running ? (
              <button className="btn btn-sm" onClick={() => act(() => mutate('POST', `${p}/sync/cancel`, {}), 'Sync cancelled')}>Cancel the sync</button>
            ) : (
              <>
                <label className="sr" htmlFor="syncmode">Tests</label>
                <select id="syncmode" className="input sel-sm" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} title="When to run the Playwright and Cypress tests">
                  <option value="auto">Tests: when code changed</option>
                  <option value="always">Tests: always</option>
                  <option value="never">Tests: never</option>
                </select>
                <button className={`btn btn-sm ${chg ? '' : 'btn-primary'}`} onClick={() => act(() => mutate('POST', `${p}/sync`, { tests: mode }), 'Sync started')}>Sync now</button>
              </>
            )}
          </div>
        </>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="linkbtn" onClick={() => (onClose(), go(link(t.project, 'sync')))}>Open the sync report and AI updates</button>
        <span style={{ flex: 1 }} />
        <button className="btn btn-sm" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

interface DailySync {
  on: boolean; hours: number; running: string | null; projects: { project: string; lastSyncAt: string | null; dueAt: string; due: boolean; waiting: string | null }[];
  ai: { on: boolean; units: number; maxUse: number; now: { project: string; step: 'review' | 'map'; startedAt: string } | null; waitingUntil: string | null; note: string | null };
}

/** "Daily sync: once each 24 hours, when it is due. Next: Nov 23, 8:49 AM." (server/daily-sync.ts) */
function DailySyncLine({ project }: { project: string }) {
  const { data: d } = useApi<DailySync>('/api/daily-sync');
  if (!d) return null;
  if (!d.on) return <div className="muted" style={{ fontSize: 13 }}>Daily sync: off. <a className="linkbtn" href={link(project, 'settings')}>Settings</a> turns it on.</div>;
  const mine = d.projects.find((x) => x.project === project);
  if (!mine) return null; // sync is off for this project: the panel says so above
  return (
    <div className="muted" style={{ fontSize: 13 }}>
      Daily sync: once each {d.hours} hours, when it is due, with the tests on "when code changed".
      {mine.due ? ' This project is due now.' : ` Next: ${when(mine.dueAt)}, or the first time the tracker runs after that.`}
      {mine.waiting && ` It waits: ${mine.waiting}`}
      {' '}
      {!d.ai.on
        ? 'The AI step after the sync is off (see Settings).'
        : d.ai.now
          ? `AI step now: ${d.ai.now.project}, ${d.ai.now.step === 'review' ? 'the AI update' : 'the mapping loop'} (since ${when(d.ai.now.startedAt)}).`
          : d.ai.waitingUntil
            ? `The AI step waits for the plan reset at ${when(d.ai.waitingUntil)} (it stops at ${d.ai.maxUse}% plan use).`
            : `After the sync, the AI step checks the changes and maps at most ${d.ai.units} units each day.`}
      {d.ai.note && ` Last AI note: ${d.ai.note}`}
    </div>
  );
}

/* ---------------- Search ---------------- */
function Palette({ t, onClose }: { t: Tracker; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const p = t.project;
  const secs = useMemo(() => {
    const pl = q.trim().toLowerCase();
    const idm = pl.match(/^(?:f-?(\d+))?\/?(?:s-?(\d+))?$/);
    const img = pl.match(/^(?:f-?\d+\/)?img-?(\d+)$/);
    const out: { title: string; items: { key: string; idLabel: string; title: string; sub: string; href: string }[] }[] = [];
    const fs = t.info
      .filter((i) => !pl || (idm?.[1] && !idm[2] && String(i.f.id) === idm[1]) || i.f.title.toLowerCase().includes(pl))
      .slice(0, 6)
      .map((i) => ({ key: `f${i.f.id}`, idLabel: `F-${i.f.id}`, title: i.f.title, sub: `${i.group} · ${i.f.scopes.length} scopes`, href: link(p, 'feature', i.f.id) }));
    if (fs.length) out.push({ title: 'Features', items: fs });
    if (pl) {
      const ss = t.info.flatMap((i) =>
        i.f.scopes
          .filter((s) => (idm?.[2] && String(s.id) === idm[2]) || s.title.toLowerCase().includes(pl) || s.requirements.some((r) => r.text.toLowerCase().includes(pl)))
          .map((s) => ({ key: `s${s.id}`, idLabel: `F-${i.f.id}/S-${s.id}`, title: s.title, sub: i.f.title, href: link(p, 'feature', i.f.id, { scope: s.id }) })),
      );
      if (ss.length) out.push({ title: 'Scopes', items: ss.slice(0, 8) });
      if (img) {
        const hits = t.info.flatMap((i) => i.f.screenshots.filter((x) => String(x.id) === img[1]).map((x) => ({ key: `x${x.id}`, idLabel: `F-${i.f.id}/IMG-${x.id}`, title: x.caption || 'Screenshot', sub: i.f.title, href: link(p, 'feature', i.f.id, { tab: 'shots' }) })));
        if (hits.length) out.push({ title: 'Screenshots', items: hits });
      }
      const ts = t.tests
        .filter((x) => x.id.toLowerCase().includes(pl) || x.title.toLowerCase().includes(pl) || x.file.toLowerCase().includes(pl))
        .slice(0, 6)
        .map((x) => {
          const l = t.linkedTo.get(x.id);
          return { key: x.id, idLabel: x.id, title: x.title, sub: `${l ? 'In ' + l.map((y) => `F-${y.fid}`).join(', ') : 'In no feature'} · ${x.file}`, href: link(p, 'test', x.id) };
        });
      if (ts.length) out.push({ title: 'Tests (read only)', items: ts });
    }
    return out;
  }, [q, t, p]);
  const flat = secs.flatMap((s) => s.items);
  const cur = Math.min(idx, Math.max(0, flat.length - 1));
  const open = (href: string) => (onClose(), go(href));
  return (
    <div className="overlay">
      <button className="backdrop" onClick={onClose} aria-label="Close search" />
      <div className="panel" role="dialog" aria-label="Search">
        <div style={{ padding: 10, borderBottom: '1px solid var(--line)' }}>
          <label className="sr" htmlFor="pq">Search</label>
          <input
            id="pq" className="input" style={{ border: 0, boxShadow: 'none', fontSize: 16 }} autoFocus value={q}
            placeholder="Type a title, or paste an ID like F-3/S-16 or PW-aceb4818"
            onChange={(e) => (setQ(e.target.value), setIdx(0))}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown') (e.preventDefault(), setIdx(Math.min(cur + 1, flat.length - 1)));
              else if (e.key === 'ArrowUp') (e.preventDefault(), setIdx(Math.max(cur - 1, 0)));
              else if (e.key === 'Enter' && flat[cur]) open(flat[cur].href);
            }}
          />
        </div>
        <div className="panel-body">
          {secs.map((s) => (
            <div key={s.title} style={{ padding: '4px 0' }}>
              <div className="h3" style={{ padding: '6px 10px' }}>{s.title}</div>
              {s.items.map((r) => (
                <button key={r.key} className={`res ${flat[cur] === r ? 'res-on' : ''}`} onClick={() => open(r.href)}>
                  <span className="mono faint" style={{ minWidth: 86 }}>{r.idLabel}</span>
                  <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block' }}>{r.title}</span><span className="faint" style={{ fontSize: 12 }}>{r.sub}</span></span>
                </button>
              ))}
            </div>
          ))}
          {!secs.length && <div className="faint" style={{ padding: 16 }}>No match. Try fewer words.</div>}
        </div>
        <div className="kbdrow" style={{ padding: '8px 12px', borderTop: '1px solid var(--line)' }}>
          <span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

export { Banner };
