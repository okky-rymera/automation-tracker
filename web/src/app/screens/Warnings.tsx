import type { Framework, ProjectSummary, RunFreshness } from '../../api';
import { short } from '../data';
import { Banner } from '../ui';

const TOOL: Record<Framework, string> = { playwright: 'Playwright', cypress: 'Cypress' };
const REASON: Record<string, (f: RunFreshness) => string> = {
  'run-dirty': () => 'the run was made while the plugin had uncommitted changes',
  'new-commit': (f) => `the plugin is now at commit ${short(f.currentCommit)}, not ${short(f.runCommit)}`,
  uncommitted: () => 'the plugin has uncommitted changes now',
};

/** Warnings about the coverage data: an old run, two runs of different code, a run that could not be read, spec files that could not be read. */
export function Warnings({ p, parse = true }: { p: ProjectSummary; parse?: boolean }) {
  const out: React.ReactNode[] = [];
  const tools = (p.view === 'both' ? ['playwright', 'cypress'] : p.view ? [p.view] : []) as Framework[];
  for (const fw of tools) {
    const f = p.runs[fw]?.freshness;
    if (!f || f.stale === false) continue;
    out.push(
      f.stale === null ? (
        <Banner key={fw}>The {TOOL[fw]} run: the app could not check if the plugin code changed after the run (no run-info.json, or git failed). Line colors may point at the wrong lines.</Banner>
      ) : (
        <Banner key={fw} tone="warn">
          The {TOOL[fw]} run is old: {f.reasons.map((r) => REASON[r]?.(f) ?? r).join('; ')}. Line colors may point at the wrong lines. Sync with the tests on to make a new run.
        </Banner>
      ),
    );
  }
  if (p.view === 'both' && p.runsCommit === 'different') {
    out.push(
      <Banner key="differ" tone="warn">
        The two runs used different plugin code (Playwright at {short(p.runs.playwright?.freshness?.runCommit)}, Cypress at {short(p.runs.cypress?.freshness?.runCommit)}). Lines that moved between the two commits are put together wrongly.
      </Banner>,
    );
  } else if (p.view === 'both' && p.runsCommit === 'unknown') {
    out.push(<Banner key="differ">The app could not check that the two runs used the same plugin code: a run has no plugin commit. If the code was different, lines are put together wrongly.</Banner>);
  }
  for (const r of p.unreadRuns) {
    out.push(<Banner key={`u${r.framework}`} tone="warn">The {TOOL[r.framework]} coverage run could not be read ({r.dir}). It needs report.json from coverage/analyze.py. Its numbers are not shown.</Banner>);
  }
  if (parse && p.playwright.parseErrors.length) {
    out.push(
      <Banner key="parse" tone="warn">
        {p.playwright.parseErrors.length} Playwright spec {p.playwright.parseErrors.length === 1 ? 'file' : 'files'} could not be read. The lists show the tests from the last good read:{' '}
        {p.playwright.parseErrors.map((e) => `${e.file} (${e.error})`).join('; ')}
      </Banner>,
    );
  }
  if (!out.length) return null;
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{out}</div>;
}
