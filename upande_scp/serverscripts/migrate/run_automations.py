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

Re-running is safe, twice over: the automation itself counts existing units and
children as skipped, and `run` skips a warehouse whose children are already all
there, so resuming after an interruption costs nothing.

## Pacing, and why it is not optional

Per-document time climbed steadily as the target filled — 9s on the first farm,
46s by the fourth — and then the site returned `SessionStopped` (HTTP 503) and
`Bad Gateway`, taking three documents down with it. The rising times were the site
saying it could not keep up; driving straight through them is what broke it.

So there is a pause between documents, and a longer one after anything goes wrong.
`stop_after` gives up rather than burning through the remaining work against a dead
site, and `wait_for_site` lets it recover instead of counting an outage as a data
failure. On a shared staging box, finishing slowly beats finishing the site.

## A successful response is not a success either

The automation logs its own insert failures and carries on, so a run in which every
single row was rejected still returns HTTP 200 and a cheerful summary. Testing one
Lokitela block produced exactly that: `ok` in 4.3 seconds, and zero rows and zero
trees created, because the farm did not declare `Has Rows`. Left as it was, this
would have marched through all 77 blocks reporting success while writing nothing.

So the child count is checked on **every** outcome, not only when the request
errors. A 200 that produced nothing is reported as a failure, because that is what
it is.

## A dropped connection is not a failure

Large greenhouses exceed the gateway's patience — `Chepsito GH 14` took long enough
that the connection was closed with `RemoteDisconnected`, and the job **still
finished**, all 252 beds and 1,902 zones. So the client giving up says nothing about
the server. Every request is wrapped, and on a network error the outcome is decided
by counting what actually landed rather than by whether a response arrived.

