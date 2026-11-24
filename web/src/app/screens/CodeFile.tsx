import { useEffect, useMemo, useRef, useState } from 'react';
import { mutate, useApi, type FileDetail } from '../../api';
import { fmt, type Tracker } from '../data';
import { go, link, type Route } from '../route';
import { Banner, INext, IPrev, Loading, Seg, useAct, useSay } from '../ui';
import { fileOrder, useView, ViewSeg } from './Code';

type Eff = 'run' | 'cyonly' | 'mcov' | 'setup' | 'miss' | 'lib' | 'mlib' | 'none';
/** The file with the hand marks (server: line_marks). Stale: the marked line changed since, so the mark does not count. */
type FileX = FileDetail & {
  lines: FileDetail['lines'] & { markedLibrary?: number[]; markedCovered?: number[] };
  marks?: { line: number; kind: 'library' | 'covered'; stale: boolean }[];
};
const CLS: Record<Eff, string> = { run: 'st-run', cyonly: 'st-cyonly', mcov: 'st-mcov', setup: 'st-setup', miss: 'st-miss', lib: 'st-lib', mlib: 'st-mlib', none: '' };
const TAG: Partial<Record<Eff, string>> = { mlib: 'Marked: library', mcov: 'Marked: covered' };

export function CodeFile({ t, route }: { t: Tracker; route: Route }) {
  const path = route.q.get('path') ?? '';
  const view = useView(t, route);
  const { data, error } = useApi<FileX>(`/api/projects/${t.project}/file?path=${encodeURIComponent(path)}${view ? `&view=${view}` : ''}`);
  if (!data) return <Loading error={error} />;
  return <FileView key={path} t={t} route={route} d={data} view={view} />;
}

