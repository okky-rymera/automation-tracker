/**
 * Playwright config wrapper for CommonJS configs. See coverage/playwright-wrapper-lib.cjs.
 * The sync test run copies it next to the plugin's config as .tracker-playwright.config.cjs.
 */
const path = require('path');
const lib = require(process.env.TRACKER_WRAPPER_LIB);

lib.prepare();
module.exports = lib.transform(require(path.join(__dirname, process.env.TRACKER_PW_CONFIG || 'playwright.config.js')));
