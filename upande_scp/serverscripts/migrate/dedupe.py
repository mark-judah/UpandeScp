"""Remove duplicate documents this tool created on a target, keeping one of each.

    bench --site kaitet.local execute \
        upande_scp.serverscripts.migrate.dedupe.report
    bench --site kaitet.local execute \
        upande_scp.serverscripts.migrate.dedupe.run

`report` only lists; `run` deletes. Duplicates are grouped by the same
`NATURAL_KEYS` the push matches on, and within a group the **first by name** is
kept so the choice is deterministic and a re-run is a no-op.

## Why this exists

A natural key compared a local `datetime.date` against the API's `"2026-06-10"`.
They never matched, so every record looked new and a re-run created another copy —
27 `Livestock Disposal` rows where there should have been 11. `_identity` now
normalises both sides, but the copies already written need removing, and doing that
by hand across a REST API is exactly the sort of fiddly job that should be code.

Submittable documents are cancelled before deletion, since Frappe refuses to
delete a submitted document.
"""

from __future__ import annotations

from collections import defaultdict

import frappe

from upande_scp.serverscripts.migrate.push import NATURAL_KEYS, _identity
from upande_scp.serverscripts.migrate.target import Target


def _groups(site, doctype, key_fields):
	"""{identity: [names]} on the target, for identities with more than one name."""
	rows = site.get_list(doctype, ["name"] + list(key_fields))
	by_key = defaultdict(list)
	for row in rows:
		by_key[_identity(row, key_fields)].append(row["name"])
	return {k: sorted(v) for k, v in by_key.items() if len(v) > 1}


def _scan(site):
	found = {}
	for doctype, key_fields in NATURAL_KEYS.items():
		state, _n = site.probe(doctype)
		if state != "ok":
			continue
		groups = _groups(site, doctype, key_fields)
		if groups:
			found[doctype] = groups
	return found


def report(env_file=None):
	"""List duplicates without touching anything."""
	site = Target(env_file=env_file)
	print(f"target: {site.describe()}   (read-only)\n")
	found = _scan(site)
	if not found:
		print("no duplicates found")
		return {}
	total = 0
	for doctype, groups in found.items():
		extra = sum(len(v) - 1 for v in groups.values())
		total += extra
		print(f"{doctype}: {len(groups)} identities duplicated, {extra} extra document(s)")
		for key, names in list(groups.items())[:5]:
			print(f"    {key} -> keep {names[0]}, remove {', '.join(names[1:])}")
		if len(groups) > 5:
			print(f"    … and {len(groups) - 5} more identities")
	print(f"\n{total} document(s) would be removed")
	return found


def run(env_file=None):
	"""Delete the extras, keeping the first by name in each group."""
	site = Target(env_file=env_file)
	print(f"target: {site.describe()}   (DELETING duplicates)\n")
	found = _scan(site)
	if not found:
		print("no duplicates found")
		return {"removed": 0, "failed": 0}

	removed = failed = 0
	for doctype, groups in found.items():
		submittable = bool(frappe.get_meta(doctype).is_submittable)
		for _key, names in groups.items():
			for name in names[1:]:
				if submittable:
					# Frappe will not delete a submitted document.
					site.cancel(doctype, name)
				ok, err = site.delete(doctype, name)
				if ok:
					removed += 1
				else:
					failed += 1
					print(f"  could not remove {doctype} {name}: {str(err)[:160]}")
		print(f"{doctype}: {sum(len(v) - 1 for v in groups.values())} extra handled")

	print(f"\nremoved {removed}, failed {failed}")
	return {"removed": removed, "failed": failed}
