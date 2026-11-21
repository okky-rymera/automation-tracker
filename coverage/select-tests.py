#!/usr/bin/env python3
"""Lists the tests to run again after the plugin code changed (test impact analysis).

Usage: python3 select-tests.py <plugin repo> <run dir> <old commit> <new commit>
           [--playwright-dir tests/Playwright/specs] [--tests-root <folder>] [--library-share 0.9]
           [--exclude a,b,c] [--startup-shortcut] [--json]

--playwright-dir is the folder of the spec files (for Cypress: the .feature folder). --tests-root
is the folder that the test file paths in report.json are relative to (default: the parent of
--playwright-dir; for Cypress: the folder of cypress.config.*).
--library-share 0.9: a changed function (or code outside functions) that 90% or more of the
tests ran is library code. It selects no test. It is listed in "libraryChanges".

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
When a test file outside the spec files changed (page objects, config, helpers), all tests are
selected, because the script cannot see which specs use it. Two exceptions, when the run saved the
step patterns of each test (Cypress, coverage/cypress-windows.py): a step file selects the tests that
used a step whose call changed, and a fixture selects the tests whose spec or step call names it.
When the script is not sure (a hook, a changed helper, a fixture named in a support file), it still
selects all tests.

Other changes (JS, CSS, built files, composer and package files) are listed as "not mapped":
no coverage data covers them, so only a full run checks them.
New functions and changed functions that no test ran select no test. They are listed, because
they show code that needs a test.
"""
import bisect
import difflib
import glob
import json
import os
import re
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
tests_root = None
if '--tests-root' in args:
    i = args.index('--tests-root')
    tests_root = args[i + 1].strip('/')
    del args[i:i + 2]
library_share = None
if '--library-share' in args:
    i = args.index('--library-share')
    library_share = float(args[i + 1])
    del args[i:i + 2]
# The project's own list of folders to leave out (as analyze.py --exclude), else exclude-dirs.json.
if '--exclude' in args:
    i = args.index('--exclude')
    EXCLUDE = [d for d in args[i + 1].split(',') if d]
    del args[i:i + 2]
repo, run_dir, old, new = args
# report.json test files are relative to the Playwright folder: the parent of the specs folder.
# When the specs folder is at the top of the repo, that is the repo itself.
pw_root = tests_root if tests_root is not None else os.path.dirname(pw_dir)


def in_dir(path, folder):
    return folder == '' or path.startswith(folder + '/')


def is_doc(path):
    """Documentation and example files in the test folder: they do not change what a test does."""
    base = os.path.basename(path).lower()
    return base.endswith(('.md', '.txt', '.example')) or base in ('license', '.gitignore', '.prettierrc', '.eslintrc', '.editorconfig')


SPEC_NAME = re.compile(r'(\.feature|\.(spec|test)\.[cm]?[jt]sx?)$')


def is_spec_file(path):
    """A test file in the specs folder. Other files there (Cypress step files next to the
    .feature files, Playwright helpers) are support files."""
    return in_dir(path, pw_dir) and bool(SPEC_NAME.search(path))


def is_support(path):
    """A test file outside the spec files: page objects, fixtures, step files, helpers, config."""
    if is_doc(path):
        return False
    if pw_root:
        return path.startswith(pw_root + '/') and not is_spec_file(path)
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
    if (is_spec_file(path) or is_spec_file(old_path)) and pw_dir:
        spec_changes.append((status, old_path, new_path))
    elif is_support(path):
        support_changes.append(path)
    elif path.startswith('tests/') or (is_doc(path) and in_dir(path, pw_root)):
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

# Cypress step files and fixtures: select only the tests that use them (when the run saved the step
# patterns of each test, coverage/cypress-windows.py). Other support files select all tests.
STEP_CALL = re.compile(r'\b(Given|When|Then|Step|defineStep|Before|After|BeforeAll|AfterAll|BeforeStep|AfterStep)\s*\(')
HOOKS = {'Before', 'After', 'BeforeAll', 'AfterAll', 'BeforeStep', 'AfterStep'}
# New top-level code that cannot change an old step: a new declaration. Anything else (a call such
# as a mocha beforeEach, or code that runs when the file loads) can change every test.
DECLARATION = re.compile(r'^(export\s+)?(async\s+)?(function\b|const\b|let\b|var\b|class\b|import\b)')
REGEX_BEFORE = set('(,=:[!&|?{};+-*%<>~^')