function FileView({ t, route, d, view }: { t: Tracker; route: Route; d: FileX; view: ReturnType<typeof useView> }) {
  const act = useAct();
  const say = useSay();
  const src = useMemo(() => d.source.split('\n'), [d.source]);
  const eff = useMemo(() => {
    const m = new Map<number, Eff>();
    const put = (ns: number[] | undefined, e: Eff) => ns?.forEach((n) => m.set(n, e));
    put(d.lines.never, 'miss');
    put(d.lines.background, 'setup');
    put(d.lines.setup, 'setup');
    put(d.lines.tested, 'run');
    put(d.lines.cypressOnly, 'cyonly');
    put(d.lines.library, 'lib');
    put(d.lines.markedLibrary, 'mlib');
    put(d.lines.markedCovered, 'mcov');
    return src.map((_, k) => m.get(k + 1) ?? 'none');
  }, [d, src]);
  const isUnc = (k: number) => eff[k] === 'miss' || eff[k] === 'setup';
  const blocks = useMemo(() => {
    const out: { s: number; e: number }[] = [];
    let cur: { s: number; e: number } | null = null;
    eff.forEach((_, k) => {
      if (!isUnc(k)) return;
      let joins = !!cur;
      if (cur) for (let j = cur.e + 1; j < k; j++) if (eff[j] !== 'none') { joins = false; break; }
      if (joins) cur!.e = k;
      else out.push((cur = { s: k, e: k }));
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eff]);
  const [mode, setMode] = useState<'unc' | 'all'>('unc');
  const [blk, setBlk] = useState(-1);
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const srcBox = useRef<HTMLDivElement>(null);
  const sa = sel ? Math.min(sel.a, sel.b) : 0;
  const sb = sel ? Math.max(sel.a, sel.b) : -1;
  const inSel = (n: number) => n >= sa && n <= sb;
  const scrollTo = (n: number) => setTimeout(() => document.getElementById(`L${n}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 40);
  // A link to a line or a function puts that line at the top of the screen, just under the fixed top bar.
  const scrollToTop = (n: number) =>
    setTimeout(() => {
      const el = document.getElementById(`L${n}`);
      if (!el) return;
      const bar = document.querySelector('.top')?.getBoundingClientRect().bottom ?? 0;
      window.scrollBy({ top: el.getBoundingClientRect().top - bar - 8, behavior: 'smooth' });
    }, 40);
  const goBlk = (k: number) => {
    if (!blocks.length) return;
    const kk = (k + blocks.length) % blocks.length;
    setBlk(kk);
    scrollTo(blocks[kk].s + 1);
  };
  // Only a new line in the address moves the selection. Other changes to the address keep it.
  const qLine = route.q.get('line');
  useEffect(() => {
    if (qLine) {
      const n = Number(qLine);
      setSel({ a: n, b: n });
      setMode('all');
      scrollToTop(n);
    }
  }, [qLine]);
  // A link with a function name (from the AI decisions on the Code page) selects that function and scrolls to it.
  const qFn = route.q.get('fn');
  // Two functions can have the same name (for example two "{closure}"). The AI decision counts all of them, so the message names the others.
  useEffect(() => {
    const all = qFn ? d.functions.filter((f) => f.name === qFn) : [];
    const fn = all[0];
    if (fn) {
      setSel({ a: fn.start, b: fn.end });
      setMode('all');
      scrollToTop(fn.start);
      if (all.length > 1) say(`${all.length} functions have the name ${qFn}. This one starts at line ${fn.start}. ${all.length > 2 ? 'The others start at lines' : 'The other starts at line'} ${all.slice(1).map((x) => x.start).join(', ')}.`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qFn]);

  // Counts of this file, with the marks.
  const c = { run: 0, cyonly: 0, mcov: 0, setup: 0, miss: 0, lib: 0, mlib: 0 };
  eff.forEach((e) => e !== 'none' && c[e]++);
  const feat = c.run + c.cyonly + c.mcov + c.setup + c.miss;
  const pctTxt = feat ? Math.round(((c.run + c.cyonly + c.mcov) / feat) * 100) : 100;
  const w = (n: number) => `${feat ? (n / feat) * 100 : 0}%`;
  const marked = c.mlib + c.mcov;
  const stale = (d.marks ?? []).filter((m) => m.stale);
  const dir = path(d.path);

  /** Marks the runnable lines a..b (kind) or removes their marks (null). Undo puts the old marks back. */
  const markRange = (a: number, b: number, kind: 'library' | 'covered' | null) => {
    const lines: number[] = [];
    for (let n = a; n <= b; n++) if (eff[n - 1] !== 'none') lines.push(n);
    if (!lines.length) return act(async () => {}, 'No code line in the selection');
    const old = new Map((d.marks ?? []).map((m) => [m.line, m.kind]));
    const url = `/api/projects/${t.project}/line-marks`;
    const undo = async () => {
      const back = { library: lines.filter((n) => old.get(n) === 'library'), covered: lines.filter((n) => old.get(n) === 'covered') };
      const none = lines.filter((n) => !old.has(n));
      if (none.length) await mutate('DELETE', url, { file: d.path, lines: none }, { quiet: true });
      for (const k of ['library', 'covered'] as const) if (back[k].length) await mutate('POST', url, { file: d.path, lines: back[k], kind: k }, { quiet: true });
    };
    const what = kind === 'library' ? 'marked as library' : kind === 'covered' ? 'marked as covered' : 'unmarked';
    return act(
      async () => {
        await (kind ? mutate('POST', url, { file: d.path, lines, kind }) : mutate('DELETE', url, { file: d.path, lines }));
        setSel(null);
      },
      `${lines.length} ${lines.length === 1 ? 'line' : 'lines'} ${what}`,
      undo,
    );
  };
  let selN = 0;
  let selMarks = false;
  if (sel) for (let n = sa; n <= sb; n++) if (eff[n - 1] && eff[n - 1] !== 'none') (selN++, (selMarks ||= eff[n - 1] === 'mlib' || eff[n - 1] === 'mcov'));

  const fnRows = d.functions.map((fn) => {
    let run = 0, tot = 0, lib = 0, unc = 0;
    for (let n = fn.start; n <= fn.end; n++) {
      const s = eff[n - 1];
      if (!s || s === 'none') continue;
      if (s === 'lib' || s === 'mlib') { lib++; continue; }
      tot++;
      if (s === 'run' || s === 'mcov' || s === 'cyonly') run++;
      else unc++;
    }
    const st = !tot ? 'lib' : !unc ? 'ok' : !run ? 'none' : 'part';
    return { fn, run, tot, lib, st };
  });
  const ST: Record<string, [string, string]> = { lib: ['Library', 'tag-new'], ok: ['Covered', 'tag-ok'], none: ['Not run', 'tag-fail'], part: ['Partly run', 'tag-skip'] };

  // Lines to show: all, or the uncovered lines and the selection with 3 lines around them.
  const show = src.map(() => mode === 'all');
  if (mode !== 'all') src.forEach((_, k) => { if (isUnc(k) || inSel(k + 1)) for (let j = Math.max(0, k - 3); j <= Math.min(src.length - 1, k + 3); j++) show[j] = true; });
  const cur = blk >= 0 ? blocks[blk] : null;
  const items: React.ReactNode[] = [];
  let gapStart = -1;
  const lineItem = (k: number) => {
    const n = k + 1;
    const e = eff[k];
    return (
      <div key={n} id={`L${n}`} className={`ln ${CLS[e]} ${inSel(n) ? 'ln-sel' : ''} ${cur && k >= cur.s && k <= cur.e ? 'ln-cur' : ''}`}>
        <button className="ln-no" aria-label={`Select line ${n}`} onClick={(ev) => setSel(ev.shiftKey && sel ? { a: sel.a, b: n } : sel && sel.a === n && sel.b === n ? null : { a: n, b: n })}>{n}</button>
        <span className="ln-tag">{TAG[e] ?? ''}</span>
        <span className="ln-code">{src[k]}</span>
      </div>
    );
  };
  const flush = (end: number) => {
    const from = gapStart;
    gapStart = -1;
    if (open[from]) {
      for (let j = from; j <= end; j++) items.push(lineItem(j));
      return;
    }
    items.push(<button key={`g${from}`} className="ln-gap" onClick={() => setOpen({ ...open, [from]: true })}>Show {end - from + 1} hidden lines ({from + 1}–{end + 1})</button>);
  };
  src.forEach((_, k) => {
    if (show[k]) {
      if (gapStart >= 0) flush(k - 1);
      items.push(lineItem(k));
    } else if (gapStart < 0) gapStart = k;
  });
  if (gapStart >= 0) flush(src.length - 1);

  const order = fileOrder.includes(d.path) ? fileOrder : [];
  const pos = order.indexOf(d.path);
  const goFile = (k: number) => order[k] && go(link(t.project, 'codefile', null, { path: order[k], view: route.q.get('view') }));
  const unmeasured = !d.measured;

  return (
    <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <nav className="crumbs" aria-label="Breadcrumb">
        <a className="linkbtn" href={link(t.project, 'code', null, { view: route.q.get('view') })}>Code coverage</a>
        <span className="faint" aria-hidden="true">/</span>
        <span className="faint mono" style={{ fontSize: 12 }}>{dir}</span>
        <span style={{ flex: 1 }} />
        <ViewSeg t={t} view={view} />
        {pos >= 0 && (
          <>
            <span className="faint" style={{ fontSize: 12 }}>File {pos + 1} of {order.length}</span>
            <button className="icon-btn" onClick={() => goFile(pos - 1)} disabled={pos <= 0} aria-label="Previous file" title="Previous file"><IPrev s={16} /></button>
            <button className="icon-btn" onClick={() => goFile(pos + 1)} disabled={pos >= order.length - 1} aria-label="Next file" title="Next file"><INext s={16} /></button>
          </>
        )}
      </nav>
      <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h1 className="h1 mono" style={{ fontSize: 18, overflowWrap: 'anywhere' }}>{d.path.split('/').pop()}</h1>
        {unmeasured ? (
          <div className="muted" style={{ fontSize: 13 }}>The coverage run has no data for this file{d.path.endsWith('.php') ? '' : ': JavaScript is not measured yet'}.</div>
        ) : (
          <>
            <div className="muted" style={{ fontSize: 13 }}>
              {fmt(c.run + c.cyonly + c.mcov)} of {fmt(feat)} feature lines run by tests ({pctTxt}%) · {fmt(c.setup + c.miss)} uncovered · {fmt(c.lib + c.mlib)} library lines left out
              {marked ? ` · ${marked} marked by hand` : ''}{!d.loaded ? ' · no request loaded this file' : ''}
            </div>
            <div className="bar stack" style={{ maxWidth: 560 }}>
              <div className="fill c-good" style={{ width: w(c.run) }} /><div className="fill c-cy" style={{ width: w(c.cyonly) }} /><div className="fill c-mcov" style={{ width: w(c.mcov) }} />
              <div className="fill c-skip" style={{ width: w(c.setup) }} /><div className="fill c-fail" style={{ width: w(c.miss) }} />
            </div>
            <div className="legend">
              <span><i className="sw c-good" />{c.run} Run by tests</span>
              {c.cyonly > 0 && <span><i className="sw c-cy" />{c.cyonly} Run only by Cypress</span>}
              <span><i className="sw c-mcov" />{c.mcov} Marked covered</span><span><i className="sw c-skip" />{c.setup} Only in setup</span><span><i className="sw c-fail" />{c.miss} Never run</span>
            </div>
          </>
        )}
      </div>
      {stale.length > 0 && (
        <Banner tone="warn">
          {stale.length} {stale.length === 1 ? 'mark is' : 'marks are'} on lines that changed since the mark (line {stale.map((m) => m.line).join(', ')}). They do not count.{' '}
          <button className="linkbtn" onClick={() => act(() => mutate('DELETE', `/api/projects/${t.project}/line-marks`, { file: d.path, lines: stale.map((m) => m.line) }), 'Old marks removed')}>Remove them</button>
        </Banner>
      )}
      {fnRows.length > 0 && (
        <section className="card" aria-labelledby="fn-h">
          <div className="sec-head"><h2 className="h2" id="fn-h">Functions <span className="faint" style={{ fontWeight: 400 }}>{fnRows.length}</span></h2></div>
          <div className="table-box">
            <div className="gt" role="table" aria-label="Functions" style={{ minWidth: 720 }}>
              <div className="gr gh cols-cfn" role="row"><span role="columnheader">Status</span><span role="columnheader">Function</span><span role="columnheader" className="num">Lines run</span><span role="columnheader">Starts at</span><span role="columnheader"><span className="sr">Actions</span></span></div>
              {fnRows.map(({ fn, run, tot, lib, st }) => (
                <div className="gr cols-cfn lc-row" role="row" key={`${fn.name}:${fn.start}`} style={{ borderBottom: '1px solid var(--line)' }}>
                  <div role="cell"><span className={`tag ${ST[st][1]}`}>{ST[st][0]}</span></div>
                  <div role="cell" className="mono" style={{ overflowWrap: 'anywhere' }} title={fn.tests.length ? `Run by ${fn.tests.map((x) => x.id).join(', ')}` : undefined}>{fn.name}</div>
                  <div role="cell" className="num" style={{ fontSize: 13 }}>{tot ? `${run}/${tot}` : `${lib} lib`}</div>
                  <div role="cell"><button className="linkbtn" style={{ fontSize: 13 }} onClick={() => (setSel({ a: fn.start, b: fn.end }), scrollTo(fn.start))}>Line {fn.start}</button></div>
                  <div role="cell" style={{ textAlign: 'right' }}>
                    {st !== 'lib' && <span className="row-acts" style={{ justifyContent: 'flex-end' }}><button className="btn btn-ghost btn-sm" onClick={() => markRange(fn.start, fn.end, 'library')}>Mark as library</button></span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
      <section className="card" aria-labelledby="src-h">
        <div className="sec-head">
          <h2 className="h2" id="src-h" style={{ flex: 1 }}>Source</h2>
          <Seg label="Show lines" value={mode} onChange={setMode} items={[{ key: 'unc', label: 'Uncovered + context' }, { key: 'all', label: 'All lines' }]} />
          <span className="faint" style={{ fontSize: 12 }} role="status">
            {blocks.length ? (blk >= 0 ? `Uncovered block ${blk + 1} of ${blocks.length}` : `${blocks.length} uncovered ${blocks.length === 1 ? 'block' : 'blocks'}`) : 'No uncovered code'}
          </span>
          <button className="btn btn-sm" onClick={() => goBlk(blk <= 0 ? blocks.length - 1 : blk - 1)} disabled={!blocks.length}>Previous</button>
          <button className="btn btn-sm btn-primary" onClick={() => goBlk(blk + 1)} disabled={!blocks.length}>Next uncovered</button>
        </div>
        <div className="src-hint">
          <span><i className="sw c-good" /> Run by tests</span><span><i className="sw c-fail" /> Never run</span><span><i className="sw c-skip" /> Only in setup</span>
          <span><i className="sw" style={{ background: 'var(--accent)' }} /> Library</span>
          {view === 'both' && <span><i className="sw c-cy" /> Run only by Cypress</span>}
          <span style={{ flex: 1 }} />
          <span>Click a line number to select it, Shift-click for a range. Keys: <kbd>N</kbd> next, <kbd>P</kbd> previous, <kbd>Esc</kbd> clear.</span>
        </div>
        <div
          ref={srcBox}
          className={`src ${marked ? 'has-tags' : ''}`} tabIndex={0} aria-label="Source code. N and P move between uncovered blocks."
          onKeyDown={(e) => {
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            const k = e.key.toLowerCase();
            if (k === 'n' || k === 'j') (e.preventDefault(), goBlk(blk + 1));
            else if (k === 'p' || k === 'k') (e.preventDefault(), goBlk(blk <= 0 ? blocks.length - 1 : blk - 1));
            else if (e.key === 'Escape') setSel(null);
          }}
        >
          {items}
          {mode !== 'all' && !blocks.length && !sel && (
            <div className="faint" style={{ padding: 16, fontFamily: 'Inter, system-ui, sans-serif', fontSize: 13 }}>Every feature line in this file is covered. Choose All lines to read the code.</div>
          )}
        </div>
        {sel && (
          <div className="selbar" role="region" aria-label="Selected lines">
            <strong style={{ fontSize: 13 }}>{sa === sb ? `Line ${sa}` : `Lines ${sa}–${sb}`} · {selN} {selN === 1 ? 'code line' : 'code lines'}</strong>
            <span style={{ flex: 1 }} />
            <button className="btn btn-sm" onClick={() => markRange(sa, sb, 'library')} disabled={!selN}>Mark as library</button>
            <button className="btn btn-sm" onClick={() => markRange(sa, sb, 'covered')} disabled={!selN}>Mark as covered</button>
            {selMarks && <button className="btn btn-sm btn-danger" onClick={() => markRange(sa, sb, null)}>Remove marks</button>}
            <button className="btn btn-sm btn-ghost" onClick={() => setSel(null)}>Cancel</button>
          </div>
        )}
      </section>
    </main>
  );
}

const path = (p: string) => {
  const k = p.lastIndexOf('/');
  return k > 0 ? p.slice(0, k) : '(plugin root)';
};