That check has to wait before it counts. `Kaptumbo GH 08` returned Bad Gateway, was
counted immediately, showed zero, and was recorded as failed — when in fact all
1,428 zones arrived moments later. Counting too eagerly turns a success into a
reported failure, which is the more misleading of the two directions.
"""

from __future__ import annotations

import json
import time

import frappe

from upande_scp.serverscripts.migrate.push import REMAP
from upande_scp.serverscripts.migrate.target import Target, TargetError


def _there(warehouse):
	"""The name the target holds this warehouse under.

	`Field Unit Automation` is named after its warehouse, and two Torongo
	warehouses were renamed to include a space — the target adopted the corrected
	names, this bench still has the originals. So the document to call is
	`Torongo GH 17 - KR` there while it is `Torongo GH17 - KR` here. Without this
	the call 404s and the warehouse reads as having no children, which is exactly
	how `Torongo GH 17 - KR` came to sit with 504 beds and zero zones.
	"""
	return REMAP.get("Warehouse", {}).get(warehouse, warehouse)


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


def _children_on_target(site, warehouse, unit_type):
	"""How many children the target already holds for this warehouse."""
	warehouse = _there(warehouse)
	if unit_type == "Bed":
		state, count = site.probe("Zone", [["greenhouse", "=", warehouse]])
	elif unit_type == "Band":
		state, count = site.probe("Triad", [["block", "=", warehouse]])
	else:
		state, count = site.probe("Orchard Tree", [["block", "=", warehouse]])
	return count if state == "ok" else None


def _wait_for_site(site, tries=10, gap=20):
	"""Block until the target answers, or give up. Returns True if it is back."""
	for attempt in range(tries):
		try:
			site.whoami()
			return True
		except TargetError:
			if attempt == 0:
				print(f"      target not answering; waiting up to {tries * gap}s")
			time.sleep(gap)
	return False


def run(
	pattern=None,
	env_file=None,
	limit=None,
	skip_done=True,
	pause=5,
	settle=10,
	stop_after=3,
	call_timeout=600,
):
	"""Run the automations on the target, in warehouse order, timing each.

	Args:
		skip_done: leave alone any warehouse whose children are already present, so
			this doubles as the resume path after an interruption.
		pause: seconds between documents, to keep the target ahead of us.
		settle: seconds to wait before counting, when a request errors or drops —
			the work often lands just after the response gives up.
		stop_after: consecutive failures that end the run. Continuing past a site
			that has stopped answering just converts every remaining warehouse into
			a spurious failure.
		call_timeout: seconds to wait on one automation. The biggest layouts run for
			minutes, and giving up early abandons the work rather than just losing
			sight of it.
	"""
	site = Target(env_file=env_file)
	docs = _docs(pattern)
	if limit:
		docs = docs[: int(limit)]

	print(f"target: {site.describe()}   ({len(docs)} automation(s), "
	      f"{pause}s between each)\n")
	started = time.time()
	ok_count = fail_count = skip_count = 0
	consecutive_failures = 0

	for i, doc in enumerate(docs, 1):
		expected = _features(
			frappe.db.get_value("Field Unit Automation", doc.name, "units_geojson")
		)
		if skip_done and expected:
			have = _children_on_target(site, doc.warehouse, doc.unit_type)
			if have is not None and have >= expected:
				skip_count += 1
				print(f"  [{i}/{len(docs)}] {doc.warehouse:<26} {'':>7}  already done ({have:,})")
				continue

		t0 = time.time()
		try:
			response = site._request(
				"POST",
				"/api/method/run_doc_method",
				json={
					"dt": "Field Unit Automation",
					"dn": _there(doc.name),
					"method": "run_automation",
				},
				# Long enough for the biggest layout. The default 60s is not:
				# `Torongo GH 17 - KR` describes 4,032 features and timed out
				# client-side with nothing written, so the job was abandoned rather
				# than merely unobserved.
				timeout=call_timeout,
			)
			dropped = None
		except TargetError as e:
			# The gateway stopped waiting. That says nothing about the job, which
			# keeps running — so ask the data, not the response.
			response, dropped = None, str(e)

		elapsed = time.time() - t0

		if response is not None and response.ok:
			# Do not take the 200 at face value: the automation swallows its own
			# insert failures, so "succeeded" and "created something" are different
			# claims. Ask the data.
			have = _children_on_target(site, doc.warehouse, doc.unit_type)
			if not expected or have is None or have >= expected:
				ok_count += 1
				consecutive_failures = 0
				print(f"  [{i}/{len(docs)}] {doc.warehouse:<26} {elapsed:>6.1f}s  ok")
			else:
				fail_count += 1
				consecutive_failures += 1
				print(f"  [{i}/{len(docs)}] {doc.warehouse:<26} {elapsed:>6.1f}s  "
				      f"FAILED — returned ok but only {have:,} of {expected:,} children exist")
				if consecutive_failures >= stop_after:
					print(f"      {consecutive_failures} failures in a row — stopping")
					break
			if pause and i < len(docs):
				time.sleep(pause)
			continue

		# A drop or an error response. The work may still be landing, so give it a
		# moment before counting — see the module docstring on Kaptumbo GH 08.
		if settle:
			time.sleep(settle)
		if not _wait_for_site(site):
			fail_count += 1
			print(f"  [{i}/{len(docs)}] {doc.warehouse:<26} {elapsed:>6.1f}s  "
			      f"FAILED — target is not answering, stopping")
			break

		have = _children_on_target(site, doc.warehouse, doc.unit_type)
		if have is not None and expected and have >= expected:
			ok_count += 1
			consecutive_failures = 0
			why = "connection dropped" if dropped else f"HTTP {response.status_code}"
			print(f"  [{i}/{len(docs)}] {doc.warehouse:<26} {elapsed:>6.1f}s  "
			      f"ok ({why}, but {have:,} children landed)")
		else:
			fail_count += 1
			consecutive_failures += 1
			detail = dropped or response.text[:120].replace("\n", " ")
			print(f"  [{i}/{len(docs)}] {doc.warehouse:<26} {elapsed:>6.1f}s  "
			      f"FAILED ({have if have is not None else '?'} of {expected:,}) {detail}")
			if consecutive_failures >= stop_after:
				print(f"      {consecutive_failures} failures in a row — stopping rather "
				      f"than hammering the target")
				break

		# Something went wrong, so give it longer than the usual pause.
		if pause and i < len(docs):
			time.sleep(pause * 3)

	total = time.time() - started
	print(f"\n{ok_count} ok, {skip_count} already done, {fail_count} failed "
	      f"in {total/60:.1f} min")
	ran = ok_count or 1
	if ok_count:
		print(f"  {total/ran:.1f}s per automation actually run")
	return {"ok": ok_count, "skipped": skip_count, "failed": fail_count, "seconds": total}