def skip_token(text, i):
    """When text[i] starts a string, template literal, regex literal or comment: the index after it.
    Else None. Returns len(text) + 1 for a token that does not end (the file cannot be read safely)."""
    n, c = len(text), text[i]
    if c in '\'"':
        j = i + 1
        while j < n and text[j] != c:
            if text[j] == '\n':
                return n + 1
            j += 2 if text[j] == '\\' else 1
        return j + 1 if j < n else n + 1
    if c == '`':
        j, inner = i + 1, 0
        while j < n:
            if text[j] == '\\':
                j += 2
                continue
            if text.startswith('${', j):
                inner += 1
                j += 2
                continue
            if text[j] == '}' and inner:
                inner -= 1
            elif text[j] == '`' and not inner:
                return j + 1
            j += 1
        return n + 1
    if text.startswith('//', i):
        j = text.find('\n', i)
        return n if j < 0 else j
    if text.startswith('/*', i):
        j = text.find('*/', i + 2)
        return n + 1 if j < 0 else j + 2
    if c == '/':
        k = i - 1
        while k >= 0 and text[k] in ' \t\r\n':
            k -= 1
        if k < 0 or text[k] in REGEX_BEFORE:
            j, in_class = i + 1, False
            while j < n and text[j] != '\n':
                if text[j] == '\\':
                    j += 2
                    continue
                if text[j] == '[':
                    in_class = True
                elif text[j] == ']':
                    in_class = False
                elif text[j] == '/' and not in_class:
                    return j + 1
                j += 1
            return n + 1
    return None


def call_end(text, i):
    """Index after the ")" that closes the "(" at text[i], or None when it does not close."""
    depth, n = 0, len(text)
    while i < n:
        k = skip_token(text, i)
        if k is not None:
            if k > n:
                return None
            i = k
            continue
        c = text[i]
        if c in '([{':
            depth += 1
        elif c in ')]}':
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return None


def first_arg(text, i):
    """The first argument of a step call when it is a string or regex literal, as its source text
    (a regex keeps its backslashes, as RegExp.source does). Else None."""
    j = i
    while j < len(text) and text[j].isspace():
        j += 1
    if j >= len(text) or text[j] not in '\'"`/':
        return None
    end = skip_token(text, j)
    if end is None or end > len(text):
        return None
    body = text[j + 1:end - 1]
    if text[j] == '/':
        return body
    if text[j] == '`' and '${' in body:
        return None
    return re.sub(r'\\(.)', r'\1', body)


def top_level(text):
    """The code at depth 0, without comments, split into statements: one per line at depth 0, with
    a block ({…}, (…)) that spans lines kept in its statement. White space becomes one space. None when the
    file cannot be read safely."""
    out, cur, depth, i, n = [], [], 0, 0, len(text)
    while i < n:
        k = skip_token(text, i)
        if k is not None:
            if k > n:
                return None
            tok = text[i:k]
            if not tok.startswith(('//', '/*')):
                cur.append(tok)
            i = k
            continue
        c = text[i]
        if c in '([{':
            depth += 1
        elif c in ')]}':
            depth -= 1
        if c == '\n' and depth <= 0:
            line = ' '.join(''.join(cur).split())
            if line:
                out.append(line)
            cur = []
        else:
            cur.append(c)
        i += 1
    line = ' '.join(''.join(cur).split())
    if line:
        out.append(line)
    return out


def token_starts(text):
    """Start and end of each string, template, regex literal and comment. None when one does not end."""
    spans, i, n = [], 0, len(text)
    while i < n:
        k = skip_token(text, i)
        if k is None:
            i += 1
            continue
        if k > n:
            return None
        spans.append((i, k))
        i = k
    return spans


def step_blocks(text):
    """(blocks, outside, hooks) of a step file: {pattern: call text}, the statements outside the
    calls (top_level), and the hook calls. None when the file cannot be read safely."""
    spans = token_starts(text)
    if spans is None:
        return None
    starts = [a for a, _ in spans]

    def in_token(i):
        k = bisect.bisect_right(starts, i) - 1
        return k >= 0 and spans[k][0] <= i < spans[k][1]

    blocks, hooks, outside, pos = {}, [], [], 0
    for m in STEP_CALL.finditer(text):
        if m.start() < pos or in_token(m.start()):
            continue  # inside an earlier call, a string or a comment
        end = call_end(text, m.end() - 1)
        if end is None:
            return None
        outside.append(text[pos:m.start()])
        body = text[m.start():end]
        if m.group(1) in HOOKS:
            hooks.append(body)
        else:
            pat = first_arg(text, m.end())
            if pat is None:
                return None  # a step with a pattern that is not a literal
            blocks[pat] = body
        pos = end
    outside.append(text[pos:])
    rest = top_level('\n'.join(outside))
    if rest is None:
        return None
    # The ";" after a step call is an empty statement, not code.
    return blocks, [x for x in rest if x.strip(' ;')], hooks


