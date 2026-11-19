#!/usr/bin/env python3
"""Lists the tests to run again after the plugin code changed (test impact analysis).

Usage: python3 select-tests.py <plugin repo> <run dir> <old commit> <new commit>
           [--playwright-dir tests/Playwright/specs] [--exclude a,b,c] [--startup-shortcut] [--json]

The run dir holds report.json from analyze.py. Its "functions" list says which tests ran each function.

A test is selected when:
  - its spec file changed, or
  - it ran a function whose code changed (comments and white space do not count), or
  - it ran a line of a file whose code outside the functions changed (also a file without functions).
The run dir must also hold raw/, test-windows.json and run-info.json (the plugin commit of the run):
the script finds each function at the run commit by name and takes the tests that ran its lines.
Startup code changes select every test that ran that code, which is often all tests. With
--startup-shortcut, startup code that only got new simple lines (one more add_action()) and
new statements outside functions (a new constant or require) select no test. That shortcut misses real effects, so use it only to compare.
When a Playwright file outside the specs folder changed (page objects, fixtures, config), all
tests are selected, because the script cannot see which specs use it.

Other changes (JS, CSS, built files, composer and package files) are listed as "not mapped":
no coverage data covers them, so only a full run checks them.
New functions and changed functions that no test ran select no test. They are listed, because
they show code that needs a test.
"""
import glob
import json
import os
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict

from raw_records import plugin_lines, plugin_name, site_slots, window_of

HERE = os.path.dirname(os.path.abspath(__file__))
EXCLUDE = json.load(open(os.path.join(HERE, 'exclude-dirs.json')))

args = sys.argv[1:]
as_json = '--json' in args
if as_json:
    args.remove('--json')
# Optional shortcut (off by default): startup code that only got new simple lines selects no test.
# It misses real effects: a new hook in startup code can change every admin page.
startup_shortcut = '--startup-shortcut' in args
if startup_shortcut:
    args.remove('--startup-shortcut')
pw_dir = 'tests/Playwright/specs'
if '--playwright-dir' in args:
    i = args.index('--playwright-dir')
    pw_dir = args[i + 1].strip('/')
    del args[i:i + 2]
# The project's own list of folders to leave out (as analyze.py --exclude), else exclude-dirs.json.
if '--exclude' in args:
    i = args.index('--exclude')
    EXCLUDE = [d for d in args[i + 1].split(',') if d]
    del args[i:i + 2]
repo, run_dir, old, new = args
# report.json test files are relative to the Playwright folder: the parent of the specs folder.
# When the specs folder is at the top of the repo, that is the repo itself.
pw_root = os.path.dirname(pw_dir)


def in_dir(path, folder):
    return folder == '' or path.startswith(folder + '/')


def is_support(path):
    """A Playwright file outside the specs folder: page objects, fixtures, helpers, config."""
    if pw_root:
        return path.startswith(pw_root + '/')
    # The Playwright folder is the repo itself: only the Playwright config and package files count.
    return os.path.basename(path).startswith('playwright.config.') or path in ('package.json', 'package-lock.json')


def git(*a, check=True):
    return subprocess.run(['git', '-C', repo, *a], capture_output=True, text=True, check=check).stdout


def plugin_code(path):
    parts = path.split('/')[:-1]
    return path.endswith('.php') and not any(p.startswith('.') or p in EXCLUDE for p in parts)


report = json.load(open(os.path.join(run_dir, 'report.json')))
all_tests = {t['id']: t for t in report['tests'] if t.get('project', '') != 'setup'}
run_commit = json.load(open(os.path.join(run_dir, 'run-info.json')))['pluginCommit']
startup = {(f['file'], f['function']) for f in report['functions'] if f['category'] == 'library'}

# Lines that each test ran, from the raw requests of the run: every request in the time
# window of a test counts, also its setup calls, because a change there can break the test too.
# This also covers files without functions (templates in views/) and the startup lines of a function.
windows = [w for w in json.load(open(os.path.join(run_dir, 'test-windows.json'))) if w['start']]
slots = site_slots(run_dir)
hits = defaultdict(lambda: defaultdict(set))   # run test ID -> file -> lines
for path in glob.glob(os.path.join(run_dir, 'raw', '*.json')):
    r = json.load(open(path))
    if r.get('kind') == 'baseline':
        continue
    w = window_of(r, windows, slots)
    owner = w['id'] if w else None
    if owner not in all_tests:
        continue
    for f, lines in plugin_lines(r, plugin_name(repo))[0].items():
        hits[owner][f].update(lines)
tests_of_spec = defaultdict(set)
for t in all_tests.values():
    tests_of_spec[t['file']].add(t['id'])

# 1. Changed files. -M finds renamed files, so a rename keeps its coverage data.
# -z gives the paths as they are (no quotes or escapes for special characters), split by NUL:
# status, path, and a second path for a rename or copy.
changes = []
fields = git('diff', '--name-status', '-z', '-M', old, new).split('\0')
i = 0
while i < len(fields) and fields[i]:
    status = fields[i][0]
    old_path = fields[i + 1]
    new_path = fields[i + 2] if status in 'RC' else old_path
    i += 3 if status in 'RC' else 2
    changes.append((status, old_path, new_path))

selected = defaultdict(set)  # run test ID -> reasons
spec_changes, support_changes, php_files, not_mapped = [], [], [], []
for status, old_path, new_path in changes:
    path = new_path if status != 'D' else old_path
    if (in_dir(path, pw_dir) or in_dir(old_path, pw_dir)) and not is_support(path) and pw_dir:
        spec_changes.append((status, old_path, new_path))
    elif is_support(path):
        support_changes.append(path)
    elif path.startswith('tests/'):
        continue  # other test tools (Cypress, PHP unit tests): not part of the Playwright run
    elif plugin_code(old_path) or plugin_code(new_path):
        php_files.append((status, old_path, new_path))
    else:
        not_mapped.append(path)

