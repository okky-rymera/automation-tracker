import { useMemo, useState, type ReactNode } from 'react';
import {
  mutate,
  useApi,
  type Ability,
  type CypressScenario,
  type Feature,
  type FeatureCode,
  type FeatureData,
  type FeatureLink,
  type Framework,
  type PlaywrightTest,
} from '../api';
import { href } from '../router';
import { Empty, Loading, StateBadge, Tag } from './ui';

// Display IDs. The number is the database ID, so it stays when the title changes.
export const featureCode = (id: number) => `F-${id}`;
export const abilityCode = (id: number) => `A-${id}`;

const FW_LABEL: Record<Framework, string> = { playwright: 'Playwright', cypress: 'Cypress' };
const live = (ls: FeatureLink[], fw: Framework) => ls.filter((l) => l.framework === fw && !l.missing);

/** Runs a change and shows the error text if the API refuses it. */
async function act(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    alert(String((e as Error).message));
  }
}

export function FeaturesTab({ project, sel }: { project: string; sel: string | null }) {
  const base = `/api/projects/${project}`;
  const { data, error } = useApi<FeatureData>(`${base}/features`);
  const [query, setQuery] = useState('');
  const go = (s: string | null) => (location.hash = href({ project, tab: 'features', sel: s }));

  const shown = useMemo(() => {
    const q = query.toLowerCase();
    return (data?.features ?? []).filter(
      (f) =>
        !q ||
        [featureCode(f.id), f.title, f.description, ...f.tags, ...f.abilities.map((a) => a.title)].some((s) => s.toLowerCase().includes(q)),
    );
  }, [data, query]);

  if (!data) return <Loading error={error} />;
  const sections = [
    ...data.groups.map((g) => ({ key: `g:${g.id}`, title: g.title, items: shown.filter((f) => f.groupId === g.id) })),
    { key: null, title: 'No group', items: shown.filter((f) => f.groupId === null) },
  ];
  const feature = sel?.startsWith('f:') ? data.features.find((f) => f.id === Number(sel.slice(2))) : undefined;
  const group = sel?.startsWith('g:') ? data.groups.find((g) => g.id === Number(sel.slice(2))) : undefined;

  const newFeature = (groupId: number | null = null) => {
    const title = prompt('Feature title');
    if (title) act(async () => go(`f:${(await mutate<{ id: number }>('POST', `${base}/features`, { title, groupId })).id}`));
  };
  const newGroup = () => {
    const title = prompt('Group title');
    if (title) act(async () => go(`g:${(await mutate<{ id: number }>('POST', `${base}/groups`, { title })).id}`));
  };

  return (
    <div className="flex h-full">
      <aside className="flex w-[420px] shrink-0 flex-col border-r border-line bg-surface">
        <div className="space-y-2 border-b border-line p-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by title, tag, ability or ID…"
            className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-sm outline-none focus:border-accent"
          />
          <div className="flex items-center gap-2 text-xs">
            <span className="flex-1 text-ink-3">
              {shown.length} of {data.features.length} features
            </span>
            <Button onClick={() => newFeature()}>+ Feature</Button>
            <Button onClick={newGroup}>+ Group</Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1 text-[13px]">
          <SideItem active={sel === 'unlinked'} onClick={() => go('unlinked')} meta={`${data.unlinked.playwright + data.unlinked.cypress}`}>
            Tests with no feature
          </SideItem>
          {data.unknownTags.length > 0 && (
            <SideItem active={sel === 'tags'} onClick={() => go('tags')} meta={`${data.unknownTags.length}`}>
              Feature tags with no feature
            </SideItem>
          )}
          {sections.map((s) =>
            s.items.length === 0 && (query || s.key === null) ? null : (
              <div key={s.key ?? 'none'} className="mt-2">
                <button
                  type="button"
                  disabled={!s.key}
                  onClick={() => s.key && go(s.key)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs font-medium uppercase tracking-wide text-ink-3 ${s.key ? 'hover:bg-surface-2' : ''} ${sel === s.key ? 'bg-surface-2 ring-1 ring-accent/40' : ''}`}
                >
                  <span className="flex-1 truncate">{s.title}</span>
                  <span className="tabular-nums">{s.items.length}</span>
                </button>
                {s.items.map((f) => (
                  <SideItem key={f.id} active={sel === `f:${f.id}`} onClick={() => go(`f:${f.id}`)} meta={<Counts f={f} />}>
                    <span className="mr-1.5 font-mono text-[11px] text-ink-3">{featureCode(f.id)}</span>
                    {f.title}
                  </SideItem>
                ))}
              </div>
            ),
          )}
        </div>
      </aside>
      <section className="min-w-0 flex-1 overflow-auto">
        {feature ? (
          <FeatureDetail key={feature.id} project={project} f={feature} data={data} />
        ) : group ? (
          <GroupDetail key={group.id} project={project} g={group} data={data} onNewFeature={() => newFeature(group.id)} />
        ) : sel === 'unlinked' ? (
          <UnlinkedView project={project} data={data} />
        ) : sel === 'tags' ? (
          <UnknownTagsView project={project} data={data} />
        ) : (
          <Intro data={data} />
        )}
      </section>
    </div>
  );
}

function Counts({ f }: { f: Feature }) {
  const pw = live(f.links, 'playwright').length;
  const cy = live(f.links, 'cypress').length;
  return (
    <span className="text-xs tabular-nums text-ink-3" title={`${pw} Playwright tests, ${cy} Cypress scenarios`}>
      <span className={pw ? 'text-ink-2' : ''}>PW {pw}</span> · <span className={cy ? 'text-ink-2' : ''}>CY {cy}</span>
    </span>
  );
}

function SideItem({ active, onClick, meta, children }: { active: boolean; onClick: () => void; meta?: ReactNode; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded px-2 py-[3px] text-left hover:bg-surface-2 ${active ? 'bg-surface-2 ring-1 ring-accent/40' : ''}`}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {meta && <span className="shrink-0">{meta}</span>}
    </button>
  );
}

export function Button({ onClick, children, danger, disabled }: { onClick: () => void; children: ReactNode; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md border border-line bg-surface px-2 py-1 text-xs hover:bg-surface-2 disabled:opacity-50 ${danger ? 'text-bad' : ''}`}
    >
      {children}
    </button>
  );
}

/** Text that changes into an input on click. Saves on Enter or when focus leaves. */
function InlineText({ value, onSave, multiline, placeholder, className = '' }: { value: string; onSave: (v: string) => Promise<unknown>; multiline?: boolean; placeholder?: string; className?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    if (draft === null) return;
    const v = draft.trim();
    setDraft(null);
    if (v !== value) act(() => onSave(v));
  };
  if (draft === null) {
    return (
      <button type="button" onClick={() => setDraft(value)} className={`block w-full rounded text-left hover:bg-surface-2 ${className}`} title="Click to change">
        {value ? <span className={multiline ? 'whitespace-pre-line' : ''}>{value}</span> : <span className="text-ink-3">{placeholder}</span>}
      </button>
    );
  }
  const common = {
    autoFocus: true,
    value: draft,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: save,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') setDraft(null);
      if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        save();
      }
    },
    className: `w-full rounded border border-accent bg-bg px-1 outline-none ${className}`,
  };
  return multiline ? <textarea rows={4} {...common} /> : <input {...common} />;
}

function Section({ title, children, right }: { title: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <div className="flex-1 text-xs font-medium uppercase tracking-wide text-ink-3">{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}

function Intro({ data }: { data: FeatureData }) {
  const linked = (fw: Framework) => data.tests[fw] - data.unlinked[fw];
  return (
    <div className="max-w-2xl space-y-3 p-6 text-sm text-ink-2">
      <h2 className="text-lg font-semibold text-ink">Feature list</h2>
      <p>
        A feature is a thing the plugin does, in plain words. Each feature has abilities: the separate things a user can do with it. Tests link to a
        feature, and if possible to one ability.
      </p>
      <p>
        A test with the tag <code className="font-mono text-xs">@feature:&lt;name&gt;</code> links to the feature that owns that tag name. You can
        also link tests by hand.
      </p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          Playwright: {linked('playwright')} of {data.tests.playwright} tests link to a feature.
        </li>
        <li>
          Cypress: {linked('cypress')} of {data.tests.cypress} scenarios link to a feature.
        </li>
      </ul>
      <p>Select a feature on the left, or open “Tests with no feature” to link the rest.</p>
    </div>
  );
}

function GroupDetail({ project, g, data, onNewFeature }: { project: string; g: FeatureData['groups'][0]; data: FeatureData; onNewFeature: () => void }) {
  const url = `/api/projects/${project}/groups/${g.id}`;
  const features = data.features.filter((f) => f.groupId === g.id);
  return (
    <div className="max-w-3xl space-y-5 p-6">
      <div>
        <div className="font-mono text-xs text-ink-3">Group G-{g.id}</div>
        <InlineText value={g.title} onSave={(title) => mutate('PATCH', url, { title })} className="mt-1 text-lg font-semibold" />
        <InlineText value={g.description} multiline placeholder="Add a description" onSave={(description) => mutate('PATCH', url, { description })} className="mt-1 text-sm text-ink-2" />
      </div>
      <Section title={`Features (${features.length})`} right={<Button onClick={onNewFeature}>+ Feature in this group</Button>}>
        {features.length ? (
          <ul className="text-sm">
            {features.map((f) => (
              <li key={f.id} className="flex gap-2 border-t border-line py-1.5">
                <a href={href({ project, tab: 'features', sel: `f:${f.id}` })} className="flex-1 hover:underline">
                  <span className="mr-1.5 font-mono text-[11px] text-ink-3">{featureCode(f.id)}</span>
                  {f.title}
                </a>
                <Counts f={f} />
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-sm text-ink-3">No features yet. Open a feature and choose this group, or add a new one.</div>
        )}
      </Section>
      <Button danger onClick={() => confirm(`Delete group “${g.title}”? Its features stay, with no group.`) && act(() => mutate('DELETE', url))}>
        Delete group
      </Button>
    </div>
  );
}

function FeatureDetail({ project, f, data }: { project: string; f: Feature; data: FeatureData }) {
  const base = `/api/projects/${project}`;
  const url = `${base}/features/${f.id}`;
  const [tag, setTag] = useState('');
  const [ability, setAbility] = useState('');
  const [mergeFrom, setMergeFrom] = useState('');

  const byAbility = (id: number | null) => f.links.filter((l) => l.abilityId === id);
  const loose = byAbility(null);
  const counts = f.abilities.map((a) => ({ pw: live(byAbility(a.id), 'playwright').length, cy: live(byAbility(a.id), 'cypress').length }));

  return (
    <div className="max-w-4xl space-y-6 p-6">
      <div>
        <div className="font-mono text-xs text-ink-3">{featureCode(f.id)}</div>
        <InlineText value={f.title} onSave={(title) => mutate('PATCH', url, { title })} className="mt-1 text-lg font-semibold" />
        <InlineText
          value={f.description}
          multiline
          placeholder="Add a description: what the feature does, which settings and screens it uses"
          onSave={(description) => mutate('PATCH', url, { description })}
          className="mt-1 text-sm text-ink-2"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2 text-ink-2">
            Group
            <select
              value={f.groupId ?? ''}
              onChange={(e) => act(() => mutate('PATCH', url, { groupId: e.target.value ? Number(e.target.value) : null }))}
              className="rounded-md border border-line bg-bg px-2 py-1 text-sm"
            >
              <option value="">No group</option>
              {data.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
            </select>
          </label>
          <span className="text-ink-2">
            {live(f.links, 'playwright').length} Playwright tests · {live(f.links, 'cypress').length} Cypress scenarios
          </span>
        </div>
      </div>

      <Section title="Feature tags">
        <div className="flex flex-wrap items-center gap-1.5">
          {f.tags.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-2">
              @feature:{t}
              <button
                type="button"
                aria-label={`Remove tag ${t}`}
                onClick={() => act(() => mutate('DELETE', `${url}/tags/${encodeURIComponent(t)}`))}
                className="text-ink-3 hover:text-bad"
              >
                ×
              </button>
            </span>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (tag.trim()) act(async () => (await mutate('POST', `${url}/tags`, { tag }), setTag('')));
            }}
          >
            <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="add tag name" className="w-40 rounded border border-line bg-bg px-1.5 py-0.5 font-mono text-[11px] outline-none focus:border-accent" />
          </form>
        </div>
        <div className="mt-1 text-xs text-ink-3">Tests with one of these tags link to this feature automatically.</div>
      </Section>

      <Section title={`Abilities (${f.abilities.length})`}>
        {f.abilities.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-3 text-xs text-ink-2">
            <Pill tone="good">{counts.filter((c) => c.pw && c.cy).length} in both</Pill>
            <Pill tone="warn">{counts.filter((c) => c.pw && !c.cy).length} Playwright only</Pill>
            <Pill tone="warn">{counts.filter((c) => !c.pw && c.cy).length} Cypress only</Pill>
            <Pill tone="bad">{counts.filter((c) => !c.pw && !c.cy).length} not automated</Pill>
          </div>
        )}
        <div className="space-y-3">
          {f.abilities.map((a) => (
            <AbilityCard key={a.id} project={project} f={f} a={a} links={byAbility(a.id)} />
          ))}
        </div>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (ability.trim()) act(async () => (await mutate('POST', `${url}/abilities`, { title: ability }), setAbility('')));
          }}
        >
          <input
            value={ability}
            onChange={(e) => setAbility(e.target.value)}
            placeholder="New ability, for example: “Admin changes the price label and the shop shows it”"
            className="flex-1 rounded-md border border-line bg-bg px-2.5 py-1.5 text-sm outline-none focus:border-accent"
          />
          <Button onClick={() => ability.trim() && act(async () => (await mutate('POST', `${url}/abilities`, { title: ability }), setAbility('')))}>Add</Button>
        </form>
      </Section>

      <Section title={`Linked tests with no ability (${loose.length})`}>
        {loose.length ? <LinkTable project={project} f={f} links={loose} /> : <div className="text-sm text-ink-3">All linked tests have an ability.</div>}
      </Section>

      <Section title="Link a test">
        <TestPicker project={project} exclude={new Set(f.links.map((l) => l.testId))} onPick={(testId) => mutate('POST', `${base}/links`, { testId, featureId: f.id })} />
      </Section>

      <FeatureCodeView project={project} f={f} />

      <Section title="Other actions">
        <div className="flex flex-wrap items-center gap-2">
          <select value={mergeFrom} onChange={(e) => setMergeFrom(e.target.value)} className="max-w-xs rounded-md border border-line bg-bg px-2 py-1 text-sm">
            <option value="">Merge another feature into this one…</option>
            {data.features
              .filter((x) => x.id !== f.id)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {featureCode(x.id)} {x.title}
                </option>
              ))}
          </select>
          <Button
            disabled={!mergeFrom}
            onClick={() => {
              const other = data.features.find((x) => x.id === Number(mergeFrom));
              if (other && confirm(`Move the tags, abilities and links of “${other.title}” into “${f.title}”, then delete “${other.title}”?`))
                act(async () => (await mutate('POST', `${url}/merge`, { from: other.id }), setMergeFrom('')));
            }}
          >
            Merge
          </Button>
          <span className="flex-1" />
          <Button
            danger
            onClick={() =>
              confirm(`Delete feature “${f.title}” with its tags, abilities and links? The tests stay.`) &&
              act(async () => (await mutate('DELETE', url), (location.hash = href({ project, tab: 'features' }))))
            }
          >
            Delete feature
          </Button>
        </div>
      </Section>
    </div>
  );
}

function Pill({ tone, children }: { tone: 'good' | 'warn' | 'bad'; children: ReactNode }) {
  const icon = { good: '✓', warn: '◐', bad: '✕' }[tone];
  return (
    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5" style={{ background: `var(--${tone}-tint)` }}>
      <span style={{ color: `var(--${tone})` }} aria-hidden>
        {icon}
      </span>
      {children}
    </span>
  );
}

function AbilityCard({ project, f, a, links }: { project: string; f: Feature; a: Ability; links: FeatureLink[] }) {
  const url = `/api/projects/${project}/abilities/${a.id}`;
  const pw = live(links, 'playwright').length;
  const cy = live(links, 'cypress').length;
  const tone = pw && cy ? 'good' : pw || cy ? 'warn' : 'bad';
  const label = pw && cy ? 'In both' : pw ? 'Playwright only' : cy ? 'Cypress only' : 'Not automated';
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 font-mono text-[11px] text-ink-3">{abilityCode(a.id)}</span>
        <div className="min-w-0 flex-1">
          <InlineText value={a.title} onSave={(title) => mutate('PATCH', url, { title })} className="text-sm font-medium" />
          <InlineText value={a.description} multiline placeholder="Add details" onSave={(description) => mutate('PATCH', url, { description })} className="text-xs text-ink-2" />
        </div>
        <Pill tone={tone}>{label}</Pill>
        <button
          type="button"
          aria-label="Delete ability"
          title="Delete ability (its tests stay linked to the feature)"
          onClick={() => confirm(`Delete ability “${a.title}”? Its tests stay linked to the feature.`) && act(() => mutate('DELETE', url))}
          className="px-1 text-ink-3 hover:text-bad"
        >
          ×
        </button>
      </div>
      {links.length > 0 && <LinkTable project={project} f={f} links={links} className="mt-2" />}
    </div>
  );
}

/** Linked tests: framework, title, ability select, remove. */
function LinkTable({ project, f, links, className = '' }: { project: string; f: Feature; links: FeatureLink[]; className?: string }) {
  const base = `/api/projects/${project}`;
  return (
    <table className={`w-full table-fixed text-sm ${className}`}>
      <tbody>
        {links.map((l) => (
          <tr key={l.id} className="border-t border-line">
            <td className="w-24 py-1 pr-2 text-xs text-ink-3">{FW_LABEL[l.framework]}</td>
            <td className="py-1 pr-2">
              {l.missing ? (
                <span className="text-ink-3" title="This test is not in the repo now. It was deleted or renamed. Link the new test and remove this link.">
                  <span style={{ color: 'var(--warn)' }}>⚠</span> {l.title ?? l.testId} <span className="text-xs">(not in repo now)</span>
                </span>
              ) : (
                <a href={href({ project, tab: l.framework, sel: l.testId })} className="hover:underline">
                  {l.title}
                </a>
              )}
              <div className="truncate font-mono text-[11px] text-ink-3">
                {l.testId} · {l.file} {l.source === 'tag' && '· from tag'}
              </div>
            </td>
            <td className="w-48 py-1 pr-2">
              <select
                value={l.abilityId ?? ''}
                onChange={(e) => act(() => mutate('PATCH', `${base}/links/${l.id}`, { abilityId: e.target.value ? Number(e.target.value) : null }))}
                className="w-full rounded border border-line bg-bg px-1 py-0.5 text-xs"
              >
                <option value="">No ability</option>
                {f.abilities.map((a) => (
                  <option key={a.id} value={a.id}>
                    {abilityCode(a.id)} {a.title}
                  </option>
                ))}
              </select>
            </td>
            <td className="w-6 py-1 text-right">
              <button type="button" aria-label="Remove link" title="Remove link" onClick={() => act(() => mutate('DELETE', `${base}/links/${l.id}`))} className="text-ink-3 hover:text-bad">
                ×
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface AnyTest {
  id: string;
  framework: Framework;
  title: string;
  file: string;
  tags: string[];
  context: string;
}

function useAllTests(project: string): AnyTest[] | null {
  const pw = useApi<PlaywrightTest[]>(`/api/projects/${project}/playwright`).data;
  const cy = useApi<CypressScenario[]>(`/api/projects/${project}/cypress`).data;
  return useMemo(
    () =>
      pw && cy
        ? [
            ...pw.map((t) => ({ id: t.id, framework: 'playwright' as const, title: t.title, file: t.file, tags: t.tags, context: t.describes.join(' › ') })),
            ...cy.map((s) => ({ id: s.id, framework: 'cypress' as const, title: s.title, file: s.file, tags: s.tags, context: s.feature })),
          ]
        : null,
    [pw, cy],
  );
}

const matches = (t: AnyTest, q: string) => !q || [t.id, t.title, t.file, t.context, ...t.tags].some((s) => s.toLowerCase().includes(q));

/** Search box over all Playwright tests and Cypress scenarios. */
function TestPicker({ project, exclude, onPick }: { project: string; exclude: Set<string>; onPick: (testId: string) => Promise<unknown> }) {
  const all = useAllTests(project);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const hits = q.length < 2 ? [] : (all ?? []).filter((t) => !exclude.has(t.id) && matches(t, q)).slice(0, 30);
  return (
    <div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search tests by title, file, tag or ID (2+ letters)…"
        className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-sm outline-none focus:border-accent"
      />
      {hits.length > 0 && (
        <ul className="mt-1 max-h-72 overflow-auto rounded-md border border-line text-sm">
          {hits.map((t) => (
            <li key={t.id} className="flex items-center gap-2 border-t border-line px-2 py-1 first:border-t-0">
              <span className="w-20 shrink-0 text-xs text-ink-3">{FW_LABEL[t.framework]}</span>
              <span className="min-w-0 flex-1">
                <div className="truncate">{t.title}</div>
                <div className="truncate font-mono text-[11px] text-ink-3">
                  {t.id} · {t.file}
                </div>
              </span>
              <Button onClick={() => act(() => onPick(t.id))}>Link</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Tests that link to no feature, with a select to link each one. */
function UnlinkedView({ project, data }: { project: string; data: FeatureData }) {
  const all = useAllTests(project);
  const [fw, setFw] = useState<Framework | 'all'>('all');
  const [query, setQuery] = useState('');
  if (!all) return <Loading />;
  const linked = new Set(data.features.flatMap((f) => f.links.map((l) => l.testId)));
  const q = query.trim().toLowerCase();
  const list = all.filter((t) => !linked.has(t.id) && (fw === 'all' || t.framework === fw) && matches(t, q));
  const sorted = [...data.features].sort((a, b) => a.title.localeCompare(b.title));
  return (
    <div className="max-w-5xl space-y-3 p-6">
      <h2 className="text-lg font-semibold">Tests with no feature</h2>
      <p className="text-sm text-ink-2">
        {data.unlinked.playwright} Playwright tests and {data.unlinked.cypress} Cypress scenarios link to no feature. Choose a feature for each one,
        or add a feature tag to the test in the repo.
      </p>
      <div className="flex gap-2">
        <select value={fw} onChange={(e) => setFw(e.target.value as Framework | 'all')} className="rounded-md border border-line bg-bg px-2 py-1 text-sm">
          <option value="all">Playwright and Cypress</option>
          <option value="playwright">Playwright</option>
          <option value="cypress">Cypress</option>
        </select>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter…" className="flex-1 rounded-md border border-line bg-bg px-2.5 py-1 text-sm outline-none focus:border-accent" />
      </div>
      {list.length === 0 ? (
        <Empty>No tests here.</Empty>
      ) : (
        <table className="w-full table-fixed text-sm">
          <tbody>
            {list.map((t) => (
              <tr key={t.id} className="border-t border-line align-top">
                <td className="w-24 py-1.5 pr-2 text-xs text-ink-3">{FW_LABEL[t.framework]}</td>
                <td className="py-1.5 pr-2">
                  <a href={href({ project, tab: t.framework, sel: t.id })} className="hover:underline">
                    {t.title}
                  </a>
                  <div className="truncate font-mono text-[11px] text-ink-3">
                    {t.id} · {t.file}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {t.tags.slice(0, 6).map((x) => (
                      <Tag key={x}>{x}</Tag>
                    ))}
                  </div>
                </td>
                <td className="w-64 py-1.5">
                  <select
                    value=""
                    onChange={(e) => e.target.value && act(() => mutate('POST', `/api/projects/${project}/links`, { testId: t.id, featureId: Number(e.target.value) }))}
                    className="w-full rounded border border-line bg-bg px-1 py-0.5 text-xs"
                  >
                    <option value="">Link to feature…</option>
                    {sorted.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.title} ({featureCode(f.id)})
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Feature tags in tests that no feature owns: make a feature, or add the tag to one. */
function UnknownTagsView({ project, data }: { project: string; data: FeatureData }) {
  const base = `/api/projects/${project}`;
  return (
    <div className="max-w-4xl space-y-3 p-6">
      <h2 className="text-lg font-semibold">Feature tags with no feature</h2>
      <p className="text-sm text-ink-2">These tags are in tests, but no feature owns them. Make a new feature from a tag, or add the tag to a feature you have.</p>
      <table className="w-full text-sm">
        <tbody>
          {data.unknownTags.map((t) => (
            <tr key={t.tag} className="border-t border-line">
              <td className="py-1.5 pr-2 font-mono text-xs">@feature:{t.tag}</td>
              <td className="py-1.5 pr-2 text-xs text-ink-2">
                {t.playwright} Playwright · {t.cypress} Cypress
              </td>
              <td className="py-1.5 pr-2">
                <Button onClick={() => act(() => mutate('POST', `${base}/features`, { title: t.tag.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase()), tag: t.tag }))}>
                  New feature
                </Button>
              </td>
              <td className="w-56 py-1.5">
                <select value="" onChange={(e) => e.target.value && act(() => mutate('POST', `${base}/features/${e.target.value}/tags`, { tag: t.tag }))} className="w-full rounded border border-line bg-bg px-1 py-0.5 text-xs">
                  <option value="">Add to feature…</option>
                  {data.features.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.title} ({featureCode(f.id)})
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** PHP functions that the feature's Playwright tests ran in the coverage run. */
function FeatureCodeView({ project, f }: { project: string; f: Feature }) {
  const { data } = useApi<FeatureCode>(`/api/projects/${project}/features/${f.id}/code`);
  const pwCount = live(f.links, 'playwright').length;
  const byFile = useMemo(() => {
    const m = new Map<string, FeatureCode['functions']>();
    for (const fn of data?.functions ?? []) m.set(fn.file, [...(m.get(fn.file) ?? []), fn]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data]);
  return (
    <Section title={`Code run by this feature’s Playwright tests${data ? ` (${data.functions.length} functions)` : ''}`}>
      {!pwCount ? (
        <div className="text-sm text-ink-3">No Playwright test links to this feature, so the coverage run cannot show its code. Cypress has no coverage run yet.</div>
      ) : !data ? (
        <div className="text-sm text-ink-3">Loading…</div>
      ) : data.linkedRunTests === 0 ? (
        <div className="text-sm text-ink-3">The linked Playwright tests were not in the coverage run.</div>
      ) : (
        <div className="space-y-2 text-sm">
          <div className="text-xs text-ink-3">Library functions are not in this list. They run on every request, so they say nothing about one feature.</div>
          {byFile.map(([file, fns]) => (
            <div key={file}>
              <a href={href({ project, tab: 'code', sel: file })} className="font-mono text-xs hover:underline">
                {file}
              </a>
              <ul className="ml-3">
                {fns.map((fn) => (
                  <li key={fn.name + fn.start} className="flex items-center gap-2 py-0.5">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">
                      {fn.name} <span className="text-ink-3">:{fn.start}</span>
                    </span>
                    <span className="text-xs text-ink-3">{fn.tests.length === 1 ? '1 test' : `${fn.tests.length} tests`}</span>
                    <StateBadge state={fn.state} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

/** For the Playwright and Cypress tabs: the features this test links to, and a select to add one. */
export function TestFeatures({ project, testId }: { project: string; testId: string }) {
  const { data } = useApi<FeatureData>(`/api/projects/${project}/features`);
  if (!data) return null;
  const mine = data.features.flatMap((f) => f.links.filter((l) => l.testId === testId).map((l) => ({ f, l })));
  const base = `/api/projects/${project}`;
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-3">Features</div>
      {mine.length ? (
        <ul className="space-y-1 text-sm">
          {mine.map(({ f, l }) => (
            <li key={l.id} className="flex items-center gap-2">
              <a href={href({ project, tab: 'features', sel: `f:${f.id}` })} className="hover:underline">
                <span className="mr-1.5 font-mono text-[11px] text-ink-3">{featureCode(f.id)}</span>
                {f.title}
              </a>
              {l.abilityId && <span className="text-xs text-ink-2">› {f.abilities.find((a) => a.id === l.abilityId)?.title}</span>}
              {l.source === 'tag' && <span className="text-xs text-ink-3">(from tag)</span>}
              <button type="button" aria-label="Remove link" onClick={() => act(() => mutate('DELETE', `${base}/links/${l.id}`))} className="text-ink-3 hover:text-bad">
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-sm text-ink-3">This test links to no feature.</div>
      )}
      <select
        value=""
        onChange={(e) => e.target.value && act(() => mutate('POST', `${base}/links`, { testId, featureId: Number(e.target.value) }))}
        className="mt-2 rounded border border-line bg-bg px-1 py-0.5 text-xs"
      >
        <option value="">Link to feature…</option>
        {[...data.features]
          .sort((a, b) => a.title.localeCompare(b.title))
          .filter((f) => !mine.some((m) => m.f.id === f.id))
          .map((f) => (
            <option key={f.id} value={f.id}>
              {f.title} ({featureCode(f.id)})
            </option>
          ))}
      </select>
    </div>
  );
}
