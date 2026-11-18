import { useRoute, href, type Tab } from './router';
import { useApi, allPct, featurePct, featureTotal, pct, type Framework, type ProjectSummary, type RunFreshness, type View } from './api';
import { CoverageBar, CY_ONLY_META, Empty, Loading, Stat } from './components/ui';
import { CodeTab } from './components/CodeTab';
import { PlaywrightTab } from './components/PlaywrightTab';
import { CypressTab } from './components/CypressTab';
import { FeaturesTab } from './components/FeaturesTab';
import { FeatureCodePane } from './components/FeatureCodePane';

export function App() {
  const route = useRoute();
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
        <a href="#/" className="font-semibold">
          Automation Tracker
        </a>
        {route.project && (
          <>
            <span className="text-ink-3">/</span>
            <ProjectName id={route.project} />
          </>
        )}
      </header>
      <main className="min-h-0 flex-1">{route.project ? <ProjectPage id={route.project} /> : <ProjectsPage />}</main>
    </div>
  );
}

const REASON_TEXT: Record<string, (f: RunFreshness) => string> = {
  'run-dirty': () => 'the run was made while the plugin had uncommitted changes',
  'new-commit': (f) => `the plugin is now at commit ${f.currentCommit?.slice(0, 7)}, not ${f.runCommit?.slice(0, 7)}`,
  uncommitted: () => 'the plugin has uncommitted changes now',
};

const TOOL: Record<Framework, string> = { playwright: 'Playwright', cypress: 'Cypress' };

/** Warns when line colors may point at the wrong lines, and says why. One note per run in the view. */
function FreshnessNote({ p }: { p: ProjectSummary }) {
  const tools = (p.view === 'both' ? ['playwright', 'cypress'] : p.view ? [p.view] : []) as Framework[];
  const notes = tools.flatMap((fw) => {
    const f = p.runs[fw]?.freshness;
    if (!f || f.stale === false) return [];
    const unchecked = f.stale === null;
    return [
      <div key={fw} className="mt-2 rounded-md px-3 py-2 text-xs" style={{ background: unchecked ? 'var(--surface-2)' : 'var(--warn-tint)' }}>
        <span style={{ color: unchecked ? 'var(--text-3)' : 'var(--warn)' }}>⚠</span> {TOOL[fw]} run:{' '}
        {unchecked
          ? 'Could not check if the plugin code changed after the coverage run (no run-info.json, or git failed). Line colors in the source view may point at the wrong lines.'
          : `Line colors in the source view may point at the wrong lines: ${f.reasons.map((r) => REASON_TEXT[r]?.(f) ?? r).join('; ')}. Make a new coverage run to fix this.`}
      </div>,
    ];
  });
  if (p.view === 'both' && p.runsCommit === 'different') {
    const a = p.runs.playwright?.freshness?.runCommit?.slice(0, 7);
    const b = p.runs.cypress?.freshness?.runCommit?.slice(0, 7);
    notes.push(
      <div key="differ" className="mt-2 rounded-md px-3 py-2 text-xs" style={{ background: 'var(--warn-tint)' }}>
        <span style={{ color: 'var(--warn)' }}>⚠</span> The two runs used different plugin code (Playwright run at commit {a}, Cypress run at {b}).
        Lines that moved between the two commits are put together wrongly. Make both runs at the same plugin commit.
      </div>,
    );
  } else if (p.view === 'both' && p.runsCommit === 'unknown') {
    notes.push(
      <div key="differ" className="mt-2 rounded-md px-3 py-2 text-xs" style={{ background: 'var(--surface-2)' }}>
        <span style={{ color: 'var(--text-3)' }}>⚠</span> Could not check that the two runs used the same plugin code: a run has no plugin commit
        (no run-info.json). If the code was different, lines are put together wrongly.
      </div>,
    );
  }
  for (const r of p.unreadRuns) {
    notes.push(
      <div key={'unread-' + r.framework} className="mt-2 rounded-md px-3 py-2 text-xs" style={{ background: 'var(--warn-tint)' }}>
        <span style={{ color: 'var(--warn)' }}>⚠</span> The {TOOL[r.framework]} coverage run could not be read ({r.dir}). It needs report.json from
        coverage/analyze.py. Its numbers are not shown.
      </div>,
    );
  }
  return <>{notes}</>;
}

/** "Coverage source: …" text for the runs in the view. */
function sourceText(p: ProjectSummary): string {
  if (!p.view) return 'none';
  const tools = (p.view === 'both' ? ['playwright', 'cypress'] : [p.view]) as Framework[];
  return tools
    .map((fw) => {
      const r = p.runs[fw];
      if (!r) return `${TOOL[fw]}: run could not be read`;
      const c = r.freshness?.runCommit;
      return `${TOOL[fw]}: ${r.label}${c ? ` (plugin commit ${c.slice(0, 7)})` : ''}`;
    })
    .join(' · ');
}

