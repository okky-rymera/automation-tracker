/**
 * Links the tests in the coverage runs to the tests the scan found in the repo.
 * Run test IDs come from a run (Playwright test IDs, Cypress pickle IDs).
 * Scanned test IDs are PW-… and CY-….
 */
import type { ProjectConfig } from './projects.ts';
import { listPlaywright } from './playwright.ts';
import { listCypress } from './cypress.ts';

/** Run test ID → scanned test ID, for both test tools. */
export function runTestOwners(project: ProjectConfig): Map<string, string> {
  const owners = new Map<string, string>();
  for (const t of [...listPlaywright(project), ...listCypress(project)]) for (const r of t.run) owners.set(r.runId, t.id);
  return owners;
}
