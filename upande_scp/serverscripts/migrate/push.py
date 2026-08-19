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

import datetime
import decimal

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
	# ERPNext masters, not ours — carried only because the livestock records below
	# cannot resolve without them, and only the specific rows they reference (see
	# SELECTORS). Porting all 16,508 Items would be a different exercise entirely.
	(
		"ERPNext masters the livestock records need",
		["Item Group", "UOM", "Item", "BOM"],
	),
	("herds and animals", ["Herds", "Animal"]),
	("records that hang off an animal", ["Livestock Disposal", "Livestock Insurance Policy"]),
]

# Which rows to carry, for doctypes where "all of them" is the wrong answer.
# Each returns a list of names; anything absent from here ports in full.
SELECTORS = {
	"Item": lambda: _livestock_items(),
	"Item Group": lambda: sorted(
		{
			frappe.db.get_value("Item", i, "item_group")
			for i in _livestock_items()
		}
		- {None, ""}
	),
	"UOM": lambda: sorted(
		{frappe.db.get_value("Item", i, "stock_uom") for i in _livestock_items()}
		- {None, ""}
	),
	"BOM": lambda: _livestock_boms(),
}


def _livestock_boms():
	"""The feed BOMs, sub-BOMs included, ordered so a BOM never precedes one it uses.

	Two things make this more than "the BOMs the Herds point at". A BOM row can
	name another BOM (`BOM Item.bom_no`), so the set has to be closed over those
	references — `BOM-Dry Cows  Meal-002` is needed by a herd's BOM but is not a
	herd's BOM itself, and would otherwise be missed entirely. And ERPNext refuses
	a BOM whose sub-BOM is absent, so order matters: inserting the parent first
	fails with "Could not find Row #2: BOM No", which is exactly how this was
	found.
	"""
	roots = {b for b in frappe.get_all("Herds", pluck="bom") if b}

	# Close over sub-BOM references.
	needed, frontier = set(roots), set(roots)
	while frontier:
		rows = frappe.get_all(
			"BOM Item",
			filters={"parent": ["in", list(frontier)]},
			fields=["bom_no"],
			limit_page_length=0,
		)
		nxt = {r.bom_no for r in rows if r.bom_no} - needed
		needed |= nxt
		frontier = nxt

	# Dependencies first. A cycle would be an ERPNext data problem, not ours, so
	# anything still unplaced is appended rather than dropped — better to attempt
	# it and get a clear server error than to silently omit it.
	deps = {
		b: {
			r.bom_no
			for r in frappe.get_all(
				"BOM Item", filters={"parent": b}, fields=["bom_no"], limit_page_length=0
			)
			if r.bom_no and r.bom_no in needed
		}
		for b in needed
	}
	ordered, placed = [], set()
	while len(ordered) < len(needed):
		ready = sorted(b for b in needed if b not in placed and deps[b] <= placed)
		if not ready:
			ordered.extend(sorted(b for b in needed if b not in placed))
			break
		ordered.extend(ready)
		placed.update(ready)
	return ordered


def _livestock_items():
	"""The Items the feed BOMs reference — their outputs and their inputs.

	Cached per process, since several selectors ask for it."""
	global _ITEM_CACHE
	if _ITEM_CACHE is not None:
		return _ITEM_CACHE
	boms = _livestock_boms()
	need = {r.item for r in frappe.get_all("BOM", filters={"name": ["in", boms]}, fields=["item"])}
	need |= {
		r.item_code
		for r in frappe.get_all("BOM Item", filters={"parent": ["in", boms]}, fields=["item_code"])
	}
	# Deliberately NOT the `herd` asset item. It exists only to hang the 366 Herd
	# assets off, and those are not being ported — porting them would mean creating
	# GL accounts and an Asset Category on the target. Including it just produces a
	# failure on every run, since an asset item needs a category that is not there.
	_ITEM_CACHE = sorted(n for n in need if n)
	return _ITEM_CACHE


_ITEM_CACHE = None

