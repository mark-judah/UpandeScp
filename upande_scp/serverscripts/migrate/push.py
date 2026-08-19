"""Copy SCP reference data to another site, one document at a time.

    bench --site kaitet.local execute \
        upande_scp.serverscripts.migrate.push.dry_run
    bench --site kaitet.local execute \
        upande_scp.serverscripts.migrate.push.run

Reads locally through bench and writes over REST. `dry_run` makes no writes at
all; `run` is the same code path with the POST enabled, so what you preview is
what happens.

## Idempotency

Most doctypes here name themselves from a field, so a document's name is a
function of its content: re-running finds `Pest/Aphids` present and skips it.

**`autoname: hash` breaks that.** `Pest Filter` and `Disease Filter` get a fresh
random name from Frappe on insert — the name in the payload is ignored — so local
and target names never match even when both hold the same 40 records. A name-based
check reports "nothing there yet" and a second run duplicates the lot. It was
caught by a dry run reporting `would create 40, skipped 0` against a site that
already had all 40.

So those doctypes are matched on a **natural key** instead: the fields that
actually identify the record. `NATURAL_KEYS` lists them, and each is verified
unique on this site by the tests. Anything not listed falls back to matching on
name, which is correct for `field:`, `format:` and `prompt` naming.

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
	# The spatial layer. Independent of each other, and of everything above, but
	# it waited on the target having the warehouses these point at.
	(
		"traps, tanks and field layouts",
		["Trap", "Tank And Valve", "Field Unit Automation"],
	),
	("livestock reference", ["Breeders"]),
]

# Child tables and links the target cannot resolve, dropped by explicit decision
# rather than silently failing. See the module docstring.
DROP_FIELDS = {
	("Crop Scouted", "farms"),
}

# Records the target holds under a different name, keyed by the doctype being
# linked to, so every field pointing at it is rewritten consistently — a value
# remap, not a per-field one.
#
# Torongo GH 17 and 18 were renamed to include a space. The target adopted the
# corrected names; this bench still has the originals as the *live* records, with
# the spaced versions present but disabled. So the data here is right and only its
# labels are stale, which is exactly the case a remap is for — rewriting on the
# way out is honest, whereas creating a second warehouse on the target would
# reintroduce the duplicate the rename existed to remove.
REMAP = {
	"Warehouse": {
		"Torongo GH17 - KR": "Torongo GH 17 - KR",
		"Torongo GH18 - KR": "Torongo GH 18 - KR",
	},
}

# Doctypes whose name carries no meaning (`autoname: hash`), matched on the fields
# that genuinely identify a record instead. Without this a re-run duplicates them,
# because Frappe assigns a new hash on insert and ignores the name we send.
NATURAL_KEYS = {
	"Pest Filter": ("pest", "crop_scouted"),
	"Disease Filter": ("disease", "crop_scouted"),
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


def _link_targets(doctype):
	"""{fieldname: linked doctype} for this doctype's own Link fields."""
	return {
		f.fieldname: f.options
		for f in frappe.get_meta(doctype).fields
		if f.fieldtype == "Link" and f.options
	}


def _remapped(value, linked_doctype):
	"""Rewrite a link value the target holds under another name."""
	table = REMAP.get(linked_doctype)
	if not table:
		return value
	return table.get(value, value)


def _clean(doc_dict, doctype, resolver=None, pruned=None):
	"""A payload the target will accept: our content, none of our bookkeeping.

	`resolver(doctype, value) -> bool` says whether a link can resolve on the
	target. When it cannot, the child row carrying it is **dropped** and recorded
	in `pruned`, rather than left to fail the whole parent.

	That trade is deliberate and worth stating: three `Field Unit Sector` rows
	point at rose varieties that were retired and are absent from the target. Left
	in, they take two whole greenhouse layouts down with them. Dropped, those
	greenhouses import and lose only the variety mapping for the affected bed
	ranges. A mandatory child field cannot be blanked, so removing the row is the
	only way to keep the parent — and losing a range mapping beats losing the
	layout. Every drop is reported; none is silent.
	"""
	links = _link_targets(doctype)
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
				child_dt = row.get("doctype")
				child_links = _link_targets(child_dt) if child_dt else {}
				cleaned = {
					k: _remapped(v, child_links[k]) if k in child_links else v
					for k, v in row.items()
					if k not in _CHILD_META
				}
				if resolver:
					unresolved = [
						(f, cleaned[f])
						for f, linked_dt in child_links.items()
						if cleaned.get(f) and not resolver(linked_dt, cleaned[f])
					]
					if unresolved:
						if pruned is not None:
							for field, val in unresolved:
								pruned.append((doctype, child_dt, field, val))
						continue
				rows.append(cleaned)
			if rows:
				out[key] = rows
			continue
		out[key] = _remapped(value, links[key]) if key in links else value
	return out


def _plan_counts():
	return {dt: frappe.db.count(dt) for _label, group in STEPS for dt in group}


def _execute(site, write, log_path=None):
	created, skipped, failed = [], [], []
	pruned = []
	lines = []

	# Cache of names present on the target, so pruning costs one listing per
	# linked doctype rather than one request per row.
	_names = {}

	def resolver(linked_doctype, value):
		if linked_doctype not in _names:
			try:
				_names[linked_doctype] = site.names(linked_doctype)
			except Exception:
				# Cannot list it (child table, or no permission). Assume it
				# resolves rather than pruning on a guess — a real failure will
				# surface on insert with a message.
				_names[linked_doctype] = None
		known = _names[linked_doctype]
		return True if known is None else value in known

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

			key_fields = NATURAL_KEYS.get(doctype)
			if key_fields:
				# Match on content, since the name is a random hash on both sides.
				existing = {
					tuple(r.get(f) for f in key_fields)
					for r in site.get_list(doctype, list(key_fields))
				}
				local = frappe.get_all(
					doctype, fields=["name"] + list(key_fields), order_by="name"
				)
				identities = {
					r["name"]: tuple(r.get(f) for f in key_fields) for r in local
				}
				names = [r["name"] for r in local]
			else:
				existing = site.names(doctype)
				identities = None
				names = frappe.get_all(doctype, pluck="name", order_by="name")

			made = skip = fail = 0

			for name in names:
				identity = identities[name] if identities else name
				if identity in existing:
					skip += 1
					skipped.append((doctype, name))
					continue
				payload = _clean(
					frappe.get_doc(doctype, name).as_dict(),
					doctype,
					resolver=resolver,
					pruned=pruned,
				)
				if not write:
					made += 1
					existing.add(identity)
					created.append((doctype, name))
					continue
				ok, result = site.insert(doctype, payload)
				if ok:
					made += 1
					existing.add(identity)
					created.append((doctype, result or name))
					lines.append(f"OK      {doctype}\t{result or name}")
				else:
					fail += 1
					failed.append((doctype, name, result))
					lines.append(f"FAILED  {doctype}\t{name}\t{result}")

			verb = "would create" if not write else "created"
			note = f", {fail} FAILED" if fail else ""
			print(f"  {doctype:<26} {verb} {made:>4}, skipped {skip:>4}{note}")

	if pruned:
		print(f"\n  pruned {len(pruned)} child row(s) whose links are absent on the target:")
		for parent_dt, child_dt, field, value in pruned:
			print(f"    {parent_dt} / {child_dt}.{field} = {value!r}")
			lines.append(f"PRUNED  {parent_dt}\t{child_dt}.{field}\t{value}")

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
