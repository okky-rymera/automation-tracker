#!/usr/bin/env python3
"""Prints the features that the fill has not done yet, in fill order.

Order: non-integration features by priority (high, medium, low, none), then the
"Integration/..." features. Features marked "To remove" are left out.
Usage: python3 .claude/skills/fill-feature-gaps/next.py [project] [count]
"""
import json, os, re, subprocess, sys

project = sys.argv[1] if len(sys.argv) > 1 else "wwp"
count = int(sys.argv[2]) if len(sys.argv) > 2 else 5
here = os.path.dirname(os.path.abspath(__file__))
root = os.path.abspath(os.path.join(here, "..", "..", ".."))

done = set(int(m) for m in re.findall(r"^- F-(\d+)\b", open(os.path.join(here, "progress.md")).read(), re.M))
out = subprocess.run(["npm", "run", "-s", "map", "--", "features", project], cwd=root, capture_output=True, text=True, check=True).stdout
features = [f for f in json.loads(out)["features"] if not f.get("toRemove") and f["id"] not in done]
rank = {"high": 0, "medium": 1, "low": 2}
features.sort(key=lambda f: ((f["group"] or "").startswith("Integration/"), rank.get(f["priority"], 3), f["id"]))

print(f"Done: {len(done)}. Left: {len(features)}.")
for f in features[:count]:
    kind = "integration (code only)" if (f["group"] or "").startswith("Integration/") else (f["priority"] or "no priority")
    print(f"F-{f['id']}\t{kind}\t{f['group']}\t{f['title']}")
