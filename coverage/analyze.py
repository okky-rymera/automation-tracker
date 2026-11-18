#!/usr/bin/env python3
"""Coverage analysis: match requests to tests, then count per line and per function.

Usage: python3 analyze.py <plugin-dir> [run-dir] [--exclude a,b,c]
run-dir defaults to coverage-data/. It must hold raw/*.json and test-windows.json.
test-windows.json comes from the Playwright reporter (coverage/test-window-reporter.cjs)
or, for a Cypress run, from coverage/cypress-windows.py. Make one run per test tool.
Writes report.json, lines.json and summary.txt into run-dir.

Each request gets one kind:
  baseline    - plain page loads that test nothing (coverage/baseline.sh)
  test        - a page or call that the test itself makes
  setup       - test data setup (Test Helper Plugin or Cypress Helper Plugin REST calls, login, loads outside tests)
  background  - work the test did not ask for (WP-Cron, heartbeat, queue runners)

Each runnable line gets one state:
  library     - ran in a baseline request (plugin startup, runs on every request)
  tested      - not library, ran in a test request
  setup       - not library, ran only in setup requests
  background  - not library, ran only in background requests
  never       - not library, never ran
"Feature coverage" = tested / (runnable - library). "All-code coverage" = lines run by tests / runnable.
"""
import glob
import json
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
# Folders to leave out: the same list as the app's file list. Give --exclude when
# the project has its own list (excludeDirs).
EXCLUDE = json.load(open(os.path.join(HERE, 'exclude-dirs.json')))
if '--exclude' in args:
    i = args.index('--exclude')
    EXCLUDE = [d for d in args[i + 1].split(',') if d]
    del args[i:i + 2]
plugin = args[0]
DATA = args[1] if len(args) > 1 else os.path.join(HERE, '..', 'coverage-data')


def excluded(rel):
    parts = rel.split('/')[:-1]
    return any(p.startswith('.') or p in EXCLUDE for p in parts)

# thp = Test Helper Plugin (Playwright), chp = Cypress Helper Plugin.
SETUP_URI = re.compile(r'^/(wp-json/(thp|chp)/|\?rest_route=/(thp|chp)/|wp-login\.php)')
BACKGROUND_URI = re.compile(r'^/wp-cron\.php')
BACKGROUND_ACTIONS = {'heartbeat', 'as_async_request_queue_runner', 'wp-remove-post-lock'}
STATES = ('library', 'tested', 'setup', 'background', 'never')


def kind_of(r):
    if r.get('kind') == 'baseline':
        return 'baseline'
    uri = r['uri']
    if SETUP_URI.search(uri):
        return 'setup'
    if BACKGROUND_URI.search(uri) or r.get('action') in BACKGROUND_ACTIONS:
        return 'background'
    return 'test'


# 1. All functions in the plugin, with line ranges.
funcs = json.loads(subprocess.check_output(['php', os.path.join(HERE, 'functions.php'), plugin, ','.join(EXCLUDE)]))

# 2. Test time windows (from the Playwright reporter). The "setup" project is not a test.
windows = [w for w in json.load(open(os.path.join(DATA, 'test-windows.json'))) if w['start']]
def is_setup(w):
    # Newer runs save the project name; older runs only have the joined title.
    return w['project'] == 'setup' if 'project' in w else w['title'].startswith('setup >')


tests = {w['id']: w for w in windows if not is_setup(w)}
spec_of = {t: w['file'] for t, w in tests.items()}
features_of = {t: sorted(x[len('@feature:'):] for x in w['tags'] if x.startswith('@feature:')) or ['(no feature tag)']
               for t, w in tests.items()}

# 3. Read every request.
test_hits = defaultdict(lambda: defaultdict(set))           # test id -> file -> lines
hits = {k: defaultdict(set) for k in ('baseline', 'setup', 'background')}
runnable = defaultdict(set)                                 # file -> lines that can run
kinds = Counter()
for path in glob.glob(os.path.join(DATA, 'raw', '*.json')):
    r = json.load(open(path))
    owner = None
    for w in windows:
        if w['start'] <= r['start'] <= w['end']:
            owner = w['id'] if not is_setup(w) else None
            break
    k = kind_of(r)
    if k == 'test' and owner not in tests:
        k = 'setup'
    kinds[k] += 1
    for f, lines in (r.get('files') or {}).items():
        if excluded(f):
            continue
        runnable[f].update(lines)
        if k == 'test':
            test_hits[owner][f].update(lines)
        else:
            hits[k][f].update(lines)
    for f, lines in (r.get('not_run') or {}).items():
        if not excluded(f):
            runnable[f].update(lines)

