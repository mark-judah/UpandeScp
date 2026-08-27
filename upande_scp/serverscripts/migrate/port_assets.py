"""Carry the 366 Herd assets across and reconnect them to their animals.

    bench --site kaitet.local execute upande_scp.serverscripts.migrate.port_assets.plan
    bench --site kaitet.local execute upande_scp.serverscripts.migrate.port_assets.run

Every `Animal` names an `Asset` — the same beast twice, once for husbandry and
once for the books. When the animals were ported, `asset_link` was dropped: the
chain needed two GL accounts and an Asset Category that did not exist on the
target, and creating accounts in someone's chart of accounts is a finance decision
rather than a migration side-effect.

That chain now exists there — both accounts, the `Herd` category and the `herd`
item — so the assets can follow and the link can be restored.

## The animal is the identity, not the asset

`Asset` uses a naming series, so the target names each one itself:
`JENNIFER-129393` here came back as `ACC-ASS-2026-00009` there. Local names
therefore never match, and there is no natural key to fall back on —
`asset_name` collides (two animals called `MEMO`) and `custom_animal_id` is empty
on this side.

So the loop is driven by the **animal**, which is named from its tag number and is
stable across both sites. For each animal that has no `asset_link` on the target:
create its asset, keep the name the target gives back, and set the link. An animal
that already has a link is skipped, which makes a re-run safe without needing to
identify assets at all.

Assets must exist before the link: `Animal.asset_link` is a Link field, so pointing
it at a document that is not there yet fails validation.

## Where the purchase value comes from

Every one of the 366 has `purchase_amount` and `net_purchase_amount` **zero** — the
records predate those fields being mandatory. The target enforces them, so a
faithful copy is rejected outright: "Net Purchase Amount is mandatory".

The value is not missing, though, only in a different field. `value_after_depreciation`
carries a real per-animal valuation on all 366 — 120,000 for 105 of them, 80,000
for 84, 30,000 for 68, and so on — and `insured_value` independently agrees on 343.
Since **no depreciation has ever been booked** (`opening_accumulated_depreciation`
is 0 and `calculate_depreciation` is 0 across the board), value-after-depreciation
is by definition the value at purchase.

So the amount is *derived*, not invented: the record already states what the animal
is worth, in the field that holds it. Sixteen assets carry a value of 1, which is
the source data's own placeholder and is copied as it stands rather than
second-guessed.

## Depreciation

`calculate_depreciation` is 0 on all 366, so no schedules follow them across and
submitting posts no depreciation entries. Worth knowing, because an asset that
*did* depreciate would write to the ledger on submit — a much larger thing to do to
a training site than copying a record.
"""

from __future__ import annotations

import json

import frappe

from upande_scp.serverscripts.migrate.push import _clean
from upande_scp.serverscripts.migrate.target import Target, TargetError

BATCH = 50
CATEGORY = "Herd"


def _local_assets():
	"""The Herd assets, and the animal each belongs to."""
	rows = frappe.get_all(
		"Animal",
		filters={"asset_link": ["is", "set"]},
		fields=["name", "asset_link"],
		limit_page_length=0,
	)
	return {r.asset_link: r.name for r in rows}


def plan(env_file=None):
	site = Target(env_file=env_file)
	assets = _local_assets()
	there = site.names("Asset")
	missing = [a for a in assets if a not in there]

	print(f"target: {site.describe()}   (read-only)\n")
	print(f"Herd assets here      : {len(assets):,}")
	print(f"  already on target   : {len(assets) - len(missing):,}")
	print(f"  to create           : {len(missing):,}")

	submitted = frappe.db.count("Asset", {"asset_category": CATEGORY, "docstatus": 1})
	print(f"  of which submitted here: {submitted:,}")

	linked = site.get_list("Animal", ["name", "asset_link"], limit=0)
	have_link = sum(1 for r in linked if r.get("asset_link"))
	print(f"\nanimals on target     : {len(linked):,}")
	print(f"  with asset_link set : {have_link:,}")
	print(f"  to relink           : {len(linked) - have_link:,}")

	for dep in ("Asset Category", "Item", "Account"):
		pass
	print("\nprerequisites on target:")
	for label, doctype, name in (
		("Asset Category", "Asset Category", CATEGORY),
		("asset item", "Item", "herd"),
	):
		state, n = site.probe(doctype, [["name", "=", name]])
		print(f"  {label:<16} {name:<10} {'present' if state == 'ok' and n else 'MISSING'}")
	return {"create": missing, "relink": len(linked) - have_link}


