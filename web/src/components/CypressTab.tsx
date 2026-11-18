import { useMemo, useState } from 'react';
import { useApi, type CypressScenario } from '../api';
import { href } from '../router';
import { buildTree, leaves, Tree } from './Tree';
import { Empty, Loading, Tag } from './ui';
import { TestFeatures } from './FeaturesTab';

export function CypressTab({ project, sel }: { project: string; sel: string | null }) {
  const { data, error } = useApi<CypressScenario[]>(`/api/projects/${project}/cypress`);
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    const q = query.toLowerCase();
    return (data ?? []).filter(
      (s) => !q || [s.id, s.title, s.feature, s.file, ...s.tags, ...s.steps.map((x) => x.text)].some((v) => v.toLowerCase().includes(q)),
    );
  }, [data, query]);
  // Folder > feature file > scenario. The leaf is keyed by the scenario ID.
  const tree = useMemo(
    () => buildTree(shown, (s) => [...s.file.replace(/\.feature$/, '').split('/'), s.title], (s) => s.id),
    [shown],
  );

  if (!data) return <Loading error={error} />;
  const scenario = data.find((s) => s.id === sel);

  return (
    <div className="flex h-full">
      <aside className="flex w-[420px] shrink-0 flex-col border-r border-line bg-surface">
        <div className="border-b border-line p-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by title, tag, step, file or ID…"
            className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-sm outline-none focus:border-accent"
          />
          <div className="mt-2 text-xs text-ink-3">
            {shown.length} of {data.length} scenarios
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1">
          <Tree<CypressScenario>
            nodes={tree}
            selected={sel}
            forceOpen={!!query}
            defaultOpenDepth={1}
            onSelect={(n) => n.item && (location.hash = href({ project, tab: 'cypress', sel: n.key }))}
            renderMeta={(n) =>
              n.item ? (
                n.item.examples > 0 ? <span className="text-xs text-ink-3">{n.item.examples} rows</span> : null
              ) : (
                <span className="text-xs tabular-nums text-ink-3">{leaves(n).length}</span>
              )
            }
          />
        </div>
      </aside>
      <section className="min-w-0 flex-1 overflow-auto">
        {scenario ? <ScenarioDetail project={project} s={scenario} /> : <Empty>Select a scenario to see its steps and tags.</Empty>}
      </section>
    </div>
  );
}

function ScenarioDetail({ project, s }: { project: string; s: CypressScenario }) {
  return (
    <div className="max-w-3xl space-y-5 p-6">
      <div>
        <div className="font-mono text-xs text-ink-3">{s.id}</div>
        <h2 className="mt-1 text-lg font-semibold">{s.title}</h2>
        <div className="mt-1 text-sm text-ink-2">
          {s.keyword} in feature “{s.feature}”{s.rule ? ` › rule “${s.rule}”` : ''}
        </div>
        <div className="mt-1 font-mono text-xs text-ink-3">
          {s.file}:{s.line}
        </div>
        {s.parseError && <div className="mt-2 text-sm text-bad">Could not read this file: {s.parseError}</div>}
      </div>

      {s.featureDescription && <p className="whitespace-pre-line rounded-md bg-surface-2 p-3 text-sm text-ink-2">{s.featureDescription}</p>}

      <TestFeatures project={project} testId={s.id} />

      <div>
        <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-3">Tags</div>
        <div className="flex flex-wrap gap-1.5">{s.tags.length ? s.tags.map((x) => <Tag key={x}>{x}</Tag>) : <span className="text-sm text-ink-3">No tags</span>}</div>
      </div>

      <div>
        <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-3">Steps ({s.steps.length})</div>
        <ol className="space-y-1 text-sm">
          {s.steps.map((st, i) => (
            <li key={i} className="flex gap-2">
              <span className="w-5 shrink-0 text-right tabular-nums text-ink-3">{i + 1}.</span>
              <span>
                <span className="font-semibold text-ink-2">{st.keyword}</span> {st.text}
                {st.background && <span className="ml-2 text-xs text-ink-3">(Background)</span>}
              </span>
            </li>
          ))}
        </ol>
        {s.examples > 0 && <div className="mt-2 text-xs text-ink-2">Runs once for each of {s.examples} example rows.</div>}
      </div>
    </div>
  );
}
