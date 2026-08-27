"""Port the Beds and Zones the automation could not produce.

    bench --site kaitet.local execute upande_scp.serverscripts.migrate.port_geometry.plan
    bench --site kaitet.local execute upande_scp.serverscripts.migrate.port_geometry.run

`run_automations` generates 98% of the geometry server-side from GeoJSON the target
already holds, which is the right way to move 200,000 records. This handles the
remainder: warehouses whose automation document carries a snapshot of one import
rather than the cumulative geometry, so its GeoJSON genuinely does not describe the
zones that exist here. `Simotwo GH 20` is the extreme case — 430 features against
4,224 zones.

## How the diff is done

By **name**, in bulk. Both `Bed` and `Zone` name themselves from their content —
`Simotwo GH 20 - KR - Bed 528`, `… - Bed 528 - Zone 8` — so a name is a reliable
identity and the whole comparison is two listings instead of a request per
greenhouse. The obvious per-warehouse loop needs ~260 round trips and takes long
enough to look hung; it was abandoned for exactly that reason.

Beds go first: a Zone names its Bed, so a zone whose bed is absent cannot import.

## Names have to be compared in the target's terms

A raw comparison **overstates the gap by half**, and acting on it would duplicate
thousands of records. Two things shift a name between the sites:

* **the Torongo rename** — `Torongo GH17 - KR` here is `Torongo GH 17 - KR` there.
  All 4,032 of its zones were reported missing while sitting on the target under
  the corrected name.
* **whitespace** — `Chepsito GH 15   - KR` carries three spaces here and one
  there, because Frappe collapsed them on insert. Its 204 beds and 1,632 zones
  read as absent for the same reason.

So every name is normalised through `_target_name` before comparison: the
`REMAP` table for deliberate renames, then whitespace collapsing for the
accidental ones. What remains after that is genuinely missing.

Lokitela's `Row` units are excluded: they belong to an automation run that has not
happened yet, and porting them by hand would pre-empt it.

The same normalisation is applied to the **payload**, not only the comparison. A
Zone names its Bed, and `Torongo GH18 - KR - Bed 3` here is
`Torongo GH 18 - KR - Bed 3` there — so an unrewritten `bed` link points at a
document that does not exist and the insert fails on a mandatory field. `REMAP` in
`push` only covers Warehouse links; a Bed name merely *begins* with a warehouse
name, so it needs rewriting by prefix.

## Speed

`frappe.client.insert_many` takes up to 200 documents per request and measured 63
docs/sec against this target, against 4/sec one at a time. Batches are capped at
100 to stay inside that limit and to keep a failed batch small enough to retry
individually.
"""

from __future__ import annotations

import json
from collections import Counter

import frappe

from upande_scp.serverscripts.migrate.push import REMAP, _clean
from upande_scp.serverscripts.migrate.target import Target, TargetError

BATCH = 100


def _collapse(name):
	"""`Chepsito GH 15   - KR` -> `Chepsito GH 15 - KR`."""
	return " ".join((name or "").split())


def _target_name(name):
	"""What the target calls this record.

	Applies the deliberate renames first, then collapses whitespace. Both parts are
	needed: `Torongo GH17` is a rename, `Chepsito GH 15   ` is Frappe tidying a
	name on insert.

	Non-strings pass through untouched. That guard matters: the field called `bed`
	is a parent *link* on a Zone but an integer bed *number* on a Bed, so rewriting
	by field name alone tries to prefix-match an int.
	"""
	if not isinstance(name, str):
		return name
	for old, new in REMAP.get("Warehouse", {}).items():
		if name == old or name.startswith(old + " "):
			name = new + name[len(old) :]
			break
	return _collapse(name)


def _row_unit_names():
	"""Beds whose unit_type is not `Bed` — Lokitela's rows and coffee's bands.

	Excluded from this diff: they come from their own automation run, and creating
	them here would pre-empt it.
	"""
	return set(
		frappe.get_all("Bed", filters={"unit_type": ["!=", "Bed"]}, pluck="name")
	)


def _missing(site, doctype, local_names, skip=()):
	"""Names present here but not on the target, compared in the target's terms."""
	there = {_collapse(n) for n in site.names(doctype)}
	out = []
	for name in local_names:
		if name in skip:
			continue
		if _target_name(name) not in there:
			out.append(name)
	return out, len(there)