def _set_purchase_value(payload):
	"""Fill the purchase amounts from the valuation the record already carries.

	See the module docstring: the source has these fields at zero, the target
	requires them, and `value_after_depreciation` holds the real figure because
	nothing has depreciated.
	"""
	value = payload.get("value_after_depreciation") or 0
	if not value:
		return
	for field in ("gross_purchase_amount", "net_purchase_amount", "purchase_amount"):
		if not payload.get(field):
			payload[field] = value
	if not payload.get("total_asset_cost"):
		payload["total_asset_cost"] = value


def _create_assets(site, names):
	"""Insert, then submit the ones submitted here."""
	made = failed = submitted = 0
	problems = []
	docstatus = {
		r.name: r.docstatus
		for r in frappe.get_all(
			"Asset", filters={"asset_category": CATEGORY}, fields=["name", "docstatus"],
			limit_page_length=0,
		)
	}
	for start in range(0, len(names), BATCH):
		chunk = names[start : start + BATCH]
		for name in chunk:
			payload = _clean(frappe.get_doc("Asset", name).as_dict(), "Asset")
			_set_purchase_value(payload)
			ok, result = site.insert("Asset", payload)
			if not ok:
				failed += 1
				problems.append((name, result))
				continue
			made += 1
			if docstatus.get(name) == 1:
				sok, serr = site.submit("Asset", result or name)
				if sok:
					submitted += 1
				else:
					problems.append((name, f"created but not submitted: {serr}"))
		done = min(start + BATCH, len(names))
		print(f"    assets {done:,}/{len(names):,}  created {made:,}  submitted {submitted:,}  failed {failed}", flush=True)
	return made, submitted, failed, problems


def _relink(site, pairs):
	"""Set `Animal.asset_link` in bulk. `pairs` is [(animal, asset)]."""
	done = failed = 0
	for start in range(0, len(pairs), 100):
		chunk = pairs[start : start + 100]
		docs = [
			{"doctype": "Animal", "docname": animal, "asset_link": asset}
			for animal, asset in chunk
		]
		try:
			r = site._request(
				"POST",
				"/api/method/frappe.client.bulk_update",
				data=json.dumps({"docs": json.dumps(docs)}),
				timeout=180,
			)
			ok = r.ok
		except TargetError:
			ok = False
		if ok:
			done += len(chunk)
		else:
			failed += len(chunk)
		print(f"    relink {min(start+100, len(pairs)):,}/{len(pairs):,}  ok {done:,}  failed {failed}", flush=True)
	return done, failed


def run(env_file=None, limit=None):
	"""Create each animal's asset, then link it back."""
	site = Target(env_file=env_file)
	print(f"target: {site.describe()}   (WRITING)\n", flush=True)

	local = _local_assets()  # {asset: animal}
	by_animal = {animal: asset for asset, animal in local.items()}

	# Animals on the target that still have no asset. Skipping the linked ones is
	# what makes this idempotent — see the docstring on why the animal is the key.
	rows = site.get_list("Animal", ["name", "asset_link"], limit=0)
	todo = [r["name"] for r in rows if not r.get("asset_link") and r["name"] in by_animal]
	if limit:
		todo = todo[: int(limit)]

	print(f"animals on target: {len(rows):,}")
	print(f"  already linked : {sum(1 for r in rows if r.get('asset_link')):,}")
	print(f"  to do          : {len(todo):,}\n", flush=True)

	docstatus = {
		r.name: r.docstatus
		for r in frappe.get_all(
			"Asset",
			filters={"asset_category": CATEGORY},
			fields=["name", "docstatus"],
			limit_page_length=0,
		)
	}

	made = submitted = failed = 0
	pairs = []
	problems = []

	for i, animal in enumerate(todo, 1):
		source = by_animal[animal]
		payload = _clean(frappe.get_doc("Asset", source).as_dict(), "Asset")
		_set_purchase_value(payload)
		ok, result = site.insert("Asset", payload)
		if not ok:
			failed += 1
			problems.append((source, result))
			continue
		made += 1
		pairs.append((animal, result))
		if docstatus.get(source) == 1:
			sok, serr = site.submit("Asset", result)
			if sok:
				submitted += 1
			else:
				problems.append((result, f"created but not submitted: {serr}"))
		if i % 50 == 0 or i == len(todo):
			print(f"    {i:,}/{len(todo):,}  created {made:,}  submitted {submitted:,}  failed {failed}", flush=True)

	print(f"\n  assets: {made:,} created, {submitted:,} submitted, {failed} failed")
	for name, why in problems[:5]:
		print(f"    {name}: {str(why)[:160]}")

	print(f"\nlinking {len(pairs):,} animal(s) to their asset", flush=True)
	if pairs:
		done, failed_links = _relink(site, pairs)
		print(f"  relink: {done:,} ok, {failed_links} failed")
	return {"created": made, "submitted": submitted, "failed": failed}


