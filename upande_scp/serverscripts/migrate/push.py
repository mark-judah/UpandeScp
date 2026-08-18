"""Copy SCP reference data to another site, one document at a time.

    bench --site kaitet.local execute \
        upande_scp.serverscripts.migrate.push.dry_run
    bench --site kaitet.local execute \
        upande_scp.serverscripts.migrate.push.run

Reads locally through bench and writes over REST. `dry_run` makes no writes at
all; `run` is the same code path with the POST enabled, so what you preview is
what happens.

## Idempotency

Every doctype here names itself from a field, so a document's name is a function
of its content: re-running finds `Pest/Aphids` already present and skips it rather
than duplicating or 409-ing. That is what makes a partial run safe to repeat —
and a partial run is the expected case, since one bad record must not abandon the
other 340.

## What gets stripped

Frappe metadata (`owner`, `creation`, `modified`, `idx`, tags, comments) is
dropped: it belongs to this site, not the target, and `modified` in particular
would make the target think documents are older than its own.

`DROP_FIELDS` removes references the target cannot resolve. Today that is
`Crop Scouted.farms`, which restricts a crop to particular farms — the target has
none, so those rows cannot import, and without dropping them `Crop Scouted` fails
and takes `Pest Filter` and `Disease Filter` with it. Dropping is reversible;
failing is not.

## Attachments are not copied

`Attach Image` fields keep their `/files/...` path. The file itself is not sent,
so those images 404 on the target until the files are copied across separately.
The alternative — blanking them — would lose the association and require redoing
the work by hand, so the path is kept deliberately.
"""

from __future__ import annotations

import frappe

from upande_scp.serverscripts.migrate.target import Target, TargetError

# Load order. A step may only reference doctypes from earlier steps.
STEPS = [
	(
		"observation and code masters",
		[
			"Pest",
			"Plant Disease",
			"Plant Section",
			"Stage",
			"FRAC Code",
			"IRAC Code",
			"GHS Code",
			"Incident",
			"Physiological Disorder",
			"Weed",
		],
	),
	("predators", ["Predator"]),
	("crops", ["Crop Scouted"]),
	(
		"per-crop filters and code guidelines",
		["Pest Filter", "Disease Filter", "FRAC Guideline", "IRAC Guideline"],
	),
]

# Child tables and links the target cannot resolve, dropped by explicit decision
# rather than silently failing. See the module docstring.
DROP_FIELDS = {
	("Crop Scouted", "farms"),
}

# Never sent: they describe this site's bookkeeping, not the document.
_META_FIELDS = {
	"owner",
	"creation",
	"modified",
	"modified_by",
	"idx",
	"docstatus",
	"_user_tags",
	"_comments",
	"_assign",
	"_liked_by",
	"doctype",
}
_CHILD_META = _META_FIELDS | {"name", "parent", "parenttype", "parentfield"}


def _clean(doc_dict, doctype):
	"""A payload the target will accept: our content, none of our bookkeeping."""
	out = {}
	for key, value in doc_dict.items():
		if key in _META_FIELDS:
			continue
		if (doctype, key) in DROP_FIELDS:
			continue
		if isinstance(value, list):
			rows = []
			for row in value:
				if not isinstance(row, dict):
					continue
				rows.append({k: v for k, v in row.items() if k not in _CHILD_META})
			if rows:
				out[key] = rows
			continue
		out[key] = value
	return out


def _plan_counts():
	return {dt: frappe.db.count(dt) for _label, group in STEPS for dt in group}


def _execute(site, write, log_path=None):
	created, skipped, failed = [], [], []
	lines = []

	for label, doctypes in STEPS:
		print(f"\n--- {label} ---")
		for doctype in doctypes:
			state, _n = site.probe(doctype)
			if state != "ok":
				msg = f"{doctype}: cannot read on target ({state}) — skipping"
				print(f"  {msg}")
				failed.append((doctype, "*", state))
				lines.append(msg)
				continue

			existing = site.names(doctype)
			names = frappe.get_all(doctype, pluck="name", order_by="name")
			made = skip = fail = 0

			for name in names:
				if name in existing:
					skip += 1
					skipped.append((doctype, name))
					continue
				payload = _clean(frappe.get_doc(doctype, name).as_dict(), doctype)
				if not write:
					made += 1
					created.append((doctype, name))
					continue
				ok, result = site.insert(doctype, payload)
				if ok:
					made += 1
					created.append((doctype, result or name))
					lines.append(f"OK      {doctype}\t{result or name}")
				else:
					fail += 1
					failed.append((doctype, name, result))
					lines.append(f"FAILED  {doctype}\t{name}\t{result}")

			verb = "would create" if not write else "created"
			note = f", {fail} FAILED" if fail else ""
			print(f"  {doctype:<26} {verb} {made:>4}, skipped {skip:>4}{note}")

	if log_path and lines:
		with open(log_path, "w") as fh:
			fh.write("\n".join(lines) + "\n")
		print(f"\nlog: {log_path}")

	return created, skipped, failed


def _report(created, skipped, failed, write):
	print("\n" + "=" * 66)
	if write:
		print(f"created {len(created)}, already present {len(skipped)}, failed {len(failed)}")
	else:
		print(f"would create {len(created)}, already present {len(skipped)}")
	if failed:
		print("\nfailures:")
		shown = {}
		for doctype, name, why in failed:
			shown.setdefault(doctype, []).append((name, why))
		for doctype, rows in shown.items():
			print(f"  {doctype} ({len(rows)}):")
			for name, why in rows[:5]:
				print(f"    {name}: {str(why)[:180]}")
			if len(rows) > 5:
				print(f"    … and {len(rows) - 5} more")


def dry_run(env_file=None):
	"""Report what `run` would create. Makes no writes."""
	site = Target(env_file=env_file)
	print(f"target: {site.describe()}   (DRY RUN — nothing will be written)")
	created, skipped, failed = _execute(site, write=False)
	_report(created, skipped, failed, write=False)
	return {"would_create": len(created), "already": len(skipped)}


def run(env_file=None, log_path="/tmp/scp_push.log"):
	"""Do it."""
	site = Target(env_file=env_file)
	print(f"target: {site.describe()}   (WRITING)")
	created, skipped, failed = _execute(site, write=True, log_path=log_path)
	_report(created, skipped, failed, write=True)
	return {"created": len(created), "already": len(skipped), "failed": len(failed)}
