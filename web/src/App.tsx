import { useRoute, href } from './router';
import { useApi, allPct, featurePct, featureTotal, type ProjectSummary } from './api';
import { CoverageBar, Loading, Stat } from './components/ui';
import { CodeTab } from './components/CodeTab';
import { PlaywrightTab } from './components/PlaywrightTab';
import { CypressTab } from './components/CypressTab';
import { FeaturesTab } from './components/FeaturesTab';

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

const REASON_TEXT: Record<string, (f: NonNullable<ProjectSummary['coverageFreshness']>) => string> = {
  'run-dirty': () => 'the run was made while the plugin had uncommitted changes',
  'new-commit': (f) => `the plugin is now at commit ${f.currentCommit?.slice(0, 7)}, not ${f.runCommit?.slice(0, 7)}`,
  uncommitted: () => 'the plugin has uncommitted changes now',
};

/** Warns when line colors may point at the wrong lines, and says why. */
function FreshnessNote({ f }: { f: ProjectSummary['coverageFreshness'] }) {
  if (!f || f.stale === false) return null;
  const unchecked = f.stale === null;
  return (
    <div className="mt-2 rounded-md px-3 py-2 text-xs" style={{ background: unchecked ? 'var(--surface-2)' : 'var(--warn-tint)' }}>
      <span style={{ color: unchecked ? 'var(--text-3)' : 'var(--warn)' }}>⚠</span>{' '}
      {unchecked
        ? 'Could not check if the plugin code changed after the coverage run (no run-info.json, or git failed). Line colors in the source view may point at the wrong lines.'
        : `Line colors in the source view may point at the wrong lines: ${f.reasons.map((r) => REASON_TEXT[r]?.(f) ?? r).join('; ')}. Make a new coverage run to fix this.`}
    </div>
  );
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
            {p.coverageLabel && <div className="mt-4 text-xs text-ink-3">Coverage source: {p.coverageLabel}</div>}
          </a>
        ))}
      </div>
    </div>
  );
}

function ProjectPage({ id }: { id: string }) {
  const route = useRoute();
  const { data: p, error } = useApi<ProjectSummary>(`/api/projects/${id}`);
  if (!p) return <Loading error={error} />;
  const tabs = [
    { key: 'code', label: 'Code coverage' },
    { key: 'features', label: `Features (${p.features.features})` },
    { key: 'playwright', label: `Playwright (${p.playwright.tests})` },
    { key: 'cypress', label: `Cypress (${p.cypress.scenarios})` },
  ] as const;
  const l = p.lines;
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-line bg-surface px-4 pt-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat
            label="Feature code run by tests"
            value={`${featurePct(l)}%`}
            sub={`${l.tested} of ${featureTotal(l)} PHP lines · library code left out · ${l.never} lines never run`}
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
          <Stat
            label="Playwright"
            value={p.playwright.tests}
            sub={`tests in code (${p.playwright.files} spec files, ${p.playwright.skipped} skipped) · ${p.playwright.runTests} test runs in the coverage run`}
          />
          <Stat label="Cypress" value={p.cypress.scenarios} sub={`scenarios in ${p.cypress.files} feature files`} />
          <Stat
            label="Features"
            value={p.features.features}
            sub={`${p.features.withPlaywright} with Playwright tests · ${p.features.withCypress} with Cypress scenarios · ${p.features.unlinkedTests.playwright + p.features.unlinkedTests.cypress} tests link to no feature`}
          />
        </div>
        <div className="mt-2 text-xs text-ink-3">
          Library code = lines that run on plain page loads that test nothing (home page, REST index, admin dashboard).
          {p.neverLoadedFiles > 0 &&
            ` ${p.neverLoadedFiles} PHP files were never loaded by any request; their lines were counted without running them and count as never run.`}
          {p.uncountedFiles > 0 && ` ${p.uncountedFiles} of those could not be counted and are not in the percentages.`}{' '}
          Coverage source:{' '}
          {p.coverageLabel ?? 'none'}
          {p.coverageFreshness?.runCommit && ` (plugin commit ${p.coverageFreshness.runCommit.slice(0, 7)})`}. JavaScript files are not measured yet. No Cypress run
          is in these numbers. Some tests run more than once (one run per user role), so test runs can be more than tests.
        </div>
        <FreshnessNote f={p.coverageFreshness} />
        {p.playwright.parseErrors.length > 0 && (
          <div className="mt-2 rounded-md px-3 py-2 text-xs" style={{ background: 'var(--warn-tint)' }}>
            <span style={{ color: 'var(--warn)' }}>⚠</span> {p.playwright.parseErrors.length} Playwright spec file
            {p.playwright.parseErrors.length > 1 ? 's' : ''} could not be read. The lists show the tests from the last good read of these files:{' '}
            {p.playwright.parseErrors.map((e) => `${e.file} (${e.error})`).join('; ')}
          </div>
        )}
        <nav className="mt-3 flex gap-1">
          {tabs.map((t) => (
            <a
              key={t.key}
              href={href({ project: id, tab: t.key })}
              className={`rounded-t-md border-b-2 px-3 py-2 text-sm ${route.tab === t.key ? 'border-accent font-medium' : 'border-transparent text-ink-2 hover:text-ink'}`}
            >
              {t.label}
            </a>
          ))}
        </nav>
      </div>
      <div className="min-h-0 flex-1">
        {route.tab === 'code' && <CodeTab project={id} sel={route.sel} />}
        {route.tab === 'features' && <FeaturesTab project={id} sel={route.sel} />}
        {route.tab === 'playwright' && <PlaywrightTab project={id} sel={route.sel} />}
        {route.tab === 'cypress' && <CypressTab project={id} sel={route.sel} />}
      </div>
    </div>
  );
}
