#!/usr/bin/env python3
"""Adds the tests of an older run to a partial run, so that the new run has data for all tests.

Usage: python3 merge-run.py <plugin repo> <old run dir> <new run dir> <new commit> <rerun files json>

A partial run runs only the spec files that the changed code touches (coverage/select-tests.py).
The other tests keep their data from the old run (the selected run before this sync):
  - their test windows, with a new slot number
  - their requests (raw/*.json), with the line numbers moved from the old commit to the new commit
Lines in code that changed between the two commits are left out: no test ran the new code there.

<rerun files json> is a JSON list of spec files (as in the "file" field of the windows) that ran in
the new run. The old tests of these files are not kept, also when the new run has no window for one
of them (for example a test that was removed). Old tests of a spec file that is gone at the new
commit are not kept. <tests root> is not needed: the old windows hold the same paths as the new ones.

Each old site slot gets a new slot number after the slots of the new run, and a made-up port
(900000 + slot), so that coverage/raw_records.window_of matches old requests only to old tests.
The new run's sites.json gets these slots too. Baseline requests of the old run are not kept: the
new run has its own baseline at the new commit.

Prints a JSON summary: kept tests, kept requests, dropped lines.
"""
import difflib
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from raw_records import plugin_name, site_slots, window_of  # noqa: E402

repo, old_dir, new_dir, new_commit, rerun_file = sys.argv[1:6]
PLUGIN = plugin_name(repo)
rerun = set(json.load(open(rerun_file)))
old_info = json.load(open(os.path.join(old_dir, 'run-info.json')))
old_commit = old_info['pluginCommit']


def git(*a):
    return subprocess.run(['git', '-C', repo, *a], capture_output=True, text=True, check=True).stdout


def show(commit, path):
    r = subprocess.run(['git', '-C', repo, 'show', f'{commit}:{path}'], capture_output=True)
    return r.stdout.decode('utf8', 'replace').split('\n') if r.returncode == 0 else None


# 1. How each old file maps to the new commit: renamed, deleted, or changed (line map).
moved = {}      # old path -> new path
deleted = set()
changed = {}    # old path -> {old line: new line} (lines in changed blocks are not in the map)
fields = git('diff', '--name-status', '-z', '-M', old_commit, new_commit).split('\0')
i = 0
while i < len(fields) and fields[i]:
    status = fields[i][0]
    a = fields[i + 1]
    b = fields[i + 2] if status in 'RC' else a
    i += 3 if status in 'RC' else 2
    if status == 'D':
        deleted.add(a)
        continue
    if status == 'A' or status == 'C':
        continue
    moved[a] = b
    old_lines, new_lines = show(old_commit, a), show(new_commit, b)
    if old_lines is None or new_lines is None:
        deleted.add(a)
        continue
    m = {}
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, old_lines, new_lines, autojunk=False).get_opcodes():
        if op == 'equal':
            for k in range(i2 - i1):
                m[i1 + k + 1] = j1 + k + 1
    changed[a] = m

dropped_lines = 0


def remap(files):
    """{old path: [lines]} -> {new path: [lines]} at the new commit."""
    global dropped_lines
    out = {}
    for path, lines in files.items():
        if path in deleted:
            dropped_lines += len(lines)
            continue
        if path in changed:
            m = changed[path]
            new = sorted({m[n] for n in lines if n in m})
            dropped_lines += len(lines) - len(new)
            if new:
                out[moved.get(path, path)] = new
        else:
            out[path] = lines
    return out


def spec_exists(file):
    """True when the spec file is in the repo at the new commit. The file path is relative to the
    test folder, which is not known here: look for a path in the repo that ends with it."""
    return any(p == file or p.endswith('/' + file) for p in repo_files)


repo_files = git('ls-tree', '-r', '--name-only', new_commit).split('\n')

# 2. Slots: old slot s -> new slot s + base. A run without sites.json had one site: slot 0.
new_sites = json.load(open(os.path.join(new_dir, 'sites.json'))) if os.path.exists(os.path.join(new_dir, 'sites.json')) else []
base = max([s['slot'] for s in new_sites] + [-1]) + 1
old_slots = site_slots(old_dir)               # port -> slot
old_sites = json.load(open(os.path.join(old_dir, 'sites.json'))) if os.path.exists(os.path.join(old_dir, 'sites.json')) else [{'slot': 0, 'name': 'site', 'port': None}]
slot_of_port = dict(old_slots)
new_slot = {s['slot']: s['slot'] + base for s in old_sites}
fake_port = {s['slot']: 900000 + new_slot[s['slot']] for s in old_sites}

# 3. Old windows to keep.
old_windows = [w for w in json.load(open(os.path.join(old_dir, 'test-windows.json'))) if w.get('start')]
kept_ids = set()
kept_windows = []
for w in old_windows:
    if w.get('project') == 'setup' or w['file'] in rerun or not spec_exists(w['file']):
        continue
    kept_ids.add(w['id'])
    kept_windows.append({**w, 'slot': new_slot[w.get('slot', 0)]})

# 4. Old requests in the kept windows, with moved lines and the made-up port of their slot.
raw_out = os.path.join(new_dir, 'raw')
os.makedirs(raw_out, exist_ok=True)
kept_requests = 0
for name in os.listdir(os.path.join(old_dir, 'raw')):
    if not name.endswith('.json'):
        continue
    try:
        r = json.load(open(os.path.join(old_dir, 'raw', name)))
    except ValueError:
        continue
    if r.get('kind') == 'baseline':
        continue
    w = window_of(r, old_windows, old_slots)
    if not w or w['id'] not in kept_ids:
        continue
    slot = slot_of_port.get(r.get('port'), 0) if old_slots else 0
    p = (r.get('plugins') or {}).get(PLUGIN)
    if p is None and 'plugins' not in r:
        p = {'files': r.get('files') or {}, 'not_run': r.get('not_run') or {}}
    if not p:
        continue
    rec = {k: v for k, v in r.items() if k not in ('plugins', 'files', 'not_run')}
    rec['port'] = fake_port[slot]
    # Only the lines that ran: analyze.py counts the runnable lines at the new commit itself.
    rec['plugins'] = {PLUGIN: {'files': remap(p.get('files') or {})}}
    rec['keptFrom'] = os.path.basename(os.path.normpath(old_dir))
    with open(os.path.join(raw_out, 'kept-' + name), 'w') as fh:
        json.dump(rec, fh)
    kept_requests += 1

# 5. Windows and sites of the new run.
win_file = os.path.join(new_dir, 'test-windows.json')
windows = json.load(open(win_file))
json.dump(windows + kept_windows, open(win_file, 'w'), indent=1)
sites = new_sites + [{'slot': new_slot[s['slot']], 'name': f"kept-{s['name']}", 'port': fake_port[s['slot']]} for s in old_sites]
json.dump(sites, open(os.path.join(new_dir, 'sites.json'), 'w'), indent=2)

print(json.dumps({
    'keptTests': len({w['id'] for w in kept_windows}),
    'keptRequests': kept_requests,
    'droppedLines': dropped_lines,
    'fromRun': os.path.basename(os.path.normpath(old_dir)),
    'fromCommit': old_commit,
}))