def plan(env_file=None):
	"""What is missing, without writing anything."""
	site = Target(env_file=env_file)
	print(f"target: {site.describe()}   (read-only)\n")

	rows = _row_unit_names()
	beds = frappe.get_all("Bed", pluck="name", order_by="name")
	missing_beds, there_beds = _missing(site, "Bed", beds, skip=rows)
	print(f"Bed   here {len(beds):>7,}   target {there_beds:>7,}   missing {len(missing_beds):>6,}")

	zones = frappe.get_all("Zone", pluck="name", order_by="name")
	missing_zones, there_zones = _missing(site, "Zone", zones)
	print(f"Zone  here {len(zones):>7,}   target {there_zones:>7,}   missing {len(missing_zones):>6,}")

	if missing_beds:
		print("\nmissing beds by greenhouse:")
		for gh, n in Counter(
			frappe.db.get_value("Bed", b, "greenhouse") for b in missing_beds
		).most_common(10):
			print(f"  {str(gh):<26} {n:>6,}")

	if missing_zones:
		print("\nmissing zones by greenhouse:")
		beds_of = {z.rsplit(" - Zone ", 1)[0] for z in missing_zones}
		gh_of = {b: frappe.db.get_value("Bed", b, "greenhouse") for b in beds_of}
		counts = Counter(gh_of.get(z.rsplit(" - Zone ", 1)[0]) for z in missing_zones)
		for gh, n in counts.most_common(10):
			print(f"  {str(gh):<26} {n:>6,}")

	return {"beds": len(missing_beds), "zones": len(missing_zones)}


def _insert_many(site, doctype, names):
	"""Bulk-create, falling back to single inserts for a batch that fails.

	A rejected batch says nothing about which document in it was at fault, so the
	fallback is what turns "100 failed" into one named culprit.
	"""
	made = failed = 0
	problems = []
	for start in range(0, len(names), BATCH):
		chunk = names[start : start + BATCH]
		docs = []
		for name in chunk:
			payload = _clean(frappe.get_doc(doctype, name).as_dict(), doctype)
			payload["doctype"] = doctype
			# Rewrite this record's own name and any name-shaped link into the
			# target's terms. Without it a Torongo zone points at a bed the target
			# calls something else.
			for field in ("name", "bed", "greenhouse", "row", "block"):
				value = payload.get(field)
				if isinstance(value, str) and value:
					payload[field] = _target_name(value)
			docs.append(payload)
		try:
			response = site._request(
				"POST",
				"/api/method/frappe.client.insert_many",
				data=json.dumps({"docs": json.dumps(docs)}),
				timeout=180,
			)
			ok = response.ok
		except TargetError:
			ok = False

		if ok:
			made += len(chunk)
		else:
			for name, payload in zip(chunk, docs):
				single_ok, result = site.insert(doctype, payload)
				if single_ok:
					made += 1
				else:
					failed += 1
					problems.append((name, result))
		done = min(start + BATCH, len(names))
		print(f"    {doctype} {done:,}/{len(names):,}  created {made:,}  failed {failed}", flush=True)
	return made, failed, problems


def run(env_file=None):
	"""Create the missing Beds, then the missing Zones."""
	site = Target(env_file=env_file)
	print(f"target: {site.describe()}   (WRITING)\n", flush=True)

	rows = _row_unit_names()
	beds = frappe.get_all("Bed", pluck="name", order_by="name")
	missing_beds, _ = _missing(site, "Bed", beds, skip=rows)
	print(f"beds to create: {len(missing_beds):,}", flush=True)
	if missing_beds:
		made, failed, problems = _insert_many(site, "Bed", missing_beds)
		print(f"  beds: {made:,} created, {failed} failed")
		for name, why in problems[:5]:
			print(f"    {name}: {str(why)[:140]}")

	# Re-read after the beds land: a zone cannot exist without its bed.
	zones = frappe.get_all("Zone", pluck="name", order_by="name")
	missing_zones, _ = _missing(site, "Zone", zones)
	print(f"\nzones to create: {len(missing_zones):,}", flush=True)
	if missing_zones:
		made, failed, problems = _insert_many(site, "Zone", missing_zones)
		print(f"  zones: {made:,} created, {failed} failed")
		for name, why in problems[:5]:
			print(f"    {name}: {str(why)[:140]}")
