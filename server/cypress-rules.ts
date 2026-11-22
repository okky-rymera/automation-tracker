/**
 * The rules for the Cypress tests that the runs leave out. The Cypress run (server/cypress-run.ts)
 * and the mapping commands (server/map.ts) use them. This file loads no run code, so a read-only
 * command that imports it does not load the test run and sync code.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from './projects.ts';

/** A spec file with one of these steps deletes or installs a plugin. */
export const PLUGIN_STEP = /plugins? (is|are) (deleted|not installed)|is downloaded, installed/i;

/** A tag that the Cypress runs leave out: the test needs other plugins (@integration…) or a GitHub token (@zip-test). */
export function leftOutTag(t: string): boolean {
  return t.startsWith('@integration') || t === '@zip-test';
}

/**
 * True when the runs never run this scenario. tags: the feature, rule and scenario tags.
 * exampleTags: the tags of each Examples block of a Scenario Outline. When every block has a
 * left-out tag, no row of the scenario runs.
 */
export function leftOutTest(tags: string[], exampleTags?: string[][]): boolean {
  if (tags.some(leftOutTag)) return true;
  return !!exampleTags?.length && exampleTags.every((block) => block.some(leftOutTag));
}

/**
 * Why the Cypress runs leave out a whole spec file, or null. ref is relative to the Cypress test
 * folder (the unit ref). The same rules as cypressExclusions in server/cypress-run.ts.
 */
export function leftOutSpec(p: ProjectConfig, ref: string): string | null {
  if (!p.cypressDir) return 'the project has no Cypress folder';
  if (ref.split('/')[0] === 'Integration') return 'it is in the Integration folder (it needs other paid plugins)';
  let text = '';
  try {
    text = fs.readFileSync(path.join(p.path, p.cypressDir, ref), 'utf8');
  } catch {
    return 'the file could not be read';
  }
  return PLUGIN_STEP.test(text) ? 'it deletes or installs a plugin' : null;
}