for status, old_path, new_path in spec_changes:
    for p in {old_path, new_path}:
        rel = os.path.relpath(p, pw_root or '.')
        for t in tests_of_spec.get(rel, ()):
            selected[t].add(f'spec file changed: {rel}')

if support_changes:
    for t in all_tests:
        selected[t].add('Playwright support file changed')


# 2. PHP files: compare the fingerprint of each function.
def fingerprints(commit, paths, tmp):
    """Writes the files of one commit into tmp and runs fingerprints.php on them."""
    for p in paths:
        dest = os.path.join(tmp, p)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        r = subprocess.run(['git', '-C', repo, 'show', f'{commit}:{p}'], capture_output=True)
        if r.returncode == 0:
            open(dest, 'wb').write(r.stdout)
    if not paths:
        return {}
    out = subprocess.check_output(['php', os.path.join(HERE, 'fingerprints.php'), tmp, *paths])
    return json.loads(out)


def only_new_lines(b, a):
    """True when the function kept every statement and only got new simple statements (no new blocks)."""
    old_st, new_st = Counter(b.get('statements', [])), Counter(a.get('statements', []))
    added = new_st - old_st
    return not (old_st - new_st) and all(k.endswith(';') for k in added)


def tests_in_lines(path, start, end):
    return {t for t, files in hits.items() if any(start <= n <= end for n in files.get(path, ()))}


def tests_in_file(path):
    return {t for t, files in hits.items() if path in files}


changed_functions = []   # { file, function, change, tests }
with tempfile.TemporaryDirectory() as t_old, tempfile.TemporaryDirectory() as t_new, tempfile.TemporaryDirectory() as t_run:
    olds = fingerprints(old, [o for s, o, n in php_files if s != 'A'], t_old)
    news = fingerprints(new, [n for s, o, n in php_files if s != 'D'], t_new)
    # The line numbers in the run are those of the run commit, so find each function there by its key.
    at_run = fingerprints(run_commit, [o for s, o, n in php_files if s != 'A'], t_run)

    def tests_of_function(path, key):
        f = next((x for x in ((at_run.get(path) or {}).get('functions') or []) if x['key'] == key), None)
        return tests_in_lines(path, f['start'], f['end']) if f else set()

    for status, old_path, new_path in php_files:
        before = olds.get(old_path) if status != 'A' else None
        after = news.get(new_path) if status != 'D' else None
        bf = {f['key']: f for f in (before or {}).get('functions', [])}
        af = {f['key']: f for f in (after or {}).get('functions', [])}
        for key in sorted(set(bf) | set(af)):
            b, a = bf.get(key), af.get(key)
            if b and a and b['hash'] == a['hash']:
                continue
            change = 'added' if not b else 'removed' if not a else 'changed'
            name = (b or a)['name']
            ran = tests_of_function(old_path, key) if b else set()
            if change == 'changed' and startup_shortcut and (old_path, name) in startup and only_new_lines(b, a):
                # Startup code (runs on every request) that only got new simple lines, for example
                # one more add_action(). The new hook's own function shows as added, without tests.
                change, ran = 'startup lines added', set()
            changed_functions.append({'file': new_path, 'function': key, 'change': change, 'tests': len(ran)})
            for t in ran:
                selected[t].add(f'function {change}: {old_path} {name}')
        if (before or {}).get('top') != (after or {}).get('top'):
            # With --startup-shortcut: only added statements (a new constant, property or require)
            # select no test. The code that uses them shows as a changed function, but a new
            # require or a new top-level hook can still change old pages.
            old_st = Counter((before or {}).get('topStatements', []))
            new_st = Counter((after or {}).get('topStatements', []))
            only_added = startup_shortcut and bool(before) and not (old_st - new_st)
            ran = tests_in_file(old_path) if before and not only_added else set()
            change = 'added' if not before or only_added else 'removed' if not after else 'changed'
            changed_functions.append({'file': new_path, 'function': '(code outside functions)', 'change': change, 'tests': len(ran)})
            for t in ran:
                selected[t].add(f'code outside functions changed: {old_path}')

result = {
    'old': old, 'new': new,
    'testsInRun': len(all_tests),
    'selected': len([t for t in selected if t in all_tests]),
    'tests': {t: {'title': all_tests[t]['title'], 'reasons': sorted(r)} for t, r in selected.items() if t in all_tests},
    'specChanges': [{'status': s, 'old': o, 'new': n} for s, o, n in spec_changes],
    'supportChanges': support_changes,
    'phpFiles': len(php_files),
    'changedFunctions': changed_functions,
    'changedWithoutTests': [c for c in changed_functions if c['change'] != 'removed' and c['tests'] == 0],
    'startupLinesAdded': [c for c in changed_functions if c['change'] == 'startup lines added'],
    'notMapped': not_mapped,
}

if as_json:
    print(json.dumps(result, indent=1))
else:
    print(f'{old[:8]}..{new[:8]}: select {result["selected"]} of {result["testsInRun"]} tests')
    print(f'  PHP files changed: {len(php_files)}, functions changed: {len(changed_functions)}, '
          f'of which no test runs: {len(result["changedWithoutTests"])}')
    print(f'  spec files changed: {len(spec_changes)}, Playwright support files changed: {len(support_changes)}')
    print(f'  other files (not mapped): {len(not_mapped)}')
    for c in changed_functions:
        print(f'    {c["change"]:8} {c["file"]} {c["function"]}  -> {c["tests"]} tests')
