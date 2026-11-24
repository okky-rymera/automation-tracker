import { useEffect, useMemo, useRef, useState } from 'react';
import { allPct, featurePct, featureTotal, useApi, type FileDetail, type FileEntry, type LineCounts, type LineState, type View } from '../api';
import { href, type Tab } from '../router';
import { buildTree, leaves, Tree } from './Tree';
import { CoverageBar, CY_ONLY_META, Empty, Legend, Loading, STATE_META, StateBadge, Swatch } from './ui';

const ZERO: LineCounts = { runnable: 0, library: 0, tested: 0, setup: 0, background: 0, never: 0, runByTests: 0, cypressOnly: 0 };

function sumLines(files: FileEntry[]): LineCounts {
  const out = { ...ZERO };
  for (const f of files) if (f.measured) for (const k of Object.keys(out) as (keyof LineCounts)[]) out[k] = (out[k] ?? 0) + (f.lines[k] ?? 0);
  return out;
}

/** Short text for a file or folder in the tree. */
function summaryText(files: FileEntry[]): string {
  const measured = files.filter((f) => f.measured);
  if (!measured.length) return 'not measured';
  const c = sumLines(measured);
  if (featureTotal(c) > 0) return `${featurePct(c)}%`;
  if (measured.some((f) => f.uncounted)) return 'not counted';
  if (c.library > 0) return 'library';
  return 'no code';
}

export const sentence = (c: LineCounts) =>
  `${c.tested} of ${featureTotal(c)} feature lines run by tests (${featurePct(c)}%)${c.cypressOnly ? `, ${c.cypressOnly} of them only by Cypress` : ''} · ${c.setup + c.background} only in setup · ${c.never} never run · ${c.library} library lines left out`;

/** The file tree and code coverage of one coverage view, inside a tab (Playwright, Cypress). */
export function CodeTab({ project, sel, view, tab }: { project: string; sel: string | null; view: View; tab: Tab }) {
  const { data: files, error } = useApi<FileEntry[]>(`/api/projects/${project}/files?view=${view}`);
  const [query, setQuery] = useState('');
  const [hideJs, setHideJs] = useState(false);

  const shown = useMemo(
    () => (files ?? []).filter((f) => (!hideJs || f.lang === 'php') && f.path.toLowerCase().includes(query.toLowerCase())),
    [files, query, hideJs],
  );
  const tree = useMemo(() => buildTree(shown, (f) => f.path.split('/'), (f) => f.path), [shown]);

  if (!files) return <Loading error={error} />;
  const selectedFile = sel && !sel.startsWith('dir:') ? files.find((f) => f.path === sel) : null;
  const missingFile = !!sel && !sel.startsWith('dir:') && !selectedFile;
  const go = (key: string | null) => (location.hash = href({ project, tab, pane: 'code', sel: key }));

  return (
    <div className="flex h-full">
      <aside className="flex w-[380px] shrink-0 flex-col border-r border-line bg-surface">
        <div className="space-y-2 border-b border-line p-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter files…"
            className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-sm outline-none focus:border-accent"
          />
          <label className="flex items-center gap-2 text-xs text-ink-2">
            <input type="checkbox" checked={hideJs} onChange={(e) => setHideJs(e.target.checked)} />
            Hide JavaScript files (not measured yet)
          </label>
          <div className="text-[11px] text-ink-3">Percent = feature lines run by tests. Library lines are left out.</div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1">
          <Tree<FileEntry> nodes={tree} selected={sel} forceOpen={!!query} onSelect={(n) => go(n.key)} renderMeta={(n) => <RowMeta files={leaves(n)} />} />
        </div>
      </aside>
      <section className="min-w-0 flex-1 overflow-auto">
        {selectedFile ? (
          <FileView project={project} file={selectedFile} view={view} />
        ) : missingFile ? (
          <Empty>
            The file <code className="font-mono">{sel}</code> is not in the project now. It may have been moved or deleted.
          </Empty>
        ) : (
          <FolderView project={project} tab={tab} files={sel ? files.filter((f) => f.path.startsWith(sel.slice(4) + '/')) : files} folder={sel?.slice(4) ?? null} onOpen={go} />
        )}
      </section>
    </div>
  );
}

function RowMeta({ files }: { files: FileEntry[] }) {
  const c = sumLines(files);
  const text = summaryText(files);
  const muted = text === 'not measured' || text === 'no code' || text === 'library' || text === 'not counted';
  return (
    <>
      {featureTotal(c) > 0 ? <CoverageBar c={c} height={6} className="!w-16" /> : <span className="w-16" />}
      <span className={`w-20 text-right text-xs tabular-nums ${muted ? 'text-ink-3' : 'text-ink-2'}`}>{text}</span>
    </>
  );
}

