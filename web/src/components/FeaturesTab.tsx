import { useMemo, useState, type ReactNode } from 'react';
import {
  ITEM_KIND,
  LABEL_KIND,
  mutate,
  useApi,
  type CypressScenario,
  type Feature,
  type FeatureCode,
  type FeatureData,
  type FeatureItem,
  type FeatureLink,
  type Framework,
  type ItemField,
  type LabelField,
  type PlaywrightTest,
  type Scope,
} from '../api';
import { href } from '../router';
import { Empty, Loading, StateBadge, Tag } from './ui';

// Display IDs. The number is the database ID, so it stays when the title changes.
export const featureCode = (id: number) => `F-${id}`;
export const scopeCode = (id: number) => `S-${id}`;

const FW_LABEL: Record<Framework, string> = {
  playwright: 'Playwright',
  cypress: 'Cypress',
};
const live = (ls: FeatureLink[], fw: Framework) => ls.filter((l) => l.framework === fw && !l.missing);
const ITEM_FIELDS: ItemField[] = ['rules', 'outOfScope', 'where', 'questions'];
/** True when the skill wrote something in the feature that no person checked yet. */
const aiLink = (l: FeatureLink) => l.source === 'ai' && !l.checked;
const needsReview = (f: Feature) =>
  f.aiDraft || f.scopes.some((s) => s.aiDraft) || ITEM_FIELDS.some((k) => f[k].some((i) => i.aiDraft)) || f.links.some(aiLink);

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
        !q || [featureCode(f.id), f.title, f.description, ...f.roles, ...f.needs, ...f.scopes.map((s) => s.title)].some((s) => s.toLowerCase().includes(q)),
    );
  }, [data, query]);

  if (!data) return <Loading error={error} />;
  const sections = [
    ...data.groups.map((g) => ({
      key: `g:${g.id}`,
      title: g.title,
      items: shown.filter((f) => f.groupId === g.id),
    })),
    {
      key: null,
      title: 'No group',
      items: shown.filter((f) => f.groupId === null),
    },
  ];
  const feature = sel?.startsWith('f:') ? data.features.find((f) => f.id === Number(sel.slice(2))) : undefined;
  const group = sel?.startsWith('g:') ? data.groups.find((g) => g.id === Number(sel.slice(2))) : undefined;
  const toReview = data.features.filter(needsReview).length;

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
            placeholder="Filter by title, role, scope or ID…"
            className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-sm outline-none focus:border-accent"
          />
          <div className="flex items-center gap-2 text-xs">
            <span className="flex-1 text-ink-3">
              {shown.length} of {data.features.length} features
              {toReview > 0 && <> · {toReview} to check</>}
            </span>
            <Button onClick={() => newFeature()}>+ Feature</Button>
            <Button onClick={newGroup}>+ Group</Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1 text-[13px]">
          <SideItem active={sel === 'unlinked'} onClick={() => go('unlinked')} meta={`${data.unlinked.playwright + data.unlinked.cypress}`}>
            Tests with no feature
          </SideItem>
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
                    {needsReview(f) && <AiBadge />}
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

