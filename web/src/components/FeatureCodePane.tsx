import { useMemo, useState } from 'react';
import { featurePct, featureTotal, mutate, pct, useApi, type CodeEntry, type FeatureCodeMap, type FeatureData, type FileEntry, type LineCounts } from '../api';
import { href } from '../router';
import { FileView, sentence } from './CodeTab';
import { act, featureCode, SideItem } from './FeaturesTab';
import { CoverageBar, CY_ONLY_META, Empty, Legend, Loading } from './ui';

/**
 * Features tab, "Code by feature": the plugin code that the AI skill put in each feature,
 * and how much of it the tests run. Coverage is from both runs together, so purple shows
 * the code that only Cypress tests run.
 *
 * sel: "f:<id>" a feature, "none" the code in no feature, or a repo file path.
 */
export function FeatureCodePane({ project, sel }: { project: string; sel: string | null }) {
  const base = `/api/projects/${project}`;
  const { data: map, error } = useApi<FeatureCodeMap>(`${base}/feature-code`);
  const { data: fd } = useApi<FeatureData>(`${base}/features`);
  const { data: files } = useApi<FileEntry[]>(map?.view ? `${base}/files?view=${map.view}` : null);
  const [query, setQuery] = useState('');
  const go = (s: string | null) => (location.hash = href({ project, tab: 'features', pane: 'code', sel: s }));

  const byFeature = useMemo(() => new Map((map?.features ?? []).map((f) => [f.featureId, f])), [map]);
  if (!map || !fd) return <Loading error={error} />;

  const q = query.toLowerCase();
  const shown = fd.features.filter((f) => !q || [featureCode(f.id), f.title].some((s) => s.toLowerCase().includes(q)));
  const sections = [
    ...fd.groups.map((g) => ({ key: g.id, title: g.title, items: shown.filter((f) => f.groupId === g.id) })),
    { key: null, title: 'No group', items: shown.filter((f) => f.groupId === null) },
  ].filter((s) => s.items.length);
  const feature = sel?.startsWith('f:') ? fd.features.find((f) => f.id === Number(sel.slice(2))) : undefined;
  const file = sel && !sel.startsWith('f:') && sel !== 'none' ? files?.find((f) => f.path === sel) : undefined;
  const mappedFeatureLines = map.mapped ? featureTotal(map.mapped) : 0;
  const allFeatureLines = mappedFeatureLines + featureTotal(map.unmappedTotal);

  return (
    <div className="flex h-full">
      <aside className="flex w-[420px] shrink-0 flex-col border-r border-line bg-surface">
        <div className="space-y-2 border-b border-line p-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter features by title or ID…"
            className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-sm outline-none focus:border-accent"
          />
          <div className="text-[11px] text-ink-3">
            {map.view
              ? `${mappedFeatureLines} of ${allFeatureLines} feature lines are in a feature (${pct(mappedFeatureLines, allFeatureLines)}%). The AI skill puts code in features. Percent = lines run by tests.`
              : 'The project has no coverage run.'}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1 text-[13px]">
          <SideItem active={sel === 'none'} onClick={() => go('none')} meta={<Meta c={map.unmappedTotal} />}>
            Code in no feature
          </SideItem>
          {sections.map((s) => (
            <div key={s.key ?? 'none'} className="mt-2">
              <div className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-ink-3">{s.title}</div>
              {s.items.map((f) => {
                const c = byFeature.get(f.id)?.lines;
                return (
                  <SideItem key={f.id} active={sel === `f:${f.id}`} onClick={() => go(`f:${f.id}`)} meta={c ? <Meta c={c} /> : <span className="text-xs text-ink-3">no code yet</span>}>
                    <span className="mr-1.5 font-mono text-[11px] text-ink-3">{featureCode(f.id)}</span>
                    <span className={c ? '' : 'text-ink-3'}>{f.title}</span>
                  </SideItem>
                );
              })}
            </div>
          ))}
        </div>
      </aside>
      <section className="min-w-0 flex-1 overflow-auto">
        {feature ? (
          <FeatureCode project={project} title={`${featureCode(feature.id)} ${feature.title}`} featureId={feature.id} data={byFeature.get(feature.id)} onOpen={go} />
        ) : sel === 'none' ? (
          <Unmapped map={map} onOpen={go} />
        ) : file && map.view ? (
          <FileView project={project} file={file} view={map.view} />
        ) : sel && files ? (
          <Empty>
            The file <code className="font-mono">{sel}</code> is not in the project now. It may have been moved or deleted.
          </Empty>
        ) : (
          <Intro map={map} />
        )}
      </section>
    </div>
  );
}

