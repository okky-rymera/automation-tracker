import { useEffect, useState } from 'react';
import { useApi } from '../../api';
import type { Tracker } from '../data';
import { go, link, type Route } from '../route';
import { IdBtn, INext, IPlus, IPrev, Seg, copyText, useSay } from '../ui';
import { LinkToScope, TestLinks, testOrder, testTag } from './Tests';

interface TestSource { id: string; framework: 'playwright' | 'cypress'; file: string; repoPath: string; source: string; start: number; end: number }

const KW = /^(\s*)(Feature:|Background:|Scenario Outline:|Scenario:|Rule:|Examples:|Given |When |Then |And |But |\* |test\.describe(?:\.\w+)?\(|test\.step\(|test(?:\.\w+)?\(|expect\()(.*)$/;

/** One test or Cypress scenario: its steps, its code, and the scopes it checks. Read only. */
export function TestPage({ t, route }: { t: Tracker; route: Route }) {
  const id = route.id!;
  const x = t.testById.get(id);
  const say = useSay();
  const [mode, setMode] = useState<'test' | 'file'>('test');
  const [pick, setPick] = useState(false);
  const { data: src, error } = useApi<TestSource>(x ? `/api/projects/${t.project}/test-source?id=${encodeURIComponent(id)}` : null);
  useEffect(() => {
    if (mode === 'file' && src) setTimeout(() => document.getElementById(`T${src.start}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 40);
  }, [mode, src]);
  if (!x) {
    return (
      <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="muted">There is no test {id} in the repo now. It was deleted or renamed.</div>
        <div><a className="btn" href={link(t.project, 'tests')}>Open the tests</a></div>
      </main>
    );
  }
  const order = testOrder.includes(id) ? testOrder : t.tests.map((y) => y.id);
  const pos = order.indexOf(id);
  const goT = (k: number) => order[k] && go(link(t.project, 'test', order[k]));
  const isCy = x.fw === 'cypress';
  const [stLabel, stCls] = testTag(x);
  const bg = isCy ? (x.cy?.steps ?? []).filter((s) => s.background) : [];
  const steps = isCy
    ? (x.cy?.steps ?? []).filter((s) => !s.background).map((s) => ({ kw: s.keyword.trim(), text: s.text, depth: 0 }))
    : (x.pw?.steps ?? []).map((s) => ({ kw: '', text: s.title, depth: s.depth }));
  const lines = src ? src.source.split('\n') : [];
  const start = src?.start ?? x.line;
  const end = src?.end ?? x.line;
  // "This test": the Background block of a .feature file, then the test's own lines.
  const bgStart = isCy ? lines.findIndex((l) => /^\s*Background:/.test(l)) + 1 : 0;
  let bgEnd = bgStart;
  if (bgStart) while (bgEnd < lines.length && !/^\s*(Scenario|Rule|Examples|@)/.test(lines[bgEnd]) && bgEnd + 1 < start) bgEnd++;
  const show = (n: number) => mode === 'file' || (n >= start && n <= end) || (bgStart > 0 && n >= bgStart && n <= bgEnd);
  const others = t.tests.filter((y) => y.file === x.file && y.fw === x.fw);

  const rows: React.ReactNode[] = [];
  let gap = false;
  lines.forEach((l, k) => {
    const n = k + 1;
    if (!show(n)) {
      if (!gap) {
        gap = true;
        rows.push(<button key={`g${n}`} className="ln-gap" onClick={() => setMode('file')}>Lines hidden. Show the whole file</button>);
      }
      return;
    }
    gap = false;
    const mm = l.match(KW);
    rows.push(
      <div key={n} id={`T${n}`} className={`ln ${n >= start && n <= end ? 'ln-hl' : ''}`}>
        <span className="ln-no" style={{ cursor: 'default' }}>{n}</span>
        <span className="ln-code">{mm ? <>{mm[1]}<span className="kw">{mm[2]}</span>{mm[3]}</> : l}</span>
      </div>,
    );
  });

  return (
    <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <nav className="crumbs" aria-label="Breadcrumb">
        <a className="linkbtn" href={link(t.project, 'tests')}>Tests</a>
        <span className="faint" aria-hidden="true">/</span>
        <span className="faint mono" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{x.file}</span>
        <span style={{ flex: 1 }} />
        <span className="faint" style={{ fontSize: 12 }}>{pos >= 0 ? `Test ${pos + 1} of ${order.length}` : ''}</span>
        <button className="icon-btn" onClick={() => goT(pos - 1)} disabled={pos <= 0} aria-label="Previous test" title="Previous test"><IPrev s={16} /></button>
        <button className="icon-btn" onClick={() => goT(pos + 1)} disabled={pos < 0 || pos >= order.length - 1} aria-label="Next test" title="Next test"><INext s={16} /></button>
      </nav>
      <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className={`tag ${isCy ? 'tag-cy' : 'tag-ro'}`}>{isCy ? 'Cypress' : 'Playwright'}</span>
          <span className={`tag ${stCls}`}>{stLabel}</span>
          {x.tags.map((g) => <span key={g} className="tag tag-ro mono">{g}</span>)}
          <IdBtn label={x.id} />
        </div>
        <h1 className="h1">{x.title}</h1>
        {x.path.filter(Boolean).length > 0 && <div className="muted" style={{ fontSize: 13 }}>{x.path.filter(Boolean).join(' › ')}</div>}
        <div className="muted mono" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{src?.repoPath ?? x.file} · {src ? `lines ${start}–${end}` : `line ${x.line}`}</div>
        <div style={{ display: 'flex', gap: '8px 12px', flexWrap: 'wrap', alignItems: 'center', fontSize: 13, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          <span className="faint">Checks</span>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><TestLinks t={t} x={x} backLabel={`Back to ${x.id}`} /></span>
          <span style={{ flex: 1 }} />
          <button className="btn btn-sm add-btn" onClick={() => setPick(true)}><IPlus />Link to a scope</button>
        </div>
      </div>
      <section className="card" aria-labelledby="sc-h">
        <div className="sec-head"><h2 className="h2" id="sc-h">Scenario</h2><span className="faint" style={{ fontSize: 12 }}>{isCy ? 'Gherkin steps from the .feature file' : 'The named steps in the spec (test.step)'}</span></div>
        <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {bg.length > 0 && (
            <div>
              <div className="h3">Background, runs before every scenario</div>
              <ol className="steps-list">{bg.map((s, k) => <li key={k}><span className="kw-pill">{s.keyword.trim()}</span>{s.text}</li>)}</ol>
            </div>
          )}
          {steps.length > 0 ? (
            <div>
              <div className="h3">{isCy ? 'Scenario' : 'Steps'}</div>
              <ol className="steps-list">{steps.map((s, k) => <li key={k} style={{ marginLeft: s.depth * 16 }}><span className="kw-pill">{s.kw}</span>{s.text}</li>)}</ol>
            </div>
          ) : (
            <div className="faint" style={{ fontSize: 13 }}>This test has no named steps. Read the code below.</div>
          )}
        </div>
      </section>
      <section className="card" aria-labelledby="tc-h">
        <div className="sec-head">
          <h2 className="h2" id="tc-h" style={{ flex: 1 }}>{isCy ? 'Feature file' : 'Spec file'}</h2>
          <Seg label="Show" value={mode} onChange={setMode} items={[{ key: 'test', label: 'This test' }, { key: 'file', label: 'Whole file' }]} />
          <button className="btn btn-sm" onClick={async () => say((await copyText(`${src?.repoPath ?? x.file}:${start}`)) ? `Copied ${src?.repoPath ?? x.file}:${start}` : 'Could not copy')}>Copy path</button>
        </div>
        <div className="src" aria-label="Test source">
          {src ? rows : <div className="faint" style={{ padding: 16, fontSize: 13, fontFamily: 'Inter, system-ui, sans-serif' }}>{error ? `Could not load the file: ${error}` : 'Loading the file…'}</div>}
        </div>
      </section>
      <section className="card" aria-labelledby="to-h">
        <div className="sec-head"><h2 className="h2" id="to-h">Tests in this file <span className="faint" style={{ fontWeight: 400 }}>{others.length}</span></h2></div>
        <div style={{ padding: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {others.map((o) => {
            const [l, c] = testTag(o);
            return (
              <a key={o.id} className={`li ${o.id === id ? 'li-on' : ''}`} aria-current={o.id === id ? 'true' : undefined} href={link(t.project, 'test', o.id)} style={{ color: 'var(--ink)', textDecoration: 'none' }}>
                <span style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}><span className={`tag ${c}`}>{l}</span><span style={{ fontWeight: 500 }}>{o.title}</span></span>
              </a>
            );
          })}
        </div>
      </section>
      {pick && <LinkToScope t={t} x={x} onClose={() => setPick(false)} />}
    </main>
  );
}
