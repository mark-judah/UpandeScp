"""Reconcile the scouting push against the source.

Counts alone would hide the two things most likely to have gone wrong: a link
that points at nothing (the tree and greenhouse renames), and a child row that
did not travel with its parent. Both are checked.

    python3 verify_scouting.py
"""

from __future__ import annotations

import glob
import json
import sys
from collections import Counter, defaultdict

import target as T

DATA = "/tmp/claude-1001/-home-ubuntu-stive-code-frappe15-apps-upande-scp/b6c1bfb1-0cbb-4dc9-8993-2881a8b84c4a/scratchpad/"
KEY_FIELDS = ("date_of_capture", "time_of_capture", "scouts_name", "crop_scouted",
              "greenhouse", "block", "bed", "zone", "tree")
CHILD = {
	"pests_scouting_entry": "Pests Scouting Entry",
	"diseases_scouting_entry": "Diseases Scouting Entry",
	"predators_scouting_entry": "Predators Scouting Entry",
	"weeds_scouting_entry": "Weeds Scouting Entry",
	"incidents_scouting_entry": "Incidents Scouting Entry",
	"physiological_disorders_entry": "Physiological Disorders Entry",
	"trap_scouting_entry": "Trap Scouting Entry",
}
WAREHOUSE_REMAP = {
	"Torongo GH17 - KR": "Torongo GH 17 - KR",
	"Torongo GH18 - KR": "Torongo GH 18 - KR",
	"Chepsito GH 15   - KR": "Chepsito GH 15 - KR",
}


def _remap(v):
	if not v:
		return v
	for old, new in WAREHOUSE_REMAP.items():
		if v.startswith(old):
			return new + v[len(old):]
	return v


def main():
	t = T.Target()
	print(t.describe(), "\n")

	# --- what the source says, after the same collapsing the push applies ----
	tree_map = json.load(open(DATA + "tree_map.json"))
	seen, expect_child = set(), Counter()
	crops = Counter()
	for path in sorted(glob.glob(DATA + "rose_slice_*.json")) + [DATA + "avocado_entries.json"]:
		for d in json.load(open(path)):
			for f in ("greenhouse", "block"):
				if d.get(f) in WAREHOUSE_REMAP:
					d[f] = WAREHOUSE_REMAP[d[f]]
			for f in ("bed", "row", "zone"):
				if d.get(f):
					d[f] = _remap(d[f])
			if d.get("tree"):
				d["tree"] = tree_map.get(d["tree"], d["tree"])
			k = tuple(str(d.get(f) or "") for f in KEY_FIELDS)
			if k in seen:
				continue
			seen.add(k)
			crops[d.get("crop_scouted") or "(none)"] += 1
			for field in CHILD:
				expect_child[field] += len(d.get(field) or [])

	print("EXPECTED (source, exact duplicates collapsed)")
	for c, n in crops.most_common():
		print("  {:<12} {:>8,}".format(c, n))
	print("  {:<12} {:>8,}".format("TOTAL", sum(crops.values())))

	print("\nON TARGET")
	total = t.count("Scouting Entry")
	print("  {:<12} {:>8,}".format("TOTAL", total or 0))
	for c in crops:
		if c == "(none)":
			continue
		print("  {:<12} {:>8,}".format(c, t.count("Scouting Entry", {"crop_scouted": c}) or 0))
	gap = sum(crops.values()) - (total or 0)
	print("\n  difference: {:+,}  {}".format(-gap, "MATCH" if gap == 0 else "*** investigate ***"))

	print("\nCHILD ROWS")
	for field, dt in CHILD.items():
		if not expect_child[field]:
			continue
		r = t._request("GET", "/api/resource/" + dt.replace(" ", "%20"),
		               params={"parent": "Scouting Entry", "limit_page_length": 0, "fields": '["name"]'})
		got = len(r.json().get("data") or []) if r.ok else None
		mark = "MATCH" if got == expect_child[field] else "*** {:+} ***".format((got or 0) - expect_child[field])
		print("  {:<32} expected {:>7,}   on target {:>7,}   {}".format(
			dt, expect_child[field], got or 0, mark))

	# --- broken links: the renames are where this would show ----------------
	print("\nBROKEN LINKS (sampled 400 per field)")
	for field, dt in (("greenhouse", "Warehouse"), ("block", "Warehouse"),
	                  ("bed", "Bed"), ("zone", "Zone"), ("tree", "Orchard Tree")):
		rows = t.get_list("Scouting Entry", fields=[field], limit=400)
		vals = sorted({r[field] for r in rows if r.get(field)})
		if not vals:
			print("  {:<12} nothing set in the sample".format(field))
			continue
		have = set()
		for i in range(0, len(vals), 30):
			have |= {g["name"] for g in t.get_list(dt, fields=["name"],
			                                       filters={"name": ["in", vals[i:i+30]]}, limit=0)}
		bad = [v for v in vals if v not in have]
		print("  {:<12} {:>4} distinct  {:>4} resolve  {}".format(
			field, len(vals), len(have), "OK" if not bad else "BROKEN: " + "; ".join(bad[:3])))
	return 0


if __name__ == "__main__":
	sys.exit(main())