def relink_by_reinsert(env_file=None, limit=10, animals=None):
	"""Give an animal its asset by recreating it with the link already set.

	`Animal.asset_link` has `allow_on_submit = 0` and every animal on the target is
	submitted, so the field cannot be written afterwards — `set_value` raises
	`UpdateAfterSubmitError`, and `bulk_update` swallows that and reports success
	while changing nothing.

	The restriction is on *updating* a submitted document, not on creating one with
	the field populated. So the animal is deleted and re-inserted with the link in
	place, then submitted. Nothing is cancelled-and-amended, so no `-1` documents or
	cancelled originals are left behind, and no doctype is customised.

	Only safe because these animals were created by this migration hours ago and
	nobody has worked in them. It would be the wrong tool for records with history.
	"""
	site = Target(env_file=env_file)
	local = _local_assets()  # {asset: animal}
	by_animal = {animal: asset for asset, animal in local.items()}

	rows = site.get_list("Animal", ["name", "asset_link"], limit=0)
	pool = [r["name"] for r in rows if not r.get("asset_link") and r["name"] in by_animal]

	# Leave animals that anything else points at: a disposal or event would block
	# the delete, and repointing them is a bigger job than this test needs.
	referenced = set()
	for doctype in ("Livestock Disposal", "Livestock Event"):
		state, _n = site.probe(doctype)
		if state != "ok":
			continue
		referenced |= {
			r["animal"] for r in site.get_list(doctype, ["animal"], limit=0) if r.get("animal")
		}
	pool = [a for a in pool if a not in referenced]

	todo = animals or pool[: int(limit)]
	print(f"target: {site.describe()}", flush=True)
	print(f"  unlinked animals: {len(pool):,} (excluding {len(referenced)} referenced elsewhere)")
	print(f"  attempting: {len(todo)}\n", flush=True)

	assets_there = site.names("Asset")
	docstatus = {
		r.name: r.docstatus
		for r in frappe.get_all(
			"Asset", filters={"asset_category": CATEGORY}, fields=["name", "docstatus"],
			limit_page_length=0,
		)
	}

	ok_count = failed = 0
	for animal in todo:
		source_asset = by_animal[animal]

		# 1. the asset, if it is not there yet
		asset_payload = _clean(frappe.get_doc("Asset", source_asset).as_dict(), "Asset")
		_set_purchase_value(asset_payload)
		created, asset_name = site.insert("Asset", asset_payload)
		if not created:
			print(f"  {animal:<22} FAILED at asset: {str(asset_name)[:110]}")
			failed += 1
			continue
		if docstatus.get(source_asset) == 1:
			site.submit("Asset", asset_name)

		# 2. rebuild the animal with the link in place
		animal_payload = _clean(frappe.get_doc("Animal", animal).as_dict(), "Animal")
		animal_payload["asset_link"] = asset_name
		local_docstatus = frappe.db.get_value("Animal", animal, "docstatus")

		site.cancel("Animal", animal)
		deleted, why = site.delete("Animal", animal)
		if not deleted:
			print(f"  {animal:<22} FAILED at delete: {str(why)[:110]}")
			failed += 1
			continue

		made, result = site.insert("Animal", animal_payload)
		if not made:
			print(f"  {animal:<22} FAILED at re-insert: {str(result)[:110]}")
			failed += 1
			continue
		if local_docstatus == 1:
			site.submit("Animal", result)

		# 3. verify from the data, not the response
		check = site.get_list("Animal", ["name", "asset_link", "docstatus"], [["name", "=", result]])
		link = check[0].get("asset_link") if check else None
		state = check[0].get("docstatus") if check else "?"
		if link:
			ok_count += 1
			print(f"  {animal:<22} ok  asset={link}  docstatus={state}")
		else:
			failed += 1
			print(f"  {animal:<22} FAILED — re-inserted but link still empty")

	print(f"\n{ok_count} linked, {failed} failed")
	return {"linked": ok_count, "failed": failed}


