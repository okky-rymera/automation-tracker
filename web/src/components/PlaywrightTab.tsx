import { useMemo, useState } from 'react';
import { useApi, type PlaywrightTest } from '../api';
import { href } from '../router';
import { buildTree, leaves, Tree } from './Tree';
import { Empty, Loading, Tag } from './ui';
import { TestFeatures } from './FeaturesTab';

export function PlaywrightTab({ project, sel }: { project: string; sel: string | null }) {
  const { data, error } = useApi<PlaywrightTest[]>(`/api/projects/${project}/playwright`);
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    const q = query.toLowerCase();
    return (data ?? []).filter(
      (t) => !q || [t.id, t.title, t.file, ...t.describes, ...t.tags].some((s) => s.toLowerCase().includes(q)),
    );
  }, [data, query]);
  // Folder > spec file > test. The test leaf is keyed by its ID.
  const tree = useMemo(() => buildTree(shown, (t) => [...t.file.split('/'), t.title], (t) => t.id), [shown]);

  if (!data) return <Loading error={error} />;
  const test = data.find((t) => t.id === sel);

  return (
    <div className="flex h-full">
      <aside className="flex w-[420px] shrink-0 flex-col border-r border-line bg-surface">
        <div className="border-b border-line p-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by title, tag, file or ID…"
            className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-sm outline-none focus:border-accent"
          />
          <div className="mt-2 text-xs text-ink-3">
            {shown.length} of {data.length} tests
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1">
          <Tree<PlaywrightTest>
            nodes={tree}
            selected={sel}
            forceOpen={!!query}
            defaultOpenDepth={2}
            onSelect={(n) => n.item && (location.hash = href({ project, tab: 'playwright', sel: n.key }))}
            renderMeta={(n) =>
              n.item ? (
                <RunDot t={n.item} />
              ) : (
                <span className="text-xs tabular-nums text-ink-3">{leaves(n).length}</span>
              )
            }
          />
        </div>
      </aside>
      <section className="min-w-0 flex-1 overflow-auto">
        {test ? <TestDetail project={project} t={test} /> : <Empty>Select a test to see its steps, tags and coverage.</Empty>}
      </section>
    </div>
  );
}

function RunDot({ t }: { t: PlaywrightTest }) {
  if (t.skipped) return <span className="text-xs text-ink-3">skipped</span>;
  if (!t.run.length) return <span className="text-xs text-ink-3">not in run</span>;
  // A test can also skip itself while it runs (test.skip() inside the test body).
  const failed = t.run.some((r) => r.status !== 'passed' && r.status !== 'skipped');
  if (failed) return <span className="text-xs" style={{ color: 'var(--bad)' }}>✕ failed</span>;
  if (t.run.every((r) => r.status === 'skipped')) return <span className="text-xs text-ink-3">skipped in run</span>;
  const someSkipped = t.run.some((r) => r.status === 'skipped');
  return <span className="text-xs" style={{ color: 'var(--good)' }}>{someSkipped ? '✓ some skipped' : '✓'}</span>;
}

function TestDetail({ project, t }: { project: string; t: PlaywrightTest }) {
  return (
    <div className="max-w-3xl space-y-5 p-6">
      <div>
        <div className="font-mono text-xs text-ink-3">{t.id}</div>
        <h2 className="mt-1 text-lg font-semibold">{t.title}</h2>
        {t.describes.length > 0 && <div className="mt-1 text-sm text-ink-2">{t.describes.join(' › ')}</div>}
        <div className="mt-1 font-mono text-xs text-ink-3">
          {t.file}:{t.line}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {t.skipped && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">Skipped in code</span>}
          {t.parametrized && (
            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs" title="The title is built in a loop, so this one entry runs as several tests.">
              Built in a loop · runs as {t.run.length || 'several'} tests
            </span>
          )}
        </div>
      </div>

      <TestFeatures project={project} testId={t.id} />

      <div>
        <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-3">Tags</div>
        <div className="flex flex-wrap gap-1.5">{t.tags.length ? t.tags.map((x) => <Tag key={x}>{x}</Tag>) : <span className="text-sm text-ink-3">No tags</span>}</div>
      </div>

      <div>
        <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-3">Steps ({t.steps.length})</div>
        {t.steps.length ? (
          <ol className="space-y-1 text-sm">
            {t.steps.map((s, i) => (
              <li key={i} className="flex gap-2" style={{ paddingLeft: s.depth * 18 }}>
                <span className="w-5 shrink-0 text-right tabular-nums text-ink-3">{i + 1}.</span>
                <span>{s.title}</span>
              </li>
            ))}
          </ol>
        ) : (
          <div className="text-sm text-ink-3">This test has no test.step() blocks.</div>
        )}
      </div>

      <div>
        <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-3">Last coverage run</div>
        {t.run.length ? (
          <table className="w-full text-sm">
            <tbody>
              {t.run.map((r, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="py-1.5 pr-3">{r.title}</td>
                  <td className="py-1.5 pr-3 text-xs">{r.status}</td>
                  <td className="py-1.5 text-right text-xs tabular-nums text-ink-2">{r.functions} PHP functions run</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-sm text-ink-3">This test was not in the coverage run.</div>
        )}
      </div>
    </div>
  );
}