function ProjectName({ id }: { id: string }) {
  const { data } = useApi<ProjectSummary>(`/api/projects/${id}`);
  return <span className="text-ink-2">{data?.name ?? id}</span>;
}

function ProjectsPage() {
  const { data, error } = useApi<ProjectSummary[]>('/api/projects');
  if (!data) return <Loading error={error} />;
  return (
    <div className="mx-auto max-w-5xl p-6">
      <h1 className="mb-1 text-xl font-semibold">Projects</h1>
      <p className="mb-6 text-sm text-ink-2">
        Each project is one plugin. The list comes from the database (data/tracker.db).
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {data.map((p) => (
          <a key={p.id} href={href({ project: p.id })} className="block rounded-lg border border-line bg-surface p-5 hover:border-accent/60">
            <div className="font-semibold">{p.name}</div>
            <div className="mt-0.5 truncate font-mono text-xs text-ink-3">{p.path}</div>
            <div className="mt-4 flex items-baseline justify-between">
              <span className="text-2xl font-semibold tabular-nums">{featurePct(p.lines)}%</span>
              <span className="text-xs text-ink-2">
                feature lines run by tests (all code: {allPct(p.lines)}%)
              </span>
            </div>
            <CoverageBar c={p.lines} className="mt-2" />
            <div className="mt-4 grid grid-cols-3 gap-2 text-xs text-ink-2">
              <div>
                <div className="text-base font-semibold text-ink tabular-nums">{p.files.total}</div>code files
              </div>
              <div>
                <div className="text-base font-semibold text-ink tabular-nums">{p.playwright.tests}</div>Playwright tests
              </div>
              <div>
                <div className="text-base font-semibold text-ink tabular-nums">{p.cypress.scenarios}</div>Cypress scenarios
              </div>
            </div>
            {p.view && <div className="mt-4 text-xs text-ink-3">Coverage source: {sourceText(p)}</div>}
          </a>
        ))}
      </div>
    </div>
  );
}

/** Card of one test tool: its own coverage, and its tests. */
function ToolStat({ p, fw }: { p: ProjectSummary; fw: Framework }) {
  const c = p.linesBy[fw];
  const tests =
    fw === 'playwright'
      ? `${p.playwright.tests} tests in ${p.playwright.files} spec files (${p.playwright.skipped} skipped)${c ? ` · ${p.playwright.runTests} test runs in the coverage run` : ''}`
      : `${p.cypress.scenarios} scenarios in ${p.cypress.files} feature files${c ? ` · ${p.cypress.runTests} scenario runs in the coverage run` : ''}`;
  return (
    <Stat
      label={`${TOOL[fw]} tests run`}
      value={c ? `${featurePct(c)}%` : '–'}
      sub={c ? `${c.tested} of ${featureTotal(c)} feature lines · ${tests}` : `No ${TOOL[fw]} coverage run · ${tests}`}
    >
      {c && <CoverageBar c={c} />}
    </Stat>
  );
}

const PANES: Record<Tab, { list: string; code: string }> = {
  features: { list: 'Feature list', code: 'Code by feature' },
  playwright: { list: 'Tests', code: 'Code coverage' },
  cypress: { list: 'Scenarios', code: 'Code coverage' },
};

