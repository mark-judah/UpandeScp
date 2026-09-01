"""Check a target site is ready to receive the seed data, before writing anything.

    bench --site kaitet.local execute \
        upande_scp.serverscripts.migrate.preflight.run

Reads credentials from `~/.scp_migrate_staging_env` (see `target.py`) and makes only GET
requests — nothing here writes.

## What it is actually looking for

The push itself is small: ~1,700 rows. Almost everything that can go wrong is a
property of the *target*, and each failure mode below is one we would otherwise
discover halfway through a run:

* **the app is not installed** — every insert 404s;
* **prerequisite masters are missing** — `Chemical` links to `Item`, every SCP
  master scopes to a `Farm`, and the whole of scouting resolves through `Bed` and
  `Zone`, which belong to `upande_core`. A bare site cannot be seeded from this
  plan alone, and it is better to know that now than after 500 rows;
* **custom fields are missing** — 1,231 of them on this site have `module = NULL`,
  meaning they were made through Customize Form and do **not** install with the
  app. A missing one fails as `1054 Unknown column` at query time, long after the
  import reported success;
* **data is already there** — so a run can skip rather than collide.

It reports rather than throws, because the useful output is the whole picture,
not the first problem in the list.
"""

from __future__ import annotations

import frappe

from upande_scp.serverscripts.migrate import plan
from upande_scp.serverscripts.migrate.target import Target, TargetError

TICK, CROSS, WARN, DOT = "ok  ", "FAIL", "warn", "  · "


def _rule(title):
	print(f"\n{title}\n{'-' * max(len(title), 52)}")


def run(env_file=None):
	try:
		site = Target(env_file=env_file)
	except TargetError as e:
		print(f"{CROSS} {e}")
		return

	print(f"target: {site.describe()}")

	blocking = []
	warnings = []

	# ---------------------------------------------------------------- auth
	_rule("Authentication")
	try:
		user = site.whoami()
	except TargetError as e:
		print(f"{CROSS} {e}")
		return
	print(f"{TICK} authenticated as {user}")
	if user in ("Guest", None):
		blocking.append("the key resolves to Guest — it cannot write")
		print(f"{CROSS} Guest cannot create documents")

	# ---------------------------------------------------------------- apps
	_rule("Are the apps installed?")
	installed = {}
	for app, probe in (("upande_scp", "Pest"), ("upande_livestock", "Animal")):
		try:
			present = site.doctype_exists(probe)
		except TargetError as e:
			print(f"{CROSS} {app}: {e}")
			present = False
		installed[app] = present
		print(f"{TICK if present else CROSS} {app} " + ("installed" if present else f"NOT installed (no `{probe}` doctype)"))
		if not present:
			blocking.append(f"{app} is not installed on the target")

	# ------------------------------------------------------- prerequisites
	_rule("Prerequisites (owned by upande_core / ERPNext, not ours to push)")
	forbidden = []
	for doctype, owner, why in plan.PREREQUISITE_DOCTYPES:
		here = frappe.db.count(doctype) if frappe.db.exists("DocType", doctype) else 0
		state, there = site.probe(doctype)
		if state == "missing":
			print(f"{CROSS} {doctype:<15} not on target            ({owner} — {why})")
			blocking.append(f"{doctype} does not exist on the target")
		elif state == "forbidden":
			print(f"{CROSS} {doctype:<15} no read permission       ({owner} — {why})")
			forbidden.append(doctype)
		elif state == "error":
			print(f"{WARN} {doctype:<15} could not check: {there}")
			warnings.append(f"could not check {doctype}")
		elif there == 0:
			print(f"{WARN} {doctype:<15} present but EMPTY        here {here:>7,}   ({why})")
			warnings.append(f"{doctype} is empty on the target")
		else:
			print(f"{TICK} {doctype:<15} {there:>7,} rows          here {here:>7,}")

	if forbidden:
		blocking.append(
			"the API user cannot read " + ", ".join(forbidden)
			+ " — grant it the roles that own them (Stock Manager, HR User and so on), "
			"or the push cannot validate its links"
		)

	# ------------------------------------------------------- custom fields
	_rule("Custom fields (module IS NULL — these do NOT install with the app)")
	total_missing = 0
	for host in plan.CUSTOM_FIELD_HOSTS:
		mine = {
			r.fieldname
			for r in frappe.get_all(
				"Custom Field", filters={"dt": host}, fields=["fieldname"], limit_page_length=0
			)
		}
		if not mine:
			continue
		try:
			theirs = {
				r["fieldname"]
				for r in site.get_list(
					"Custom Field", ["fieldname"], [["dt", "=", host]]
				)
			}
		except TargetError as e:
			print(f"{WARN} {host:<14} could not read Custom Field on target ({e})")
			warnings.append(f"could not compare custom fields on {host}")
			continue
		missing = sorted(mine - theirs)
		total_missing += len(missing)
		if missing:
			shown = ", ".join(missing[:6]) + (" …" if len(missing) > 6 else "")
			print(f"{CROSS} {host:<14} {len(missing):>3} of {len(mine)} missing: {shown}")
		else:
			print(f"{TICK} {host:<14} all {len(mine)} present")
	if total_missing:
		blocking.append(
			f"{total_missing} custom fields are missing on the target — "
			"these fail as `1054 Unknown column` at query time, not at import"
		)

	# ------------------------------------------------------ what we'd push
	_rule("What this plan would push")
	grand_new = grand_have = 0
	for app, steps in plan.STEPS.items():
		if not installed.get(app):
			print(f"{DOT}{app}: skipped, not installed")
			continue
		print(f"\n  {app}")
		for label, doctypes in steps:
			print(f"    {label}")
			for dt in doctypes:
				here = frappe.db.count(dt) if frappe.db.exists("DocType", dt) else 0
				state, there = site.probe(dt)
				if state == "missing":
					print(f"      {CROSS} {dt:<28} not on target")
					blocking.append(f"{dt} does not exist on the target")
					continue
				if state == "forbidden":
					print(f"      {CROSS} {dt:<28} no read permission")
					blocking.append(f"the API user cannot read {dt}")
					continue
				if state == "error":
					print(f"      {WARN} {dt:<28} could not check: {there}")
					warnings.append(f"could not check {dt}")
					continue
				grand_new += max(0, here - there)
				grand_have += there
				note = "" if there == 0 else f"  ({there:,} already there)"
				print(f"      {TICK} {dt:<28} {here:>6,} here{note}")

	print(f"\n  ≈{grand_new:,} rows to create, {grand_have:,} already on the target")
	print(f"  singles to set by hand: "
	      + ", ".join(s for app in plan.SINGLES for s in plan.SINGLES[app]))

	# ---------------------------------------------------------------- verdict
	_rule("Verdict")
	if blocking:
		print(f"{CROSS} NOT ready — {len(blocking)} blocking issue(s):")
		for b in blocking:
			print(f"    - {b}")
	else:
		print(f"{TICK} ready to receive the seed data")
	for w in warnings:
		print(f"{WARN} {w}")
	if not blocking:
		print("\n  next: dry_run.run() to see exactly what would be created")
	return {"blocking": blocking, "warnings": warnings, "to_create": grand_new}
