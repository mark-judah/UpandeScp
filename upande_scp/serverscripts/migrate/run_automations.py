"""Have the target build its own Beds, Zones and Trees from GeoJSON it already holds.

    bench --site kaitet.local execute \
        upande_scp.serverscripts.migrate.run_automations.plan
    bench --site kaitet.local execute \
        upande_scp.serverscripts.migrate.run_automations.run \
        --kwargs '{"pattern": "Karen%"}'

## Why this instead of porting the records

There are 20,668 Beds, 154,341 Zones and 53,699 Orchard Trees here — 228,708
records. Sending them costs about an hour of sustained REST traffic and exposes
every one to the serialisation, naming and ordering problems that this tool has
already been bitten by.

But the target does not need them sent: the 173 `Field Unit Automation` documents
were ported *with their GeoJSON*, byte-identical, so it can generate the same
geometry itself. That is **173 calls instead of 208,000 inserts**, and it runs
server-side, where none of those failure modes exist.

Measured coverage across all 173 docs: 203,432 features against 207,473 existing
children — **98%**. The 6,464 shortfall sits in five warehouses whose GeoJSON is a
snapshot of one import rather than the cumulative geometry; those need their zones
ported directly, and `plan` names them.

## What it does not do

The automation sets no `bed_length` or `bed_width`, and takes `variety` only from
the sectors table — of which 14 rows exist. So beds arrive dimensionless. Patch
them afterwards with `bulk_update` (measured at 128 updates/sec, about two minutes
for all 16,000), where `bed_area` recomputes itself from the two inputs rather than
being copied and left free to drift.

Re-running is safe: the automation counts existing units and children as skipped.
"""

from __future__ import annotations

import json
import time

import frappe

from upande_scp.serverscripts.migrate.target import Target


def _features(text):
	"""How many features a GeoJSON blob describes, in either layout."""
	text = (text or "").strip()
	if not text:
		return 0
	try:
		parsed = json.loads(text)
		if isinstance(parsed, dict) and parsed.get("features"):
			return len(parsed["features"])
	except (ValueError, TypeError):
		pass
	total = 0
	for line in text.splitlines():
		line = line.strip()
		if not line:
			continue
		try:
			total += len(json.loads(line).get("features") or [])
		except (ValueError, TypeError, AttributeError):
			continue
	return total


def _docs(pattern=None):
	filters = {"warehouse": ["like", pattern]} if pattern else None
	return frappe.get_all(
		"Field Unit Automation",
		filters=filters,
		fields=["name", "warehouse", "unit_type"],
		order_by="warehouse",
		limit_page_length=0,
	)


def _local_children(warehouse, unit_type):
	if unit_type == "Bed":
		return frappe.db.sql(
			"SELECT COUNT(*) FROM tabZone z JOIN tabBed b ON b.name = z.bed "
			"WHERE b.greenhouse = %s",
			warehouse,
		)[0][0]
	if unit_type == "Band":
		return frappe.db.count("Triad", {"block": warehouse})
	return frappe.db.count("Orchard Tree", {"block": warehouse})


def plan(pattern=None, env_file=None):
	"""What running these would produce, and where the GeoJSON falls short."""
	site = Target(env_file=env_file)
	docs = _docs(pattern)
	print(f"target: {site.describe()}   (read-only)\n")
	print(f"{'warehouse':<26} {'type':<5} {'features':>9} {'here':>9} {'gap':>7}")
	print("-" * 62)
	total_f = total_c = 0
	short = []
	for doc in docs:
		geo = frappe.db.get_value("Field Unit Automation", doc.name, "units_geojson")
		features = _features(geo)
		children = _local_children(doc.warehouse, doc.unit_type)
		total_f += features
		total_c += children
		gap = children - features
		if gap > 0:
			short.append((doc.warehouse, gap))
		print(f"{doc.warehouse:<26} {doc.unit_type:<5} {features:>9,} {children:>9,} {gap:>7,}")
	print("-" * 62)
	print(f"{len(docs)} document(s): {total_f:,} features vs {total_c:,} children here")
	if short:
		print(f"\n{len(short)} warehouse(s) whose GeoJSON is short — port their zones directly:")
		for warehouse, gap in sorted(short, key=lambda x: -x[1]):
			print(f"  {warehouse:<26} {gap:,} children not described")
	return {"features": total_f, "children": total_c, "short": short}


def run(pattern=None, env_file=None, limit=None):
	"""Run the automations on the target, in warehouse order, timing each."""
	site = Target(env_file=env_file)
	docs = _docs(pattern)
	if limit:
		docs = docs[: int(limit)]

	print(f"target: {site.describe()}   (RUNNING {len(docs)} automation(s))\n")
	started = time.time()
	ok_count = fail_count = 0

	for i, doc in enumerate(docs, 1):
		t0 = time.time()
		response = site._request(
			"POST",
			"/api/method/run_doc_method",
			json={
				"dt": "Field Unit Automation",
				"dn": doc.name,
				"method": "run_automation",
			},
		)
		elapsed = time.time() - t0
		if response.ok:
			ok_count += 1
			print(f"  [{i}/{len(docs)}] {doc.warehouse:<26} {elapsed:>6.1f}s  ok")
		else:
			fail_count += 1
			body = response.text[:160].replace("\n", " ")
			print(f"  [{i}/{len(docs)}] {doc.warehouse:<26} {elapsed:>6.1f}s  FAILED {response.status_code} {body}")

	total = time.time() - started
	print(f"\n{ok_count} ok, {fail_count} failed in {total/60:.1f} min")
	if ok_count:
		print(f"  {total/ok_count:.1f}s per automation on average")
		remaining = frappe.db.count("Field Unit Automation") - len(docs)
		if remaining > 0:
			print(f"  at that rate, the remaining {remaining} would take "
			      f"{remaining * total / ok_count / 60:.0f} min")
	return {"ok": ok_count, "failed": fail_count, "seconds": total}