def changed_patterns(path):
    """Step patterns whose definition changed in a step file, or None when the change can touch any test."""
    a, b = show(old, path), show(new, path)
    if a is None and b is None:
        return None
    pa = step_blocks(a) if a is not None else ({}, [], [])
    pb = step_blocks(b) if b is not None else ({}, [], [])
    if pa is None or pb is None:
        return None
    (ba, oa, ha), (bb, ob, hb) = pa, pb
    if ha != hb:
        return None  # a hook changed: it can run for any test
    if not ba and not bb:
        return None  # not a step file
    if a is None or b is None:
        # A new or deleted step file reaches other tests only through its own steps, unless it
        # defines parameter types, which change how other steps read.
        if 'defineParameterType' in (a or b):
            return None
    elif oa != ob:
        # Only whole new declarations (a new helper or constant) are safe: an old step that uses
        # them changed too, and it selects its tests. A changed or removed statement, or new code
        # that runs (a call, a mocha beforeEach), can change any step.
        for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, oa, ob, autojunk=False).get_opcodes():
            if op == 'equal':
                continue
            if op != 'insert' or not all(DECLARATION.match(x) for x in ob[j1:j2]):
                return None
    return {k for k in set(ba) | set(bb) if ba.get(k) != bb.get(k)}


def show(commit, path):
    r = subprocess.run(['git', '-C', repo, 'show', f'{commit}:{path}'], capture_output=True)
    return r.stdout.decode('utf8', 'replace') if r.returncode == 0 else None


def tests_with_steps(patterns):
    return {t for t, w in all_tests.items() if set(w.get('steps') or ()) & patterns}


JS_FILE = ('.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx')


def fixture_tests(path):
    """Tests that use a fixture file: spec files or step calls that name it. None when nothing names
    it, or when another file names it (a support file, a config, another fixture): then the script
    cannot see which tests load it."""
    tail = path.split('/fixtures/', 1)[1]
    base = os.path.basename(tail)
    names = {tail, base, os.path.splitext(tail)[0], os.path.splitext(base)[0]}
    names = {n for n in names if len(n) >= 4}  # a very short name would match too much
    found, named = set(), False
    for spec, ids in tests_of_spec.items():
        text = show(new, os.path.join(pw_root, spec) if pw_root else spec) or ''
        if any(n in text for n in names):
            found |= ids
            named = True
    for f in git('ls-tree', '-r', '--name-only', new, '--', pw_root or '.').split('\n'):
        if not f or f == path or is_spec_file(f) or is_doc(f):
            continue
        text = show(new, f)
        if text is None or not any(n in text for n in names):
            continue
        if not f.endswith(JS_FILE):
            return None
        parsed = step_blocks(text)
        if parsed is None:
            return None
        blocks, outside, hooks = parsed
        if not blocks or any(n in x for x in outside for n in names) or any(n in h for h in hooks):
            return None  # a helper or support file uses it
        found |= tests_with_steps({k for k, v in blocks.items() if any(n in v for n in names)})
        named = True
    return found if named else None


has_steps = bool(all_tests) and all('steps' in w for w in all_tests.values())
mapped_support = []
for path in list(support_changes):
    if not has_steps:
        break
    if '/fixtures/' in path:
        ids = fixture_tests(path)
        why = f'fixture changed: {path}'
    elif path.endswith(JS_FILE):
        pats = changed_patterns(path)
        ids = None if pats is None else tests_with_steps(pats)
        why = f'step definitions changed: {path}'
    else:
        ids = None
    if ids is None:
        continue
    support_changes.remove(path)
    mapped_support.append(path)
    for t in ids:
        selected[t].add(why)

if support_changes:
    for t in all_tests:
        selected[t].add('test support file changed')


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


def is_library(ran):
    """True when the library limit is on and the share of tests that ran the code reaches it."""
    return library_share is not None and bool(all_tests) and len(ran) >= library_share * len(all_tests)


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
            library = is_library(ran)
            changed_functions.append({'file': new_path, 'function': key, 'name': name, 'change': change, 'tests': len(ran), 'library': library})
            if library:
                continue
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
            library = is_library(ran)
            changed_functions.append({'file': new_path, 'function': '(code outside functions)', 'name': '(code outside functions)', 'change': change, 'tests': len(ran), 'library': library})
            if library:
                continue
            for t in ran:
                selected[t].add(f'code outside functions changed: {old_path}')

result = {
    'old': old, 'new': new,
    'testsInRun': len(all_tests),
    'selected': len([t for t in selected if t in all_tests]),
    'tests': {t: {'title': all_tests[t]['title'], 'reasons': sorted(r)} for t, r in selected.items() if t in all_tests},
    'specChanges': [{'status': s, 'old': o, 'new': n} for s, o, n in spec_changes],
    'supportChanges': support_changes,
    'mappedSupportChanges': mapped_support,
    'phpFiles': len(php_files),
    'changedFunctions': changed_functions,
    'changedWithoutTests': [c for c in changed_functions if c['change'] != 'removed' and c['tests'] == 0],
    'libraryChanges': [c for c in changed_functions if c.get('library') and c['change'] != 'removed'],
    'librarySharePercent': None if library_share is None else round(library_share * 100),
    'selectedFiles': sorted({all_tests[t]['file'] for t in selected if t in all_tests}),
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
