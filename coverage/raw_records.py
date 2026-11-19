"""Reads one plugin's lines from a raw request file of coverage/prepend.php.

New files keep the lines by plugin name: {"plugins": {name: {"files": ..., "not_run": ...}}}.
Older files have one plugin only, in "files" and "not_run" at the top. The plugin name is the
folder name of the plugin in the site's wp-content/plugins, which is also the folder name of the
tracker's copy of the repo.
"""
import json
import os


def plugin_name(plugin_dir):
    """The plugin name of a repo folder: its folder name. A relative path such as "." works too."""
    return os.path.basename(os.path.abspath(plugin_dir))


def plugin_lines(record, name):
    """(files, not_run) of one plugin in one request: {path: [lines]} each."""
    if 'plugins' in record:
        p = (record.get('plugins') or {}).get(name) or {}
        return p.get('files') or {}, p.get('not_run') or {}
    return record.get('files') or {}, record.get('not_run') or {}


def site_slots(run_dir):
    """{port: worker slot} from sites.json of a run with one test site for each worker.

    Empty for older runs (one worker, no sites.json).
    """
    path = os.path.join(run_dir, 'sites.json')
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        return {s['port']: s['slot'] for s in json.load(f)}


def window_of(record, windows, slots):
    """The test window that a request belongs to, or None.

    windows: test windows of the reporter. slots: site_slots() of the run.
    With more than one site, the tests of different workers run at the same time. Then a request
    belongs only to a window of the worker whose site has the request's port. A request with no
    known port belongs to no test. With one site (or an older run), the time is enough.
    """
    if len(slots) > 1:
        slot = slots.get(record.get('port'))
        if slot is None:
            return None
        windows = [w for w in windows if w.get('slot') == slot]
    for w in windows:
        if w['start'] <= record['start'] <= w['end']:
            return w
    return None