function Meta({ c }: { c: LineCounts }) {
  return featureTotal(c) ? (
    <span className="flex items-center gap-2">
      <CoverageBar c={c} height={6} className="!w-16" />
      <span className="w-10 text-right text-xs tabular-nums text-ink-2">{featurePct(c)}%</span>
      <span className="w-10 text-right text-xs tabular-nums" style={{ color: CY_ONLY_META.color }} title="Feature lines that only Cypress tests run">
        {c.cypressOnly ? `${CY_ONLY_META.icon}${c.cypressOnly}` : ''}
      </span>
    </span>
  ) : (
    <span className="text-xs text-ink-3">no feature lines</span>
  );
}

function Intro({ map }: { map: FeatureCodeMap }) {
  return (
    <div className="max-w-2xl space-y-3 p-6 text-sm text-ink-2">
      <h2 className="text-lg font-semibold text-ink">Code by feature</h2>
      <p>Each feature holds the plugin code that does it: whole files, or functions in a file. The AI skill (map-features) puts the code in the features. Select a feature to see its code and how much of it the tests run.</p>
      <p>The coverage is from the Playwright run and the Cypress run together. Green lines run in a Playwright test. Purple lines run only in Cypress tests: convert those tests to make the lines green.</p>
      <p>One line can be in more than one feature. The totals count it one time.</p>
      {!map.features.length && <p>No feature has code yet. Run the map-features skill to put code in the features.</p>}
      <Legend view={map.view === 'both' ? 'both' : null} />
    </div>
  );
}

function FeatureCode({
  project,
  title,
  featureId,
  data,
  onOpen,
}: {
  project: string;
  title: string;
  featureId: number;
  data: FeatureCodeMap['features'][0] | undefined;
  onOpen: (s: string) => void;
}) {
  const c = data?.lines;
  return (
    <div className="space-y-5 p-6">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <a href={href({ project, tab: 'features', sel: `f:${featureId}` })} className="text-xs text-accent hover:underline">
          Open the feature
        </a>
        <p className="mt-2 text-sm text-ink-2">{!data ? 'No code is in this feature yet. The AI skill adds it when it maps the feature.' : c ? sentence(c) : 'No coverage run.'}</p>
        {c && featureTotal(c) > 0 && <CoverageBar c={c} height={10} className="mt-3 max-w-2xl" />}
        <div className="mt-3">
          <Legend view={c?.cypressOnly ? 'both' : null} />
        </div>
      </div>
      {data && (
        <div className="rounded-lg border border-line bg-surface">
          <div className="border-b border-line px-4 py-2 text-sm font-medium">Code in this feature ({data.entries.length})</div>
          <EntryTable project={project} entries={data.entries} onOpen={onOpen} />
        </div>
      )}
    </div>
  );
}

