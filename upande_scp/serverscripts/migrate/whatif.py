"""What would still block a port if a given set of masters were uploaded first.

    bench --site kaitet.local execute \
        upande_scp.serverscripts.migrate.whatif.run

Read-only. Answers "if we upload X, are we done?" without uploading X — it takes
the target's real state, adds the hypothetical rows on top, and re-checks every
reference at name level.

Worth having as its own tool because the interesting answer is never the headline
count. Uploading 78 avocado blocks sounds like it finishes the job; what it
actually leaves behind is two rose greenhouses and a handful of Items, which is
the kind of remainder that turns a "done" into another round trip.
"""

from __future__ import annotations

import frappe

from upande_scp.serverscripts.migrate.readiness import (
	ALREADY_PORTED,
	LIVESTOCK_OWNED,
	SCP_OWNED,
	_outbound,
	_values_used,
)
from upande_scp.serverscripts.migrate.target import Target


# Historical or retired, so not being ported at all. Excluded from the report
# rather than listed as blocked — a blocker on something nobody wants is noise.
NOT_WANTED = {
	"Livestock Event": "historical",
	"Livestock Health Case": "historical",
	"Livestock Diagnosis": "historical",
	"Milk Recording": "historical",
	"Milking Palour Checksheet": "retired, being removed",
}


def _hypothetical():
	"""What the operator is proposing to upload, as {doctype: {names}}."""
	from upande_scp.serverscripts.migrate.push import REMAP

	lokitela = set(
		frappe.get_all(
			"Warehouse",
			filters={"custom_farm": "Lokitela", "warehouse_type": ["in", ["Block", "Section"]]},
			pluck="name",
		)
	)
	endebess = set(
		frappe.get_all("Warehouse", filters={"custom_farm": "Endebess"}, pluck="name")
	)
	boms = set(frappe.get_all("Herds", pluck="bom")) - {None, ""}
	assets = set(frappe.get_all("Animal", pluck="asset_link")) - {None, ""}
	# The remap means a reference to the old name resolves to the new one, so for
	# readiness purposes the old names count as present.
	renamed = set(REMAP.get("Warehouse", {}))
	varieties = set(frappe.get_all("Field Unit Sector", pluck="sector")) - {None, ""}

	return {
		"Warehouse": lokitela | endebess | renamed,
		"BOM": boms,
		"Asset": assets,
		"Item": varieties,
	}, {
		"Lokitela blocks + sections": len(lokitela),
		"Endebess coffee blocks": len(endebess),
		"livestock feed BOMs": len(boms),
		"Assets linked to Animals": len(assets),
		"variety Items on layouts": len(varieties),
		"Torongo names remapped": len(renamed),
	}


def run(env_file=None):
	site = Target(env_file=env_file)
	extra, summary = _hypothetical()

	print(f"target: {site.describe()}   (read-only simulation)\n")
	print("assuming these are uploaded first:")
	for label, n in summary.items():
		print(f"  {label:<28} {n:>4}")
	print()

	cache = {}

	def on_target(doctype):
		if doctype not in cache:
			try:
				cache[doctype] = set(site.names(doctype))
			except Exception:
				cache[doctype] = None
			if cache[doctype] is not None and doctype in extra:
				cache[doctype] = cache[doctype] | extra[doctype]
		return cache[doctype]

	still_blocked, now_ready = [], []
	for app, owned in (("upande_scp", SCP_OWNED), ("upande_livestock", LIVESTOCK_OWNED)):
		print(f"=== {app} ===")
		for doctype in sorted(owned):
			if doctype in ALREADY_PORTED or not frappe.db.exists("DocType", doctype):
				continue
			if doctype in NOT_WANTED:
				print(f"  [skip]    {doctype:<26} {frappe.db.count(doctype):>6,}  "
				      f"{NOT_WANTED[doctype]}")
				continue
			here = frappe.db.count(doctype)
			if not here:
				continue
			problems = []
			for owner, fieldname, target_dt in sorted(set(_outbound(doctype, owned))):
				need = _values_used(owner, fieldname)
				if not need:
					continue
				have = on_target(target_dt)
				if have is None:
					problems.append(f"{target_dt} unreadable")
					continue
				missing = need - have
				if missing:
					sample = ", ".join(sorted(missing)[:3])
					problems.append(f"{target_dt} {len(missing)}/{len(need)} still missing [{sample}]")
			if problems:
				still_blocked.append((doctype, here, problems))
				print(f"  [blocked] {doctype:<26} {here:>6,}  {'; '.join(problems)}")
			else:
				now_ready.append((doctype, here))
				print(f"  [READY]   {doctype:<26} {here:>6,}")
		print()

	print("-" * 70)
	print(f"would become portable: {len(now_ready)} doctypes / "
	      f"{sum(n for _d, n in now_ready):,} rows")
	print(f"would still be blocked: {len(still_blocked)} doctypes / "
	      f"{sum(n for _d, n, _p in still_blocked):,} rows")
	return {"ready": now_ready, "blocked": still_blocked}
