"""Reads one plugin's lines from a raw request file of coverage/prepend.php.

New files keep the lines by plugin name: {"plugins": {name: {"files": ..., "not_run": ...}}}.
Older files have one plugin only, in "files" and "not_run" at the top. The plugin name is the
folder name of the plugin in the site's wp-content/plugins, which is also the folder name of the
tracker's copy of the repo.
"""
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