function EntryTable({ project, entries, onOpen }: { project: string; entries: CodeEntry[]; onOpen: (s: string) => void }) {
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs text-ink-3">
        <tr>
          <th className="px-4 py-2 font-medium">File and function</th>
          <th className="w-40 px-4 py-2 font-medium">Feature lines</th>
          <th className="w-16 px-2 py-2 text-right font-medium">Run</th>
          <th className="w-20 px-2 py-2 text-right font-medium" title="Feature lines that only Cypress tests run">
            Cypress only
          </th>
          <th className="w-28 px-4 py-2 text-right font-medium" />
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.id} className="border-t border-line">
            <td className="px-4 py-2">
              <button type="button" className="text-left font-mono text-xs hover:text-accent" onClick={() => onOpen(e.file)} disabled={!e.inRepo}>
                {e.file}
              </button>
              <div className="font-mono text-xs text-ink-3">{e.function || 'whole file'}</div>
              {!e.inRepo ? (
                <div className="text-xs" style={{ color: 'var(--warn)' }}>
                  Not in the plugin repo now.
                </div>
              ) : (
                !e.measured && (
                  <div className="text-xs" style={{ color: 'var(--warn)' }}>
                    Not in the coverage run: the code changed after the run, or the name is wrong.
                  </div>
                )
              )}
            </td>
            <td className="px-4 py-2">{e.lines && featureTotal(e.lines) ? <CoverageBar c={e.lines} height={6} /> : <span className="text-xs text-ink-3">–</span>}</td>
            <td className="px-2 py-2 text-right tabular-nums">{e.lines && featureTotal(e.lines) ? `${featurePct(e.lines)}%` : '–'}</td>
            <td className="px-2 py-2 text-right tabular-nums" style={{ color: e.lines?.cypressOnly ? CY_ONLY_META.color : undefined }}>
              {e.lines?.cypressOnly || '–'}
            </td>
            <td className="whitespace-nowrap px-4 py-2 text-right text-xs">
              {e.source === 'ai' && !e.checked && <span className="mr-2 text-ink-3">added by AI</span>}
              <button
                type="button"
                aria-label="Remove from the feature"
                title="Remove this code from the feature. The AI skill does not add it again."
                className="text-ink-3 hover:text-bad"
                onClick={() => act(() => mutate('DELETE', `/api/projects/${project}/feature-code/${e.id}`))}
              >
                ×
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Unmapped({ map, onOpen }: { map: FeatureCodeMap; onOpen: (s: string) => void }) {
  const c = map.unmappedTotal;
  return (
    <div className="space-y-5 p-6">
      <div>
        <h2 className="text-lg font-semibold">Code in no feature</h2>
        <p className="mt-1 text-sm text-ink-2">
          Feature lines (library code left out) that no feature holds yet. {featureTotal(c) ? sentence(c) : 'Every feature line is in a feature.'}
        </p>
        {featureTotal(c) > 0 && <CoverageBar c={c} height={10} className="mt-3 max-w-2xl" />}
      </div>
      {map.unmapped.length > 0 && (
        <div className="rounded-lg border border-line bg-surface">
          <div className="border-b border-line px-4 py-2 text-sm font-medium">Files ({map.unmapped.length})</div>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-ink-3">
              <tr>
                <th className="px-4 py-2 font-medium">File</th>
                <th className="w-40 px-4 py-2 font-medium">Lines in no feature</th>
                <th className="w-16 px-2 py-2 text-right font-medium">Run</th>
                <th className="w-20 px-2 py-2 text-right font-medium">Cypress only</th>
                <th className="w-16 px-4 py-2 text-right font-medium">Lines</th>
              </tr>
            </thead>
            <tbody>
              {map.unmapped.map((u) => (
                <tr key={u.file} className="cursor-pointer border-t border-line hover:bg-surface-2" onClick={() => onOpen(u.file)}>
                  <td className="px-4 py-2 font-mono text-xs">{u.file}</td>
                  <td className="px-4 py-2">
                    <CoverageBar c={u.lines} height={6} />
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{featurePct(u.lines)}%</td>
                  <td className="px-2 py-2 text-right tabular-nums" style={{ color: u.lines.cypressOnly ? CY_ONLY_META.color : undefined }}>
                    {u.lines.cypressOnly || '–'}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-ink-2">{featureTotal(u.lines)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