# Child tables and links the target cannot resolve, dropped by explicit decision
# rather than silently failing. See the module docstring.
DROP_FIELDS = {
	("Crop Scouted", "farms"),
	# Every Animal points at a `Herd` Asset. Porting those would mean creating two
	# GL accounts in Karen Roses' chart of accounts and an Asset Category on the
	# target — a finance change, not a data copy. The field is optional, so the
	# animals go across complete for herd, breeding and health work and simply
	# carry no accounting counterpart. Decided explicitly, not for convenience.
	("Animal", "asset_link"),
	# Item and BOM reference each other: an Item's `default_bom` names a BOM, and
	# that BOM's rows name the Item. Neither can be first. Dropped here because
	# ERPNext repopulates `default_bom` itself when a BOM with `is_default` is
	# submitted — so the field comes back on its own, and nothing is lost.
	("Item", "default_bom"),
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

# Submitted here, so they must be submitted there. A plain insert always creates a
# draft — Frappe forces docstatus 0 on insert and ignores `docstatus` in the
# payload — so without an explicit submit these arrive unsubmitted and vanish from
# any report filtering on submitted.
SUBMIT_AFTER_INSERT = {"Animal", "Herds", "Livestock Disposal", "BOM"}

# Doctypes whose name carries no meaning (`autoname: hash`), matched on the fields
# that genuinely identify a record instead. Without this a re-run duplicates them,
# because Frappe assigns a new hash on insert and ignores the name we send.
NATURAL_KEYS = {
	"Pest Filter": ("pest", "crop_scouted"),
	"Disease Filter": ("disease", "crop_scouted"),
	"Breeders": ("breeder",),
	# ERPNext names a BOM from its item plus a per-item counter, so the target
	# issues its own number and the name never matches. One BOM per item here.
	"BOM": ("item",),
	# Naming series, so the target issues its own ANI-DISP number.
	"Livestock Disposal": ("animal", "disposal_date"),
	# `format:LIP-{####}` reads as content-derived but {####} is a series counter,
	# so this is series-named too despite the `format:` prefix.
	"Livestock Insurance Policy": ("policy_number",),
	# `field:warehouse`, and the warehouse is remapped — so the target names it
	# from the corrected name and the local name never matches. Keyed on the
	# warehouse, which the remap then translates.
	"Field Unit Automation": ("warehouse",),
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


def _jsonable(value):
	"""Coerce a field value into something `json` can serialise.

	Frappe hands back real `date`, `datetime`, `time` and `Decimal` objects. The
	JSON encoder raises on all of them, and the exception surfaced from inside the
	POST — killing the whole run rather than failing one record. `Item.end_of_life`
	was the first to hit it; every dated doctype after it would have too.
	"""
	if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
		return value.isoformat(sep=" ") if isinstance(value, datetime.datetime) else value.isoformat()
	if isinstance(value, decimal.Decimal):
		return float(value)
	if isinstance(value, datetime.timedelta):
		return str(value)
	return value


def _identity(row, key_fields):
	"""A natural key that compares equal across the wire.

	Locally a Date field is a `datetime.date`; the API returns `"2026-06-10"`. Those
	never match, so every record looked new — this silently created 27
	`Livestock Disposal` rows where there should have been 11, up to three copies
	each. Both sides are normalised through `_jsonable`, then to text, so the type a
	value happens to arrive as cannot decide identity.
	"""
	out = []
	for field in key_fields:
		value = _jsonable(row.get(field))
		out.append("" if value is None else str(value))
	return tuple(out)


def _link_targets(doctype):
	"""{fieldname: linked doctype} for this doctype's own Link fields."""
	return {
		f.fieldname: f.options
		for f in frappe.get_meta(doctype).fields
		if f.fieldtype == "Link" and f.options
	}


# Names the target assigned that differ from ours, learned during a run. ERPNext
# names a BOM itself — `BOM-Calves Meal-002` here can land as `-001` there — so a
# later `Herds.bom` would point at a name that does not exist. Anything created in
# this run is recorded here and subsequent references are rewritten, which covers
# every series- and hash-named doctype without needing to know in advance which
# ones will differ.
LEARNED = {}


def _remapped(value, linked_doctype):
	"""Rewrite a link value the target holds under another name."""
	learned = LEARNED.get(linked_doctype, {})
	if value in learned:
		return learned[value]
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
				rows.append({k: _jsonable(v) for k, v in cleaned.items()})
			if rows:
				out[key] = rows
			continue
		out[key] = _jsonable(_remapped(value, links[key]) if key in links else value)
	return out


def _plan_counts():
	return {dt: frappe.db.count(dt) for _label, group in STEPS for dt in group}


def _execute(site, write, log_path=None):
	LEARNED.clear()
	created, skipped, failed = [], [], []
	pruned, unsubmitted = [], []
	# A dict, so the nested insert loop can increment it without a nonlocal.
	counters = {"submitted": 0}
	lines = []

	# Whether one link value exists on the target, cached per (doctype, value).
	#
	# The obvious implementation — list every name of every linked doctype — hangs.
	# `Item` alone links out to a dozen doctypes through its child tables, and one of
	# those listings can be enormous. Values repeat heavily across rows, so a cached
	# per-value COUNT is both cheaper and bounded: a few hundred small requests
	# instead of a handful of unbounded ones.
	_exists = {}

	# What this run itself will add. Without it the resolver prunes rows pointing at
	# records created earlier in the same run — every `BOM Item` referencing a feed
	# Item we create two steps before would be dropped, leaving empty BOMs.
	planned = {}
	for _label, group in STEPS:
		for dt in group:
			selector = SELECTORS.get(dt)
			planned.setdefault(dt, set()).update(
				selector() if selector else frappe.get_all(dt, pluck="name")
			)

	def resolver(linked_doctype, value):
		if value in planned.get(linked_doctype, ()):
			return True
		key = (linked_doctype, value)
		if key not in _exists:
			state, count = site.probe(linked_doctype, [["name", "=", value]])
			# Not readable (child table, or no permission): assume it resolves rather
			# than pruning on a guess. A real problem then surfaces on insert with a
			# message, which beats silently dropping a row.
			_exists[key] = True if state != "ok" else bool(count)
		return _exists[key]

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
			selector = SELECTORS.get(doctype)
			wanted = selector() if selector else None
			
			if key_fields:
				# Match on content: the name is a series or a hash on one side or both.
				# The target's own name is fetched alongside, because a record we
				# *skip* also has to teach us what it is called there — see
				# `_learn_existing`.
				remote = site.get_list(doctype, ["name"] + list(key_fields))
				existing = {_identity(r, key_fields) for r in remote}
				remote_names = {_identity(r, key_fields): r["name"] for r in remote}
				filters = {"name": ["in", wanted]} if wanted is not None else None
				local = frappe.get_all(
					doctype,
					filters=filters,
					fields=["name"] + list(key_fields),
					order_by="name",
					limit_page_length=0,
				)
				if wanted is not None:
					# Restore the selector's order. `order_by="name"` discards it, and
					# for BOMs the order is the whole point: alphabetically
					# `BOM-Bullying Heifers-004` precedes the `BOM-Heifer Meal-002`
					# it depends on, so the parent was attempted first and failed
					# every time.
					rank = {n: i for i, n in enumerate(wanted)}
					local.sort(key=lambda r: rank.get(r["name"], len(rank)))
				# A key value that is itself remapped has to be compared in the target's
				# terms, or a record already there reads as missing.
				links = _link_targets(doctype)
				identities = {
					r["name"]: _identity(
						{
							f: _remapped(r.get(f), links[f]) if f in links else r.get(f)
							for f in key_fields
						},
						key_fields,
					)
					for r in local
				}
				names = [r["name"] for r in local]
			else:
				existing = site.names(doctype)
				remote_names = None
				identities = None
				names = (
					wanted
					if wanted is not None
					else frappe.get_all(doctype, pluck="name", order_by="name")
				)

			made = skip = fail = 0
			doc_docstatus = {}
			if doctype in SUBMIT_AFTER_INSERT:
				doc_docstatus = {
					r["name"]: r["docstatus"]
					for r in frappe.get_all(doctype, fields=["name", "docstatus"], limit_page_length=0)
				}

			for name in names:
				identity = identities[name] if identities else name
				if identity in existing:
					skip += 1
					skipped.append((doctype, name))
					# A record already there may be called something else — ERPNext
					# names a BOM itself, so `BOM-Calves Meal-002` here is `-001`
					# there. Learning it on the skip path too is what stops later
					# rows pointing at a name that does not exist. Missing this cost
					# 3 BOMs, 5 Herds, 185 Animals and 6 Disposals in one run: each
					# failed only because the thing it referenced was already
					# present under another name.
					if remote_names:
						there = remote_names.get(identity)
						if there and there != name:
							LEARNED.setdefault(doctype, {})[name] = there
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
				if not ok:
					fail += 1
					failed.append((doctype, name, result))
					lines.append(f"FAILED  {doctype}\t{name}\t{result}")
					continue

				made += 1
				existing.add(identity)
				if result and result != name:
					LEARNED.setdefault(doctype, {})[name] = result
				_exists[(doctype, result or name)] = True
				created.append((doctype, result or name))
				lines.append(f"OK      {doctype}\t{result or name}")

				# Submit only what is submitted here — a draft on this side stays a
				# draft there.
				if doctype in SUBMIT_AFTER_INSERT and doc_docstatus.get(name) == 1:
					sok, serr = site.submit(doctype, result or name)
					if sok:
						counters["submitted"] += 1
						lines.append(f"SUBMIT  {doctype}\t{result or name}")
					else:
						unsubmitted.append((doctype, result or name, serr))
						lines.append(f"NOSUBMIT {doctype}\t{result or name}\t{serr}")

			verb = "would create" if not write else "created"
			note = f", {fail} FAILED" if fail else ""
			print(f"  {doctype:<26} {verb} {made:>4}, skipped {skip:>4}{note}")

	if counters["submitted"]:
		print(f"\n  submitted {counters['submitted']} document(s) after insert")
	if unsubmitted:
		print(f"\n  {len(unsubmitted)} inserted but NOT submitted:")
		for dt, nm, why in unsubmitted[:8]:
			print(f"    {dt} {nm}: {str(why)[:150]}")

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
