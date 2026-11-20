# Run a test, or try the feature

Always run the spec file of a Playwright unit (about 1–3 minutes). Reading
the code does not prove what a user sees. For a Cypress unit (slower), run the
file only when the user asks: try the main behavior with `playwright-cli`
instead. For a code unit, try the main behavior with `playwright-cli`, or run a
candidate test.

If a test fails and then passes on retry, say so in the report as a flaky
test. Give the failed assert. Do not guess the cause without proof.

## Safety rules (read first)

- **Never run `sudo`, `su`, `doas` or `pkexec`, directly or through a script.**
  This machine has no terminal for a password, and failed tries lock the
  user's account. Before you run a test command for the first time in a
  session, search the test setup (config, global setup, helpers, fixtures,
  `package.json` scripts) for these words. If a code path can reach one, do
  not run it: tell the user.
- **Never run `echowp trust`.** It needs `sudo`. If a site needs it, print
  `! sudo echowp trust` and ask the user to run it. The `echowp` program holds
  the text "sudo echowp trust" in its messages: that text only tells a person
  what to run, and is not a reason to stop.
- Run `faillock --user $USER` before and after the first test run of a session.
  If the count of failed tries goes up, stop and tell the user at once.
- Tests change the data on the test site (products, settings, users). Run them
  only on a local or echowp test site, never on a site with a public URL. If the
  URL is not `localhost`, `*.localhost`, `*.local` or an echowp site, ask first.
- Do not change plugin code or test files. This skill only reads them.
- Do not leave a site setting changed after you try it with `playwright-cli`:
  set it back.

## Playwright (one spec file)

The plugin's own guide is `tests/Playwright/CLAUDE.md` in the plugin repo. Read it.
Run the spec file from the tracker repo root with:

```bash
npm run -s project -- run-spec <project> <unit ref>
```

Give the Bash call a timeout of 600000 (10 minutes). The command:

- starts the tracker's own echowp site `site-1` (profile `test`) with a clean database,
- opens a few pages first (a new site sends the first admin visit to the WooCommerce home page),
- runs the spec file on that site with 1 worker, and prints the result,
- leaves the site on, so you can try the feature with `playwright-cli`. The last line gives its URL.

Do not run `npx playwright test` yourself. The `.env` file of the plugin can say
`ECHOWP=true`: then the plugin's own echowp setup runs, in the person's own echowp
home, and it can call `sudo`. `run-spec` always turns that off.

A test made in a loop (for example one run for each user role) has one test ID
in the tracker, but Playwright counts each run. So "5 passed" for a file with
2 test IDs can be correct (plus 1 setup step).

Do not print or copy the `.env` values: they hold passwords.

A failed test is information too: note it in `unit.note` and in the report.
The feature may still be correct and the test out of date, or the other way.

## Cypress (one .feature file)

From `<plugin>/tests/Cypress/`:

```bash
npx cypress run --spec "cypress/tests/<path from the unit ref>"
```

Cypress runs are slow and need `TEST_SITE_URL` (see `cypress.config.js`).
Prefer reading the step definitions (in `cypress/step_definitions` and
`cypress/support`; shared steps come from the `@rymera-web-co/automated-test-helper`
package when `node_modules` is installed) and trying the feature with `playwright-cli`. Run Cypress only when the user
asks for it.

In the mapping loop (a headless run), no user can ask, so never run Cypress
there. The loop refuses `npx cypress`.

## The test site (for playwright-cli and test data)

Use the tracker's own echowp site. Run these from the tracker repo root:

```bash
npm run -s project -- echowp <project> up --count 1 --profile test      # start site-1; the output gives its URL
npm run -s project -- echowp <project> wp site-1 --profile test -- <wp-cli command>   # make or change data
npm run -s project -- echowp <project> stop site-1 --profile test       # stop the site when you finish
```

- Do not use `echowp down`: it deletes the sites, and the next start makes them again.
- echowp sets the admin login when it makes the site. The `up` command above
  uses the login of the plugin's Playwright tests (`ADMIN_USERNAME` and
  `ADMIN_PASSWORD` in `tests/Playwright/.env`) for this. Do not read the
  `.env` file into the command yourself.
- Run `faillock --user $USER` before you start the site and after you stop it.
- Make test data with WP-CLI (`wp post create`, `wp post meta update`,
  `wp option update`). Write down each thing you make or change. Delete it or
  set it back before you stop the site.
- The site has only the plugin of the repo, WooCommerce and a test helper.
  Paid add-ons (for example a Premium plugin) are not on the site.

## playwright-cli (try the feature by hand)

Load the `playwright-cli` skill for the commands. Use the test site above.
Log in as the admin user of the plugin's test settings
(`tests/Playwright/.env` in the plugin repo). Read the values into the
command, and do not print the password in a reply. Good uses:

- See the real labels, screens and messages, so the feature text uses the
  words a store owner sees.
- Check a behavior that no test checks (a `never` function from the `code` command).
- Switch a setting on, look at the result, then set it back.
- Take the screenshots of the feature (SKILL.md, step 4).

Close the browser when you finish (`playwright-cli close`).
