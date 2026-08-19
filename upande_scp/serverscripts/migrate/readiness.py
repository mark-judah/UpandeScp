"""Which doctypes could port to the target *right now*, checked at name level.

    bench --site kaitet.local execute \
        upande_scp.serverscripts.migrate.readiness.run

Makes no writes. Run it again after each upload to the target — the answer moves
as masters arrive.

## Why name level, and not row counts

"Does the target have Warehouses?" is the wrong question. It once had five — the
ERPNext defaults — and **none** of the 173 that `Field Unit Automation` actually
references, so a count-based check called it ready and every insert would have
failed on link validation.

So for each doctype this collects the distinct values its outbound links actually
use, and asks whether *those names* exist on the target. A doctype is only ready
when every reference it holds can resolve.

Child tables are followed, because a parent whose grid rows point at missing
records fails just as surely as one whose own field does.
"""

from __future__ import annotations

import frappe

from upande_scp.serverscripts.migrate.target import Target

# Everything either app owns that holds data, so internal links can be told from
# external ones: internal links are handled by load order, external ones are the
# risk.
SCP_OWNED = {
	"Pest", "Plant Disease", "Plant Section", "Stage", "FRAC Code", "IRAC Code",
	"GHS Code", "Incident", "Physiological Disorder", "Weed", "Predator",
	"Crop Scouted", "Pest Filter", "Disease Filter", "FRAC Guideline",
	"IRAC Guideline", "Chemical", "Foliar", "Trap", "Tank And Valve",
	"Field Unit Automation", "Spray Team",
}
LIVESTOCK_OWNED = {
	"Herds", "Livestock Disease", "Livestock Event Type", "Breeders", "Animal",
	"Livestock Event", "Livestock Health Case", "Livestock Disposal",
	"Milking Palour Checksheet", "Milk Recording", "Livestock Diagnosis",
	"Livestock Insurance Policy", "Breed", "Calf Rearing", "Livestock Weight Record",
}

def already_ported(site, doctype, here):
	"""True when the target holds at least as many rows as this site.

	Asked of the target rather than kept as a list, because a hardcoded list goes
	stale the moment a wave lands — which it did: after the spatial wave, a static
	set still reported `Trap` as outstanding work.

	A count is a coarse test and deliberately so. Establishing identity properly
	would mean pulling every natural key over the wire for 1,320 traps to answer a
	question the operator is asking to *plan* with; `push` re-checks identity
	per record anyway and skips what is present, so a wrong guess here costs a
	line in a report, never a duplicate.
	"""
	state, there = site.probe(doctype)
	return state == "ok" and there is not None and here > 0 and there >= here

GROUPS = [
	("upande_scp", SCP_OWNED),
	("upande_livestock", LIVESTOCK_OWNED),
]


def _outbound(doctype, owned, seen=None):
	"""[(owner_doctype, fieldname, target_doctype)] for links leaving the app."""
	seen = seen or set()
	if doctype in seen:
		return []
	seen.add(doctype)
	out = []
	for f in frappe.get_meta(doctype).fields:
		if f.fieldtype == "Link" and f.options and f.options not in owned:
			out.append((doctype, f.fieldname, f.options))
		elif f.fieldtype in ("Table", "Table MultiSelect") and f.options:
			out.extend(_outbound(f.options, owned, seen))
	return out


def _values_used(owner, fieldname):
	try:
		rows = frappe.get_all(owner, fields=[fieldname], limit_page_length=0)
	except Exception:
		return set()
	return {r[fieldname] for r in rows if r.get(fieldname)}


def run(env_file=None):
	site = Target(env_file=env_file)
	print(f"target: {site.describe()}   (read-only)\n")

	cache = {}

	def on_target(doctype):
		if doctype not in cache:
			try:
				cache[doctype] = site.names(doctype)
			except Exception:
				cache[doctype] = None
		return cache[doctype]

	summary = {"done": [], "ready": [], "blocked": []}

	for app, owned in GROUPS:
		print(f"=== {app} ===")
		for doctype in sorted(owned):
			if not frappe.db.exists("DocType", doctype):
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
					problems.append(
						f"{target_dt} {len(missing)}/{len(need)} missing"
						+ (f" (via {owner}.{fieldname})" if owner != doctype else "")
					)

			if already_ported(site, doctype, here):
				summary["done"].append(doctype)
				print(f"  {'[done]':<9} {doctype:<26} {here:>6,}  on target")
			elif problems:
				summary["blocked"].append((doctype, here, problems))
				print(f"  {'[blocked]':<9} {doctype:<26} {here:>6,}  {'; '.join(problems)}")
			else:
				summary["ready"].append((doctype, here))
				print(f"  {'[READY]':<9} {doctype:<26} {here:>6,}  every reference resolves")
		print()

	ready_rows = sum(n for _dt, n in summary["ready"])
	print("-" * 70)
	print(f"already ported : {len(summary['done'])} doctypes")
	print(f"ready now      : {len(summary['ready'])} doctypes / {ready_rows:,} rows")
	for dt, n in summary["ready"]:
		print(f"                 {dt} ({n:,})")
	print(f"still blocked  : {len(summary['blocked'])} doctypes / "
	      f"{sum(n for _dt, n, _p in summary['blocked']):,} rows")
	return summary