/** Marks text that the feature-mapping skill wrote and no person checked yet. */
function AiBadge({ title = 'Written by the AI skill. Not checked by a person yet.' }: { title?: string }) {
  return (
    <span title={title} className="ml-1.5 shrink-0 rounded px-1 py-px text-[10px] font-medium" style={{ background: 'var(--warn-tint)', color: 'var(--warn)' }}>
      AI draft
    </span>
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
function InlineText({
  value,
  onSave,
  multiline,
  placeholder,
  className = '',
}: {
  value: string;
  onSave: (v: string) => Promise<unknown>;
  multiline?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    if (draft === null) return;
    const v = draft.trim();
    setDraft(null);
    if (v !== value) act(() => onSave(v));
  };
  if (draft === null) {
    return (
      <button
        type="button"
        onClick={() => setDraft(value)}
        className={`block w-full rounded text-left hover:bg-surface-2 ${className}`}
        title="Click to change"
      >
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

const SUGGEST_MAX = 8;

/**
 * Labels as chips, with an input that suggests the values the project uses
 * (most used first, at most SUGGEST_MAX). A value that is on no feature is gone.
 */
function LabelInput({
  values,
  suggestions,
  onAdd,
  onRemove,
  placeholder,
}: {
  values: string[];
  suggestions: { value: string; count: number }[];
  onAdd: (v: string) => Promise<unknown>;
  onRemove: (v: string) => Promise<unknown>;
  placeholder: string;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const typed = q.trim();
  const have = new Set(values.map((v) => v.toLowerCase()));
  const hits = suggestions.filter((s) => !have.has(s.value.toLowerCase()) && s.value.toLowerCase().includes(typed.toLowerCase())).slice(0, SUGGEST_MAX);
  const exact = suggestions.some((s) => s.value.toLowerCase() === typed.toLowerCase()) || have.has(typed.toLowerCase());
  const options = [
    ...hits.map((h) => ({
      value: h.value,
      label: h.value,
      count: h.count as number | null,
    })),
    ...(typed && !exact ? [{ value: typed, label: `Add “${typed}”`, count: null }] : []),
  ];
  const add = (v: string) => {
    setQ('');
    setActive(0);
    act(() => onAdd(v));
  };
  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-1.5">
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-ink-2">
            {v}
            <button type="button" aria-label={`Remove ${v}`} onClick={() => act(() => onRemove(v))} className="text-ink-3 hover:text-bad">
              ×
            </button>
          </span>
        ))}
        <input
          value={q}
          onChange={(e) => (setQ(e.target.value), setActive(0), setOpen(true))}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(a + 1, options.length - 1)));
            if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
            if (e.key === 'Escape') setOpen(false);
            if (e.key === 'Enter') {
              e.preventDefault();
              const o = options[active];
              if (o) add(o.value);
            }
          }}
          placeholder={placeholder}
          className="w-44 rounded border border-line bg-bg px-1.5 py-0.5 text-xs outline-none focus:border-accent"
        />
      </div>
      {open && options.length > 0 && (
        <ul className="absolute z-10 mt-1 w-72 overflow-hidden rounded-md border border-line bg-surface text-xs shadow-lg">
          {options.map((o, i) => (
            <li key={o.label}>
              <button
                type="button"
                onMouseDown={(e) => (e.preventDefault(), add(o.value))}
                onMouseEnter={() => setActive(i)}
                className={`flex w-full items-center gap-2 px-2 py-1 text-left ${i === active ? 'bg-surface-2' : ''}`}
              >
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.count !== null && <span className="text-ink-3">{o.count === 1 ? '1 feature' : `${o.count} features`}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A list of sentences: each one can change or go, and a new one can be added. */
function ItemList({ project, f, field, placeholder }: { project: string; f: Feature; field: ItemField; placeholder: string }) {
  const base = `/api/projects/${project}`;
  const [draft, setDraft] = useState('');
  const items: FeatureItem[] = f[field];
  const add = () => {
    const text = draft.trim();
    if (!text) return;
    // Clear the box at once, so Enter and then a blur cannot send the same item two times.
    setDraft('');
    act(() => mutate('POST', `${base}/features/${f.id}/items`, { kind: ITEM_KIND[field], text }).catch((e) => (setDraft(text), Promise.reject(e))));
  };

  return (
    <div>
      {items.length > 0 && (
        <ul className="space-y-0.5">
          {items.map((i) => (
            <li key={i.id} className="flex items-start gap-1.5">
              <span className="pt-0.5 text-ink-3" aria-hidden>
                •
              </span>
              <div className="min-w-0 flex-1">
                <InlineText
                  value={i.text}
                  multiline
                  onSave={(text) => (text ? mutate('PATCH', `${base}/items/${i.id}`, { text }) : mutate('DELETE', `${base}/items/${i.id}`))}
                  className="text-ink-2"
                />
              </div>
              {i.aiDraft && (
                <button type="button" onClick={() => act(() => mutate('PATCH', `${base}/items/${i.id}`, { check: true }))}>
                  <AiBadge title="Written by the AI skill. Click to mark as checked." />
                </button>
              )}
              <button
                type="button"
                aria-label="Remove"
                title="Remove"
                onClick={() => act(() => mutate('DELETE', `${base}/items/${i.id}`))}
                className="px-1 text-ink-3 hover:text-bad"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(e) => (e.preventDefault(), add())}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={add}
          placeholder={placeholder}
          className="mt-0.5 w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-ink-3 hover:border-line focus:border-accent focus:bg-bg"
        />
      </form>
    </div>
  );
}

function Intro({ data }: { data: FeatureData }) {
  const linked = (fw: Framework) => data.tests[fw] - data.unlinked[fw];
  return (
    <div className="max-w-2xl space-y-3 p-6 text-sm text-ink-2">
      <h2 className="text-lg font-semibold text-ink">Feature list</h2>
      <p>
        A feature is a thing the plugin does, in plain words. Its scope is the list of separate things it does, like the scenarios of a test. Each test links to
        the scopes it checks.
      </p>
      <p>People link tests here, and the AI skill map-features links them too. Tags in the tests do not make links.</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          Playwright: {linked('playwright')} of {data.tests.playwright} tests link to a feature.
        </li>
        <li>
          Cypress: {linked('cypress')} of {data.tests.cypress} scenarios link to a feature.
        </li>
      </ul>
      {data.processed.length > 0 && (
        <p>
          The AI skill processed:{' '}
          {data.processed
            .map((u) => `${u.count} ${u.kind === 'code' ? 'code areas' : `${FW_LABEL[u.kind as Framework] ?? u.kind} files`} (${u.status})`)
            .join(', ')}
          . What it wrote shows “AI draft” until you check it.
        </p>
      )}
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
        <InlineText
          value={g.description}
          multiline
          placeholder="Add a description"
          onSave={(description) => mutate('PATCH', url, { description })}
          className="mt-1 text-sm text-ink-2"
        />
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

/** Feature fields, in the order the page shows them. */
const FIELDS: ({ kind: 'label'; key: LabelField; label: string; hint: string } | { kind: 'items'; key: ItemField; label: string; hint: string })[] = [
  { kind: 'label', key: 'roles', label: 'User roles', hint: '+ role' },
  { kind: 'label', key: 'needs', label: 'Needs', hint: '+ setting, plugin…' },
  {
    kind: 'items',
    key: 'where',
    label: 'Where',
    hint: '+ add a screen, settings page or shop page',
  },
  {
    kind: 'items',
    key: 'rules',
    label: 'Rules',
    hint: '+ add a rule the feature must follow',
  },
  {
    kind: 'items',
    key: 'outOfScope',
    label: 'Out of scope',
    hint: '+ add a thing this feature does not do',
  },
  {
    kind: 'items',
    key: 'questions',
    label: 'Open questions',
    hint: '+ add a question to confirm with the team',
  },
];

function FeatureDetail({ project, f, data }: { project: string; f: Feature; data: FeatureData }) {
  const base = `/api/projects/${project}`;
  const url = `${base}/features/${f.id}`;
  const [scope, setScope] = useState('');
  const [mergeFrom, setMergeFrom] = useState('');

  const byScope = (id: number) => f.links.filter((l) => l.scopeIds.includes(id));
  const loose = f.links.filter((l) => l.scopeIds.length === 0);
  const counts = f.scopes.map((s) => ({
    pw: live(byScope(s.id), 'playwright').length,
    cy: live(byScope(s.id), 'cypress').length,
  }));
  const addScope = () => scope.trim() && act(async () => (await mutate('POST', `${url}/scopes`, { title: scope }), setScope('')));

  return (
    <div className="max-w-4xl space-y-6 p-6">
      <div>
        <div className="flex items-center gap-2 font-mono text-xs text-ink-3">
          {featureCode(f.id)}
          {needsReview(f) && (
            <>
              <AiBadge />
              <Button onClick={() => act(() => mutate('POST', `${url}/check`, {}))}>Mark as checked</Button>
            </>
          )}
        </div>
        <InlineText value={f.title} onSave={(title) => mutate('PATCH', url, { title })} className="mt-1 text-lg font-semibold" />
        <InlineText
          value={f.description}
          multiline
          placeholder="Add a description: what the feature does, and why a store owner uses it"
          onSave={(description) => mutate('PATCH', url, { description })}
          className="mt-1 text-sm text-ink-2"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2 text-ink-2">
            Group
            <select
              value={f.groupId ?? ''}
              onChange={(e) =>
                act(() =>
                  mutate('PATCH', url, {
                    groupId: e.target.value ? Number(e.target.value) : null,
                  }),
                )
              }
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
          <label className="flex items-center gap-2 text-ink-2">
            Priority
            <select
              value={f.priority}
              onChange={(e) => act(() => mutate('PATCH', url, { priority: e.target.value }))}
              className="rounded-md border border-line bg-bg px-2 py-1 text-sm"
            >
              <option value="">Not set</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </label>
          <span className="text-ink-2">
            {live(f.links, 'playwright').length} Playwright tests · {live(f.links, 'cypress').length} Cypress scenarios
          </span>
        </div>
        <dl className="mt-4 grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2 text-sm">
          {FIELDS.map((fd) => (
            <div key={fd.key} className="contents">
              <dt className="pt-1 text-xs text-ink-3">{fd.label}</dt>
              <dd className="min-w-0">
                {fd.kind === 'label' ? (
                  <LabelInput
                    values={f[fd.key]}
                    suggestions={data.labels[fd.key]}
                    placeholder={fd.hint}
                    onAdd={(value) =>
                      mutate('POST', `${url}/labels`, {
                        kind: LABEL_KIND[fd.key],
                        value,
                      })
                    }
                    onRemove={(value) => mutate('DELETE', `${url}/labels/${LABEL_KIND[fd.key]}/${encodeURIComponent(value)}`)}
                  />
                ) : (
                  <ItemList project={project} f={f} field={fd.key} placeholder={fd.hint} />
                )}
              </dd>
            </div>
          ))}
        </dl>
        {needsReview(f) && (
          <div className="mt-2 text-xs text-ink-3">
            A change you make to a text also marks it as checked. The AI skill does not change or remove text that a person checked.
          </div>
        )}
      </div>

      <Section title={`Scope (${f.scopes.length})`}>
        {f.scopes.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-3 text-xs text-ink-2">
            <Pill tone="good">{counts.filter((c) => c.pw && c.cy).length} in both</Pill>
            <Pill tone="warn">{counts.filter((c) => c.pw && !c.cy).length} Playwright only</Pill>
            <Pill tone="warn">{counts.filter((c) => !c.pw && c.cy).length} Cypress only</Pill>
            <Pill tone="bad">{counts.filter((c) => !c.pw && !c.cy).length} not automated</Pill>
          </div>
        )}
        <div className="space-y-3">
          {f.scopes.map((s) => (
            <ScopeCard key={s.id} project={project} f={f} s={s} links={byScope(s.id)} />
          ))}
        </div>
        <form className="mt-3 flex gap-2" onSubmit={(e) => (e.preventDefault(), addScope())}>
          <input
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            placeholder="New scope, for example: “Admin changes the price label and the shop shows it”"
            className="flex-1 rounded-md border border-line bg-bg px-2.5 py-1.5 text-sm outline-none focus:border-accent"
          />
          <Button onClick={addScope}>Add</Button>
        </form>
      </Section>

      <Section title={`Linked tests with no scope (${loose.length})`}>
        {loose.length ? (
          <>
            <div className="mb-1 text-xs text-ink-3">Add the scopes each test checks, so the scope list shows what is automated.</div>
            <LinkTable project={project} f={f} links={loose} />
          </>
        ) : (
          <div className="text-sm text-ink-3">All linked tests have a scope.</div>
        )}
      </Section>

      <Section title="Link a test to the feature only">
        <TestPicker
          project={project}
          exclude={new Set(f.links.map((l) => l.testId))}
          onPick={(testId) => mutate('POST', `${base}/links`, { testId, featureId: f.id })}
        />
        <div className="mt-1 text-xs text-ink-3">
          Use this for a test that checks the feature in general. To link a test to a scope, use “+ Link a test” on the scope.
        </div>
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
              if (other && confirm(`Move the lists, scopes and links of “${other.title}” into “${f.title}”, then delete “${other.title}”?`))
                act(async () => (await mutate('POST', `${url}/merge`, { from: other.id }), setMergeFrom('')));
            }}
          >
            Merge
          </Button>
          <span className="flex-1" />
          <Button
            danger
            onClick={() =>
              confirm(`Delete feature “${f.title}” with its scope and links? The tests stay.`) &&
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

/** One scope: its text, its automation state, its linked tests, and a picker to link one more. */
function ScopeCard({ project, f, s, links }: { project: string; f: Feature; s: Scope; links: FeatureLink[] }) {
  const base = `/api/projects/${project}`;
  const url = `${base}/scopes/${s.id}`;
  const [picking, setPicking] = useState(false);
  const pw = live(links, 'playwright').length;
  const cy = live(links, 'cypress').length;
  const tone = pw && cy ? 'good' : pw || cy ? 'warn' : 'bad';
  const label = pw && cy ? 'In both' : pw ? 'Playwright only' : cy ? 'Cypress only' : 'Not automated';
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 font-mono text-[11px] text-ink-3">{scopeCode(s.id)}</span>
        {s.aiDraft && (
          <button type="button" onClick={() => act(() => mutate('PATCH', url, { check: true }))} className="mt-0.5">
            <AiBadge title="Written by the AI skill. Click to mark as checked." />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <InlineText value={s.title} onSave={(title) => mutate('PATCH', url, { title })} className="text-sm font-medium" />
          <InlineText
            value={s.description}
            multiline
            placeholder="Add details"
            onSave={(description) => mutate('PATCH', url, { description })}
            className="text-xs text-ink-2"
          />
        </div>
        <Pill tone={tone}>{label}</Pill>
        <button
          type="button"
          aria-label="Delete scope"
          title="Delete scope (its tests stay linked to the feature)"
          onClick={() => confirm(`Delete scope “${s.title}”? Its tests stay linked to the feature.`) && act(() => mutate('DELETE', url))}
          className="px-1 text-ink-3 hover:text-bad"
        >
          ×
        </button>
      </div>
      {links.length > 0 && <LinkTable project={project} f={f} links={links} className="mt-2" />}
      <div className="mt-2">
        {picking ? (
          <div className="space-y-1">
            <TestPicker
              project={project}
              autoFocus
              exclude={new Set(links.map((l) => l.testId))}
              onPick={(testId) => mutate('POST', `${base}/links`, { testId, scopeId: s.id })}
            />
            <Button onClick={() => setPicking(false)}>Done</Button>
          </div>
        ) : (
          <Button onClick={() => setPicking(true)}>+ Link a test</Button>
        )}
      </div>
    </div>
  );
}

/** Linked tests: framework, title, scopes, remove. */
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
                {l.testId} · {l.file} {aiLink(l) && '· linked by AI'}
              </div>
            </td>
            <td className="w-56 py-1 pr-2">
              <LinkScopes project={project} f={f} l={l} />
            </td>
            <td className="w-6 py-1 text-right">
              <button
                type="button"
                aria-label="Remove link"
                title="Remove link"
                onClick={() => act(() => mutate('DELETE', `${base}/links/${l.id}`))}
                className="text-ink-3 hover:text-bad"
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

/** The scopes of one link: a chip for each, with remove, and a select to add one. */
function LinkScopes({ project, f, l, withTitles }: { project: string; f: Feature; l: FeatureLink; withTitles?: boolean }) {
  const url = `/api/projects/${project}/links/${l.id}`;
  const save = (scopeIds: number[]) => act(() => mutate('PATCH', url, { scopeIds }));
  const rest = f.scopes.filter((s) => !l.scopeIds.includes(s.id));
  return (
    <div className="flex flex-wrap items-center gap-1">
      {l.scopeIds.map((id) => (
        <span
          key={id}
          title={f.scopes.find((s) => s.id === id)?.title}
          className="inline-flex items-center gap-0.5 rounded bg-surface-2 px-1 py-px font-mono text-[11px] text-ink-2"
        >
          {scopeCode(id)}
          {withTitles && <span className="font-sans">{f.scopes.find((s) => s.id === id)?.title}</span>}
          <button
            type="button"
            aria-label={`Remove scope ${scopeCode(id)}`}
            onClick={() => save(l.scopeIds.filter((x) => x !== id))}
            className="text-ink-3 hover:text-bad"
          >
            ×
          </button>
        </span>
      ))}
      {rest.length > 0 && (
        <select
          value=""
          aria-label="Add a scope to this link"
          onChange={(e) => e.target.value && save([...l.scopeIds, Number(e.target.value)])}
          className="min-w-0 flex-1 rounded border border-line bg-bg px-1 py-0.5 text-xs"
        >
          <option value="">{l.scopeIds.length ? '+ scope' : 'No scope: add…'}</option>
          {rest.map((s) => (
            <option key={s.id} value={s.id}>
              {scopeCode(s.id)} {s.title}
            </option>
          ))}
        </select>
      )}
    </div>
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
            ...pw.map((t) => ({
              id: t.id,
              framework: 'playwright' as const,
              title: t.title,
              file: t.file,
              tags: t.tags,
              context: t.describes.join(' › '),
            })),
            ...cy.map((s) => ({
              id: s.id,
              framework: 'cypress' as const,
              title: s.title,
              file: s.file,
              tags: s.tags,
              context: s.feature,
            })),
          ]
        : null,
    [pw, cy],
  );
}

const matches = (t: AnyTest, q: string) => !q || [t.id, t.title, t.file, t.context, ...t.tags].some((s) => s.toLowerCase().includes(q));

/** Search box over all Playwright tests and Cypress scenarios. */
function TestPicker({
  project,
  exclude,
  onPick,
  autoFocus,
}: {
  project: string;
  exclude: Set<string>;
  onPick: (testId: string) => Promise<unknown>;
  autoFocus?: boolean;
}) {
  const all = useAllTests(project);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const hits = q.length < 2 ? [] : (all ?? []).filter((t) => !exclude.has(t.id) && matches(t, q)).slice(0, 30);
  return (
    <div>
      <input
        value={query}
        autoFocus={autoFocus}
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
        {data.unlinked.playwright} Playwright tests and {data.unlinked.cypress} Cypress scenarios link to no feature. Choose a scope (or a feature) for each
        one, or let the AI skill map-features do it.
      </p>
      <div className="flex gap-2">
        <select value={fw} onChange={(e) => setFw(e.target.value as Framework | 'all')} className="rounded-md border border-line bg-bg px-2 py-1 text-sm">
          <option value="all">Playwright and Cypress</option>
          <option value="playwright">Playwright</option>
          <option value="cypress">Cypress</option>
        </select>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter…"
          className="flex-1 rounded-md border border-line bg-bg px-2.5 py-1 text-sm outline-none focus:border-accent"
        />
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
                <td className="w-72 py-1.5">
                  <ScopeSelect project={project} features={sorted} testId={t.id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** One select with every scope, grouped by feature, plus a "feature only" choice for each feature. */
function ScopeSelect({ project, features, testId }: { project: string; features: Feature[]; testId: string }) {
  return (
    <select
      value=""
      onChange={(e) => {
        const [kind, id] = e.target.value.split(':');
        if (id) act(() => mutate('POST', `/api/projects/${project}/links`, kind === 's' ? { testId, scopeId: Number(id) } : { testId, featureId: Number(id) }));
      }}
      className="w-full rounded border border-line bg-bg px-1 py-0.5 text-xs"
    >
      <option value="">Link to a scope…</option>
      {features.map((f) => (
        <optgroup key={f.id} label={`${featureCode(f.id)} ${f.title}`}>
          {f.scopes.map((s) => (
            <option key={s.id} value={`s:${s.id}`}>
              {scopeCode(s.id)} {s.title}
            </option>
          ))}
          <option value={`f:${f.id}`}>{featureCode(f.id)} (feature only, no scope)</option>
        </optgroup>
      ))}
    </select>
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
        <div className="text-sm text-ink-3">
          No Playwright test links to this feature, so the coverage run cannot show its code. Cypress has no coverage run yet.
        </div>
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

/** For the Playwright and Cypress tabs: the features and scopes this test links to, and a select to add one. */
export function TestFeatures({ project, testId }: { project: string; testId: string }) {
  const { data } = useApi<FeatureData>(`/api/projects/${project}/features`);
  if (!data) return null;
  const mine = data.features.flatMap((f) => f.links.filter((l) => l.testId === testId).map((l) => ({ f, l })));
  const base = `/api/projects/${project}`;
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-3">Features and scope</div>
      {mine.length ? (
        <ul className="space-y-2 text-sm">
          {mine.map(({ f, l }) => (
            <li key={l.id}>
              <div className="flex items-center gap-2">
                <a href={href({ project, tab: 'features', sel: `f:${f.id}` })} className="hover:underline">
                  <span className="mr-1.5 font-mono text-[11px] text-ink-3">{featureCode(f.id)}</span>
                  {f.title}
                </a>
                {aiLink(l) && <span className="text-xs text-ink-3">(linked by AI)</span>}
                <button
                  type="button"
                  aria-label="Remove link"
                  onClick={() => act(() => mutate('DELETE', `${base}/links/${l.id}`))}
                  className="text-ink-3 hover:text-bad"
                >
                  ×
                </button>
              </div>
<div className="ml-6 mt-0.5 max-w-md">
                <LinkScopes project={project} f={f} l={l} withTitles />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-sm text-ink-3">This test links to no feature.</div>
      )}
      <div className="mt-2 max-w-sm">
        <ScopeSelect project={project} testId={testId} features={[...data.features].sort((a, b) => a.title.localeCompare(b.title))} />
      </div>
    </div>
  );
}
