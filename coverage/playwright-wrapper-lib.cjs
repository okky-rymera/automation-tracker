/**
 * Playwright config changes for sync test runs with one test site for each worker
 * (server/test-run.ts). coverage/playwright-wrapper.cjs (CommonJS configs) and
 * coverage/playwright-wrapper.mjs (ES module configs) load the plugin's config and use this file.
 *
 * The test run copies the wrapper next to the plugin's own config, and removes it after the run.
 * The wrapper must be in that folder: Playwright reads the paths of a config (testDir, outputDir)
 * from the folder of the config file. This file can stay in the tracker (TRACKER_WRAPPER_LIB).
 *
 * The plugin runs with ECHOWP=false, so its config takes the site from BASE_URL. Playwright loads
 * the config again in each worker, after it sets TEST_PARALLEL_INDEX (the worker slot,
 * 0 … workers-1). prepare() sets BASE_URL to the site of the slot before the wrapper loads the
 * plugin's config. So each worker uses its own site, and the plugin code does not change.
 *
 * Environment:
 *   TRACKER_PW_CONFIG   file name of the plugin's config in this folder (playwright.config.js)
 *   TRACKER_SITE_URLS   JSON list of site URLs: item k is the site of worker slot k
 *   TRACKER_PHASE       "setup": the projects that other projects depend on, and globalSetup,
 *                       for one site (BASE_URL as given). The run does this once for each site.
 *                       "main": the other projects, with no dependencies, on all sites.
 *                       "teardown": the teardown projects and globalTeardown, for one site.
 *   TRACKER_LIST_SLOT   main phase, main process only: the slot whose site BASE_URL gets
 *                       (default 0). The run lists the tests for two slots, to find tests whose
 *                       name holds BASE_URL.
 *   TRACKER_SITE_SLOT   teardown phase: the slot of the site. Then the teardown reads the saved
 *                       login of that site.
 *   TRACKER_INFO_FILE   when set, the main process writes facts about the config there (info()).
 *
 * Saved logins (storageState): a setup project often saves the login to one file. WordPress
 * names its login cookie from the site URL, so each site needs its own file. When the config
 * names storageState files, the run does the setups one after the other, and copies each file
 * to stateFile(file, slot) after the setup of that site. In the main phase, each worker reads
 * the copy of its slot.
 */
const fs = require('fs');

const phase = () => process.env.TRACKER_PHASE || 'main';
const urls = () => JSON.parse(process.env.TRACKER_SITE_URLS || '[]');

/** The copy of a saved login file for the site of a worker slot. */
function stateFile(file, slot) {
  return `${file}.tracker-site-${Number(slot) + 1}`;
}

function prepare() {
  if (phase() !== 'main') return;
  const list = urls();
  if (!list.length) return;
  const slot = process.env.TEST_PARALLEL_INDEX ?? process.env.TRACKER_LIST_SLOT ?? '0';
  const url = list[Number(slot)];
  if (!url) throw new Error(`Worker slot ${slot} has no test site (${list.length} sites).`);
  process.env.BASE_URL = url;
}

/** The storageState file names in the config (strings only), in the order they appear. */
function stateFiles(config) {
  const out = [];
  for (const use of [config.use, ...(config.projects || []).map((p) => p.use)]) {
    const s = use && use.storageState;
    if (typeof s === 'string' && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Points storageState of a use block to the copy of the slot. */
function withState(use, slot) {
  if (!use || typeof use.storageState !== 'string') return use;
  return { ...use, storageState: stateFile(use.storageState, slot) };
}

function info(config, file) {
  const projects = config.projects || [];
  const deps = new Set(projects.flatMap((p) => p.dependencies || []));
  const teardowns = new Set(projects.map((p) => p.teardown).filter(Boolean));
  fs.writeFileSync(
    file,
    JSON.stringify({
      storageStates: stateFiles(config),
      setupProjects: projects.filter((p) => deps.has(p.name) && !teardowns.has(p.name)).map((p) => p.name),
      teardownProjects: [...teardowns],
      globalSetup: !!config.globalSetup,
      globalTeardown: !!config.globalTeardown,
    }) + '\n',
  );
}

/** Teardown phase: the saved login of the site that TRACKER_SITE_SLOT names, when there is one. */
function siteState(use) {
  const slot = process.env.TRACKER_SITE_SLOT;
  return slot === undefined ? use : withState(use, slot);
}

/** A project that matches no file. The run uses --pass-with-no-tests. */
const NONE = { name: 'tracker-none', testMatch: /^$/ };

function transform(loaded) {
  const config = loaded && loaded.__esModule && loaded.default ? loaded.default : loaded;
  const slot = process.env.TEST_PARALLEL_INDEX ?? process.env.TRACKER_LIST_SLOT ?? '0';
  if (process.env.TRACKER_INFO_FILE && process.env.TEST_PARALLEL_INDEX === undefined) info(config, process.env.TRACKER_INFO_FILE);
  const ph = phase();
  const { globalSetup, globalTeardown, ...rest } = config;
  const projects = config.projects;
  const states = stateFiles(config).length > 0;

  if (!projects) {
    // No projects list: Playwright makes one project from the config. It has no setup project.
    if (ph === 'setup') return { ...rest, globalSetup, projects: [NONE] };
    if (ph === 'teardown') return { ...rest, globalTeardown, projects: [NONE], use: siteState(rest.use) };
    return { ...rest, use: states ? withState(rest.use, slot) : rest.use };
  }

  const deps = new Set(projects.flatMap((p) => p.dependencies || []));
  const teardowns = new Set(projects.map((p) => p.teardown).filter(Boolean));
  let picked;
  if (ph === 'setup') picked = projects.filter((p) => deps.has(p.name) && !teardowns.has(p.name));
  else if (ph === 'teardown') picked = projects.filter((p) => teardowns.has(p.name));
  else picked = projects.filter((p) => !deps.has(p.name) && !teardowns.has(p.name));
  const names = new Set(picked.map((p) => p.name));
  // Keep the order inside the phase (setup A after setup B), and drop links to other phases.
  // The teardown projects run in their own phase, after the main run.
  picked = picked.map((p) => {
    const { teardown, ...q } = p;
    const out = { ...q, dependencies: (p.dependencies || []).filter((d) => names.has(d)) };
    if (ph === 'main' && states) out.use = withState(p.use, slot);
    if (ph === 'teardown') out.use = siteState(p.use);
    return out;
  });
  if (!picked.length) picked = ph === 'main' ? picked : [NONE];

  const out = { ...rest, projects: picked };
  if (ph === 'main' && states) out.use = withState(rest.use, slot);
  if (ph === 'setup') out.globalSetup = globalSetup;
  if (ph === 'teardown') {
    out.globalTeardown = globalTeardown;
    out.use = siteState(rest.use);
  }
  return out;
}

module.exports = { prepare, transform, stateFile };