# Files that no request loaded: count their runnable lines without running them
# (coverage/runnable-lines.php). All those lines count as "never run".
never_loaded = sorted(f for f in funcs if f not in runnable)
estimated, unknown_files = [], []
for f in never_loaded:
    out = subprocess.run([os.path.join(HERE, 'php-xdebug.sh'), os.path.join(HERE, 'runnable-lines.php'), os.path.join(plugin, f)],
                         capture_output=True, text=True).stdout
    try:
        found = json.loads(out)
    except ValueError:
        found = {'error': out[:200]}
    if isinstance(found, list):
        runnable[f].update(found)
        estimated.append(f)
    else:
        unknown_files.append(f)

tested_any = defaultdict(set)
for t in test_hits:
    for f, ls in test_hits[t].items():
        tested_any[f] |= ls


def line_state(f, n):
    if n in hits['baseline'].get(f, ()):
        return 'library'
    if n in tested_any.get(f, ()):
        return 'tested'
    if n in hits['setup'].get(f, ()):
        return 'setup'
    if n in hits['background'].get(f, ()):
        return 'background'
    return 'never'


state = {f: {n: line_state(f, n) for n in ls} for f, ls in runnable.items()}

# 4. Per function.
report = []
for f, flist in funcs.items():
    st = state.get(f, {})
    for fn in flist:
        rng = range(fn['start'], fn['end'] + 1)
        counts = Counter(st[n] for n in rng if n in st)
        feature = {n for n in rng if n in st and st[n] != 'library'}
        # Tests that ran the function's feature lines (or any line, for library-only functions).
        look = feature if feature else set(rng)
        ran_by = sorted(t for t in test_hits if look & test_hits[t].get(f, set()))
        if not counts:
            category = 'unknown' if f not in runnable else 'never'   # file never loaded / no runnable lines
        elif not feature:
            category = 'library'
        elif counts['tested']:
            category = 'tested'
        elif counts['setup']:
            category = 'setup'
        elif counts['background']:
            category = 'background'
        else:
            category = 'never'
        report.append({
            'file': f,
            'function': (fn['class'] + '::' if fn['class'] else '') + fn['name'],
            'start': fn['start'], 'end': fn['end'],
            'category': category,
            'lines': {s: counts[s] for s in STATES},
            'tests': ran_by,
            'specs': sorted({spec_of[t] for t in ran_by}),
            'features': sorted({x for t in ran_by for x in features_of[t]}),
        })

def write_json(name, obj, **kw):
    """Writes to a temp file, then swaps it in, so a reader never sees a half-written file."""
    path = os.path.join(DATA, name)
    with open(path + '.tmp', 'w') as fh:
        json.dump(obj, fh, **kw)
    os.replace(path + '.tmp', path)


# Lines per file by state, plus lines run by tests (including library) for the all-code number.
lines_out = {}
for f, st in state.items():
    d = {s: sorted(n for n, v in st.items() if v == s) for s in STATES}
    d['runByTests'] = sorted(tested_any.get(f, set()) & set(st))
    lines_out[f] = d
write_json('lines.json', lines_out)
write_json('report.json', {'tests': list(tests.values()), 'functions': report,
                           'neverLoadedFiles': never_loaded, 'unknownFiles': unknown_files}, indent=1)

# 5. Summary.
tot = Counter(v for st in state.values() for v in st.values())
run_total = sum(tot.values())
feature_total = run_total - tot['library']
all_tested = sum(len(d['runByTests']) for d in lines_out.values())
cats = Counter(r['category'] for r in report)

out = []
p = out.append
p(f'Tests: {len(tests)} in {len(set(spec_of.values()))} spec files')
p(f'Requests: {sum(kinds.values())}  ' + ', '.join(f'{k} {v}' for k, v in sorted(kinds.items())))
p('')
p(f'Runnable PHP lines: {run_total}')
p(f'  library (ran in baseline):  {tot["library"]}')
p(f'  feature lines:              {feature_total}')
p(f'    run by tests:             {tot["tested"]}')
p(f'    run only in setup:        {tot["setup"]}')
p(f'    run only in background:   {tot["background"]}')
p(f'    never run:                {tot["never"]}')
p('')
def share(n, d):
    return f'{100 * n / d:.1f}%' if d else 'n/a'


p(f'All-code line coverage:       {share(all_tested, run_total)}  ({all_tested} / {run_total})')
p(f'Feature line coverage:        {share(tot["tested"], feature_total)}  ({tot["tested"]} / {feature_total}, library removed)')
p('')
p('Functions by category: ' + ', '.join(f'{k} {v}' for k, v in cats.most_common()))
p(f'PHP files that no request loaded: {len(never_loaded)}')
p(f'  runnable lines counted without running: {len(estimated)} files, {sum(len(runnable[f]) for f in estimated)} lines (all never run)')
p(f'  could not be counted: {len(unknown_files)}')
for f in unknown_files:
    p(f'    {f}')

text = '\n'.join(out)
open(os.path.join(DATA, 'summary.txt'), 'w').write(text + '\n')
print(text)