function ProjectPage({ id }: { id: string }) {
  const route = useRoute();
  const { data: p, error } = useApi<ProjectSummary>(`/api/projects/${id}`);
  if (!p) return <Loading error={error} />;
  const tabs = [
    { key: 'features', label: `Features (${p.features.features})` },
    { key: 'playwright', label: `Playwright (${p.playwright.tests})` },
    { key: 'cypress', label: `Cypress (${p.cypress.scenarios})` },
  ] as const;
  const l = p.lines;
  const both = p.view === 'both';
  const m = p.mappedCode;
  const mappedFeature = m.lines ? featureTotal(m.lines) : 0;
  const allFeature = mappedFeature + featureTotal(m.unmapped);
  // Each tool's code list uses its own run. A tool with no run has no code list.
  const codeView: Record<Tab, View | null> = { features: p.view, playwright: p.runs.playwright ? 'playwright' : null, cypress: p.runs.cypress ? 'cypress' : null };
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-line bg-surface px-4 pt-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat
            label={both ? 'Feature code run by tests (both)' : 'Feature code run by tests'}
            value={`${featurePct(l)}%`}
            sub={`${l.tested} of ${featureTotal(l)} PHP lines${both ? ` · ${l.cypressOnly} only by Cypress` : ''} · ${l.never} never run · library code left out`}
          >
            <CoverageBar c={l} />
          </Stat>
          <Stat
            label="All code run by tests"
            value={`${allPct(l)}%`}
            sub={`${l.runByTests} of ${l.runnable} PHP lines · ${l.library} are library lines (run on every request)`}
          >
            <CoverageBar c={l} withLibrary />
          </Stat>
          <ToolStat p={p} fw="playwright" />
          <ToolStat p={p} fw="cypress" />
          <Stat
            label="Features"
            value={p.features.features}
            sub={`${p.features.withPlaywright} with Playwright tests · ${p.features.withCypress} with Cypress scenarios · ${p.features.unlinkedTests.playwright + p.features.unlinkedTests.cypress} tests link to no feature · ${allFeature ? pct(mappedFeature, allFeature) : 0}% of feature lines are in a feature`}
          />
        </div>
        <div className="mt-2 text-xs text-ink-3">
          {both && (
            <>
              <span style={{ color: CY_ONLY_META.color }}>{CY_ONLY_META.icon}</span> Purple = code that only Cypress tests run. Convert those tests to Playwright to make it green.{' '}
            </>
          )}
          Library code = lines that run on plain page loads that test nothing (home page, REST index, admin dashboard).
          {p.neverLoadedFiles > 0 &&
            ` ${p.neverLoadedFiles} PHP files were never loaded by any request; their lines were counted without running them and count as never run.`}
          {p.uncountedFiles > 0 && ` ${p.uncountedFiles} of those could not be counted and are not in the percentages.`} Coverage source: {sourceText(p)}.
          JavaScript files are not measured yet. Some tests run more than once (one run per user role or example row), so test runs can be more than tests.
        </div>
        <FreshnessNote p={p} />
        {p.playwright.parseErrors.length > 0 && (
          <div className="mt-2 rounded-md px-3 py-2 text-xs" style={{ background: 'var(--warn-tint)' }}>
            <span style={{ color: 'var(--warn)' }}>⚠</span> {p.playwright.parseErrors.length} Playwright spec file
            {p.playwright.parseErrors.length > 1 ? 's' : ''} could not be read. The lists show the tests from the last good read of these files:{' '}
            {p.playwright.parseErrors.map((e) => `${e.file} (${e.error})`).join('; ')}
          </div>
        )}
        <nav className="mt-3 flex flex-wrap items-end gap-1">
          {tabs.map((t) => (
            <a
              key={t.key}
              href={href({ project: id, tab: t.key })}
              className={`rounded-t-md border-b-2 px-3 py-2 text-sm ${route.tab === t.key ? 'border-accent font-medium' : 'border-transparent text-ink-2 hover:text-ink'}`}
            >
              {t.label}
            </a>
          ))}
          <div className="mb-1.5 ml-auto inline-flex overflow-hidden rounded-md border border-line text-xs">
            {(['list', 'code'] as const).map((pane) => {
              const on = route.pane === pane;
              const off = pane === 'code' && !codeView[route.tab];
              return off ? (
                <span key={pane} className="cursor-not-allowed px-2.5 py-1 text-ink-3 opacity-60" title={route.tab === 'features' ? 'No coverage run yet.' : `No ${TOOL[route.tab]} coverage run yet.`}>
                  {PANES[route.tab][pane]}
                </span>
              ) : (
                <a
                  key={pane}
                  href={href({ project: id, tab: route.tab, pane })}
                  className={`px-2.5 py-1 ${on ? 'bg-accent text-white' : 'text-ink-2 hover:bg-surface-2'}`}
                  aria-current={on ? 'true' : undefined}
                >
                  {PANES[route.tab][pane]}
                </a>
              );
            })}
          </div>
        </nav>
      </div>
      <div className="min-h-0 flex-1">
        {route.pane === 'code' && route.tab === 'features' && <FeatureCodePane project={id} sel={route.sel} />}
        {route.pane === 'code' && route.tab !== 'features' && (codeView[route.tab] ? <CodeTab project={id} sel={route.sel} view={codeView[route.tab]!} tab={route.tab} /> : <Empty>No {TOOL[route.tab]} coverage run yet.</Empty>)}
        {route.pane === 'list' && route.tab === 'features' && <FeaturesTab project={id} sel={route.sel} />}
        {route.pane === 'list' && route.tab === 'playwright' && <PlaywrightTab project={id} sel={route.sel} />}
        {route.pane === 'list' && route.tab === 'cypress' && <CypressTab project={id} sel={route.sel} />}
      </div>
    </div>
  );
}
