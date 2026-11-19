/**
 * Playwright config wrapper for ES module configs (.mjs, .mts, or a package with "type": "module").
 * See coverage/playwright-wrapper-lib.cjs. The sync test run copies it next to the plugin's
 * config as .tracker-playwright.config.mjs.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const lib = require(process.env.TRACKER_WRAPPER_LIB);

lib.prepare();
const dir = path.dirname(fileURLToPath(import.meta.url));
const loaded = await import(pathToFileURL(path.join(dir, process.env.TRACKER_PW_CONFIG || 'playwright.config.js')).href);
export default lib.transform(loaded.default ?? loaded);