/** Overview of a folder (or the whole repo): subfolder table and a grid of files. */
function FolderView({ project, tab, files, folder, onOpen }: { project: string; tab: Tab; files: FileEntry[]; folder: string | null; onOpen: (k: string) => void }) {
  const c = sumLines(files);
  const depth = folder ? folder.split('/').length : 0;
  const groups = new Map<string, FileEntry[]>();
  for (const f of files) {
    const parts = f.path.split('/');
    const key = parts.length > depth + 1 ? parts.slice(0, depth + 1).join('/') + '/' : '(files in this folder)';
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const rows = [...groups.entries()]
    .map(([k, fs]) => ({ k, fs, c: sumLines(fs), unloaded: fs.filter((f) => f.measured && !f.loaded).length }))
    .sort((a, b) => b.c.runnable - a.c.runnable || a.k.localeCompare(b.k));
  const grid = files.filter((f) => f.measured && featureTotal(f.lines) > 0).sort((a, b) => featureTotal(b.lines) - featureTotal(a.lines));
  const unloaded = files.filter((f) => f.measured && !f.loaded);

  return (
    <div className="space-y-6 p-6">
      <div>
        <h2 className="text-lg font-semibold">{folder ?? 'Whole plugin'}</h2>
        <p className="text-sm text-ink-2">{c.runnable ? sentence(c) : 'No measured PHP code in this folder.'}</p>
        {c.runnable > 0 && (
          <div className="mt-3 grid max-w-2xl gap-2 text-xs text-ink-2">
            <div className="flex items-center gap-3">
              <span className="w-36 shrink-0">Feature code {featurePct(c)}%</span>
              <CoverageBar c={c} height={10} />
            </div>
            <div className="flex items-center gap-3">
              <span className="w-36 shrink-0">All code {allPct(c)}%</span>
              <CoverageBar c={c} height={10} withLibrary />
            </div>
          </div>
        )}
        <div className="mt-3">
          <Legend view={c.cypressOnly ? 'both' : null} />
        </div>
        {unloaded.length > 0 && (
          <p className="mt-3 text-xs text-ink-2">
            {unloaded.length} PHP file{unloaded.length > 1 ? 's were' : ' was'} never loaded by any request. {unloaded.length > 1 ? 'Their' : 'Its'} runnable lines were counted
            without running the code, and all of them count as never run.
          </p>
        )}
      </div>

      <div className="rounded-lg border border-line bg-surface">
        <div className="border-b border-line px-4 py-2 text-sm font-medium">By folder</div>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-ink-3">
            <tr>
              <th className="px-4 py-2 font-medium">Folder</th>
              <th className="w-48 px-4 py-2 font-medium">Feature lines</th>
              <th className="w-20 px-2 py-2 text-right font-medium">Feature</th>
              <th className="w-20 px-2 py-2 text-right font-medium">All code</th>
              {c.cypressOnly > 0 && <th className="w-24 px-2 py-2 text-right font-medium" title="Feature lines that only Cypress tests run">Cypress only</th>}
              <th className="w-20 px-2 py-2 text-right font-medium">Library</th>
              <th className="w-20 px-4 py-2 text-right font-medium">Files</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              // A subfolder opens; a single file opens; a group of loose files has no target.
              const target = r.k.endsWith('/') ? 'dir:' + r.k.slice(0, -1) : r.fs.length === 1 ? r.fs[0].path : null;
              return (
              <tr
                key={r.k}
                className={`border-t border-line ${target ? 'cursor-pointer hover:bg-surface-2' : ''}`}
                onClick={() => target && onOpen(target)}
              >
                <td className="px-4 py-2 font-mono text-xs">
                  {r.k}
                  {r.unloaded > 0 && (
                    <span className="ml-2 font-sans text-xs text-ink-3" title={`${r.unloaded} files in this folder were never loaded by any request`}>
                      ({r.unloaded} never loaded)
                    </span>
                  )}
                </td>
                <td className="px-4 py-2">{featureTotal(r.c) ? <CoverageBar c={r.c} height={6} /> : <span className="text-xs text-ink-3">{summaryText(r.fs)}</span>}</td>
                <td className="px-2 py-2 text-right tabular-nums">{featureTotal(r.c) ? `${featurePct(r.c)}%` : '–'}</td>
                <td className="px-2 py-2 text-right tabular-nums text-ink-2">{r.c.runnable ? `${allPct(r.c)}%` : '–'}</td>
                {c.cypressOnly > 0 && (
                  <td className="px-2 py-2 text-right tabular-nums" style={{ color: r.c.cypressOnly ? CY_ONLY_META.color : undefined }}>
                    {r.c.cypressOnly || '–'}
                  </td>
                )}
                <td className="px-2 py-2 text-right tabular-nums text-ink-2">{r.c.runnable ? r.c.library : '–'}</td>
                <td className="px-4 py-2 text-right tabular-nums text-ink-2">{r.fs.length}</td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {grid.length > 0 && (
        <div className="rounded-lg border border-line bg-surface p-4">
          <div className="mb-1 text-sm font-medium">PHP files with feature code</div>
          <p className="mb-3 text-xs text-ink-2">One square per file, sized by feature lines, colored by the share run by tests. Hover for numbers, click to open.</p>
          <div className="flex flex-wrap gap-[2px]">
            {grid.map((f) => {
              const ft = featureTotal(f.lines);
              const share = f.lines.tested / ft;
              const size = Math.max(12, Math.min(60, Math.sqrt(ft) * 3));
              return (
                <a
                  key={f.path}
                  href={href({ project, tab, pane: 'code', sel: f.path })}
                  title={`${f.path}\n${f.lines.tested} of ${ft} feature lines run by tests (${featurePct(f.lines)}%)${f.lines.cypressOnly ? `, ${f.lines.cypressOnly} only by Cypress` : ''}\n${f.lines.never} never run · ${f.lines.library} library lines`}
                  className="rounded-[3px] hover:outline-2 hover:outline-accent"
                  style={{
                    width: size,
                    height: size,
                    background: share === 0 ? 'var(--bad)' : `color-mix(in oklab, var(--good) ${Math.round(25 + share * 75)}%, var(--surface-2))`,
                  }}
                />
              );
            })}
          </div>
          <div className="mt-3 flex items-center gap-2 text-xs text-ink-2">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-bad" /> no feature line run
            <span className="ml-3">low</span>
            <span className="inline-block h-2.5 w-24 rounded-sm" style={{ background: 'linear-gradient(90deg, color-mix(in oklab, var(--good) 25%, var(--surface-2)), var(--good))' }} />
            <span>all feature lines run</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** One file: its functions and its source, colored by the coverage of one view. */
export function FileView({ project, file, view }: { project: string; file: FileEntry; view: View }) {
  const { data, error } = useApi<FileDetail>(`/api/projects/${project}/file?path=${encodeURIComponent(file.path)}&view=${view}`);
  const [openFn, setOpenFn] = useState<string | null>(null);
  const codeRef = useRef<HTMLDivElement>(null);
  useEffect(() => setOpenFn(null), [file.path]);

  const lineState = useMemo(() => {
    const m = new Map<number, LineState>();
    if (data) for (const s of ['library', 'tested', 'setup', 'background', 'never'] as LineState[]) for (const n of data.lines[s] ?? []) m.set(n, s);
    return m;
  }, [data]);
  const cyOnly = useMemo(() => new Set(data?.lines.cypressOnly ?? []), [data]);
  const fnStart = useMemo(() => new Map((data?.functions ?? []).map((f) => [f.start, f])), [data]);

  if (!data) return <Loading error={error} />;
  const c = file.lines;
  const jump = (line: number) => codeRef.current?.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: 'center' });

  return (
    <div className="p-6">
      <h2 className="font-mono text-base font-semibold">{file.path}</h2>
      <p className="mt-1 text-sm text-ink-2">
        {!data.measured
          ? file.lang === 'php'
            ? 'Not measured: this file is not in the coverage run. It was added or moved after the run. Make a new coverage run to measure it.'
            : 'Not measured: JavaScript coverage is not collected yet.'
          : file.uncounted
            ? 'No request loaded this file, and its runnable lines could not be counted, so it is not in the percentages.'
            : !data.loaded && !c.runnable
            ? 'No request loaded this file, and it has no runnable lines.'
            : !data.loaded
              ? `No request loaded this file, so none of its ${c.runnable} runnable lines ran. The lines were counted without running the file.`
              : featureTotal(c)
              ? sentence(c)
              : c.library
                ? `All ${c.library} runnable lines are library code (they run on every request).`
                : 'No runnable lines.'}
      </p>
      {c.runnable > 0 && (
        <div className="mt-3 grid max-w-2xl gap-2 text-xs text-ink-2">
          <div className="flex items-center gap-3">
            <span className="w-36 shrink-0">Feature code {featurePct(c)}%</span>
            <CoverageBar c={c} height={10} />
          </div>
          <div className="flex items-center gap-3">
            <span className="w-36 shrink-0">All code {allPct(c)}%</span>
            <CoverageBar c={c} height={10} withLibrary />
          </div>
        </div>
      )}

      {data.functions.length > 0 && (
        <div className="mt-5 rounded-lg border border-line bg-surface">
          <div className="border-b border-line px-4 py-2 text-sm font-medium">Functions ({data.functions.length})</div>
          <ul className="max-h-80 overflow-auto">
            {data.functions.map((f) => {
              const key = f.name + ':' + f.start;
              const isOpen = openFn === key;
              const feat = f.lines.tested + f.lines.setup + f.lines.background + f.lines.never;
              // Every tested line of the function ran only in Cypress tests.
              const onlyCy = f.state === 'tested' && f.cypressOnly > 0 && f.cypressOnly === f.lines.tested;
              return (
                <li key={key} className="border-t border-line first:border-t-0">
                  <div className="flex items-center gap-3 px-4 py-1.5">
                    <span className="w-56 shrink-0">
                      <StateBadge state={f.state} cypressOnly={onlyCy} />
                    </span>
                    <button type="button" className="min-w-0 flex-1 truncate text-left font-mono text-xs hover:text-accent" onClick={() => jump(f.start)}>
                      {f.name}
                    </button>
                    <span
                      className="w-28 text-right text-xs tabular-nums text-ink-3"
                      title={`Feature lines run by tests / feature lines. Library lines are left out.${f.cypressOnly ? ` ${f.cypressOnly} of the run lines ran only in Cypress tests.` : ''}`}
                    >
                      {feat ? `${f.lines.tested}/${feat} lines` : f.lines.library ? `${f.lines.library} lib lines` : ''}
                      {!onlyCy && f.cypressOnly > 0 && <span style={{ color: CY_ONLY_META.color }}> ◆{f.cypressOnly}</span>}
                    </span>
                    <span className="w-16 text-right text-xs tabular-nums text-ink-3">line {f.start}</span>
                    {f.tests.length > 0 ? (
                      <button type="button" className="w-24 text-right text-xs text-accent" onClick={() => setOpenFn(isOpen ? null : key)}>
                        {f.tests.length} test run{f.tests.length > 1 ? 's' : ''} {isOpen ? '▴' : '▾'}
                      </button>
                    ) : (
                      <span className="w-24" />
                    )}
                  </div>
                  {isOpen && (
                    <ul className="bg-bg px-4 py-2 text-xs">
                      {f.tests.map((t) => (
                        <li key={t.id} className="py-0.5">
                          {t.framework && <span className="mr-1.5 rounded bg-surface-2 px-1 text-[10px] uppercase text-ink-2">{t.framework === 'cypress' ? 'CY' : 'PW'}</span>}
                          <span className="text-ink">{t.title}</span> <span className="font-mono text-ink-3">{t.file}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="mt-5 rounded-lg border border-line bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
          <span className="text-sm font-medium">Source</span>
          <span className="flex flex-wrap gap-3 text-xs text-ink-2">
            <Swatch color={STATE_META.library.color} label="library" />
            <Swatch color={STATE_META.tested.color} label={cyOnly.size || view === 'both' ? 'ran in a Playwright test' : 'ran in a test'} />
            {(cyOnly.size > 0 || view === 'both') && <Swatch color={CY_ONLY_META.color} label="ran only in Cypress tests" />}
            <Swatch color={STATE_META.setup.color} label="ran only in setup" />
            <Swatch color={STATE_META.never.color} label="never ran" />
            <Swatch color="transparent" outline label="no color: not runnable code" />
          </span>
        </div>
        <div ref={codeRef} className="overflow-x-auto py-2 font-mono text-[12px] leading-[18px]">
          {data.source.split('\n').map((text, i) => {
            const n = i + 1;
            const st = lineState.get(n);
            const kind = st === 'background' ? 'setup' : st;
            const meta = cyOnly.has(n) ? CY_ONLY_META : kind ? STATE_META[kind] : null;
            const fn = fnStart.get(n);
            return (
              <div
                key={n}
                data-line={n}
                className="flex whitespace-pre"
                style={{ background: meta?.tint }}
                title={fn ? `${fn.name}: ${STATE_META[fn.state].label}` : st ? (cyOnly.has(n) ? CY_ONLY_META.label : STATE_META[st].label) : undefined}
              >
                <span className="w-1 shrink-0" style={{ background: meta?.color }} />
                <span className="w-12 shrink-0 select-none pr-3 text-right text-ink-3">{n}</span>
                <span className="pr-4">{text || ' '}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
