"""Remove duplicate Scouting Entries from the target.

Scouting Entry autonames from a naming series, so the name Frappe assigns on the
target has nothing to do with the name on the source. A push that checks
"already there?" by name therefore never matches, and re-running it inserts
everything a second time. This clears the surplus, keeping the earliest document
for each natural key.

    python3 dedupe_scouting.py            # report
    python3 dedupe_scouting.py --apply
"""

from __future__ import annotations

import argparse
import sys
from collections import defaultdict

import target as T

# What actually identifies one scouting observation: who looked, when, and at
# which plant. The name cannot serve — see the module docstring.
KEY_FIELDS = ("date_of_capture", "time_of_capture", "scouts_name", "crop_scouted",
              "greenhouse", "block", "bed", "zone", "tree")


def natural_key(row):
	return tuple(str(row.get(f) or "") for f in KEY_FIELDS)


def main():
	p = argparse.ArgumentParser()
	p.add_argument("--apply", action="store_true")
	args = p.parse_args()

	t = T.Target()
	print(t.describe())
	rows = t.get_list("Scouting Entry", fields=["name"] + list(KEY_FIELDS), limit=0)
	print("entries on target:", len(rows))

	groups = defaultdict(list)
	for r in rows:
		groups[natural_key(r)].append(r["name"])

	surplus = []
	for names in groups.values():
		if len(names) > 1:
			surplus.extend(sorted(names)[1:])      # keep the earliest name
	print("distinct observations: {} | surplus documents: {}".format(len(groups), len(surplus)))
	if not surplus:
		print("nothing to remove")
		return 0
	if not args.apply:
		print("dry run — would delete:", ", ".join(surplus[:6]), "…" if len(surplus) > 6 else "")
		return 0

	gone = failed = 0
	for i, n in enumerate(surplus, 1):
		ok, err = t.delete("Scouting Entry", n)
		if ok:
			gone += 1
		else:
			failed += 1
			if failed <= 3:
				print("  ! {} — {}".format(n, str(err)[:120]))
		if i % 100 == 0:
			print("  {}/{}".format(i, len(surplus)), flush=True)
	print("deleted {}, failed {}".format(gone, failed))
	return 1 if failed else 0


if __name__ == "__main__":
	sys.exit(main())