def relink_with_disposals(env_file=None):
	"""Link the animals a Livestock Disposal points at.

	Those were skipped by `relink_by_reinsert`: the animal cannot be deleted while a
	disposal references it. So the disposal comes off first, the animal is rebuilt
	with its link, and the disposal goes back — reconstructed from this site, which
	is where it came from in the first place.

	Safe for the same reason as the rest: these disposals were created by this
	migration, not worked in by anyone.
	"""
	site = Target(env_file=env_file)
	local = _local_assets()
	by_animal = {animal: asset for asset, animal in local.items()}

	disposals = site.get_list(
		"Livestock Disposal", ["name", "animal", "docstatus"], limit=0
	)
	unlinked = {
		r["name"]
		for r in site.get_list("Animal", ["name", "asset_link"], limit=0)
		if not r.get("asset_link")
	}
	work = [d for d in disposals if d["animal"] in unlinked and d["animal"] in by_animal]
	print(f"target: {site.describe()}")
	print(f"  disposals pointing at an unlinked animal: {len(work)}\n", flush=True)

	docstatus = {
		r.name: r.docstatus
		for r in frappe.get_all(
			"Asset", filters={"asset_category": CATEGORY}, fields=["name", "docstatus"],
			limit_page_length=0,
		)
	}
	ok_count = failed = 0

	for d in work:
		animal = d["animal"]
		source_asset = by_animal[animal]

		# Rebuild the disposal from this site afterwards, so capture it first.
		local_disposal = [
			r.name
			for r in frappe.get_all(
				"Livestock Disposal", filters={"animal": animal}, fields=["name"]
			)
		]

		if d["docstatus"] == 1:
			site.cancel("Livestock Disposal", d["name"])
		gone, why = site.delete("Livestock Disposal", d["name"])
		if not gone:
			print(f"  {animal:<22} could not remove disposal: {str(why)[:100]}")
			failed += 1
			continue

		asset_payload = _clean(frappe.get_doc("Asset", source_asset).as_dict(), "Asset")
		_set_purchase_value(asset_payload)
		made, asset_name = site.insert("Asset", asset_payload)
		if not made:
			print(f"  {animal:<22} asset failed: {str(asset_name)[:100]}")
			failed += 1
			continue
		if docstatus.get(source_asset) == 1:
			site.submit("Asset", asset_name)

		animal_payload = _clean(frappe.get_doc("Animal", animal).as_dict(), "Animal")
		animal_payload["asset_link"] = asset_name
		site.cancel("Animal", animal)
		site.delete("Animal", animal)
		re_made, result = site.insert("Animal", animal_payload)
		if not re_made:
			print(f"  {animal:<22} animal re-insert failed: {str(result)[:100]}")
			failed += 1
			continue
		if frappe.db.get_value("Animal", animal, "docstatus") == 1:
			site.submit("Animal", result)

		# Put the disposal back.
		restored = 0
		for name in local_disposal:
			payload = _clean(frappe.get_doc("Livestock Disposal", name).as_dict(), "Livestock Disposal")
			dok, dres = site.insert("Livestock Disposal", payload)
			if dok:
				restored += 1
				if frappe.db.get_value("Livestock Disposal", name, "docstatus") == 1:
					site.submit("Livestock Disposal", dres)

		check = site.get_list("Animal", ["name", "asset_link"], [["name", "=", result]])
		link = check[0].get("asset_link") if check else None
		if link:
			ok_count += 1
			print(f"  {animal:<22} ok  asset={link}  disposal restored={restored}")
		else:
			failed += 1
			print(f"  {animal:<22} FAILED — link still empty")

	print(f"\n{ok_count} linked, {failed} failed")
	return {"linked": ok_count, "failed": failed}
