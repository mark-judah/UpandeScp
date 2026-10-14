"""Crop-protection product resolution.

Single source of truth for "is this Item a spray product?" and for resolving a
product's effective rate/targets for a crop. Replaces the old hardcoded,
case-inconsistent `item_group in ("CHEMICALS"/...)` string tests.

Which Item Groups hold chemicals vs foliars is configured on the settings Single
(`chemical_item_groups` / `foliar_item_groups`), so the classification stays
data-driven — it now sets `Spray Product.category` rather than choosing between
two doctypes.

A product's metadata lives on the `Spray Product` sidecar (1:1 with the Item).
Per-crop rate limits live in its `crop_rates` child table, falling back to the
record's `default_lower_rate_limit` / `default_upper_rate_limit`.

## Why one doctype

This was `Chemical` and `Foliar`: identical field sets, plus a per-crop override
doctype each (`Chemical Crop Profile`, `Foliar Crop Profile`). Every reader had
to try both masters in turn, and the two override doctypes held zero rows on
every site — the override that mattered was always just a rate. `category`
carries the only distinction that does any work: which store the product is
issued from.
"""

import json
from datetime import timedelta
from urllib.parse import quote

import frappe
from frappe.utils import flt, get_datetime

# The settings Single. Kept as a constant so a future rename touches one place.
SETTINGS = "Scouting and Crop Protection Settings"

#: The one product doctype.
PRODUCT = "Spray Product"

#: `category` values, matching the settings tables that assign them.
CHEMICAL = "Chemical"
FOLIAR = "Foliar"


def _settings():
	return frappe.get_cached_doc(SETTINGS)


def chemical_groups():
	"""Item Group names configured as chemical groups."""
	return [r.item_group for r in (_settings().get("chemical_item_groups") or []) if r.item_group]


def foliar_groups():
	"""Item Group names configured as foliar groups."""
	return [r.item_group for r in (_settings().get("foliar_item_groups") or []) if r.item_group]


def product_groups(kind=None):
	"""Item Group names to filter Items by when listing crop-protection products.

	kind: 'chemical' | 'foliar' | None (both). Use this for every
	`item_group in (...)` filter instead of literal group names — a group added
	on the settings Chemicals tab must reach the Application Plan, the store
	dashboards and the reports without a code change.

	Returns a tuple so it drops straight into a SQL `IN %s` placeholder. Callers
	building raw SQL must still guard against the empty case (an unconfigured
	site), since `IN ()` is a syntax error.
	"""
	groups = []
	if kind in (None, "chemical"):
		groups += chemical_groups()
	if kind in (None, "foliar"):
		groups += foliar_groups()
	return tuple(groups)


def classify_item_group(item_group):
	"""Return 'chemical' | 'foliar' | None for an Item Group name."""
	if not item_group:
		return None
	if item_group in chemical_groups():
		return "chemical"
	if item_group in foliar_groups():
		return "foliar"
	return None


def is_foliar_group(item_group):
	"""True when `item_group` is configured as a foliar (fertilizer) group.

	The chemical-vs-fertilizer split decides which warehouse list a row gets
	(Chemical Store vs Fertilizer Unit), so it has to follow config too —
	this replaces the old `item_group == "Fertilizer"` tests.
	"""
	return classify_item_group(item_group) == "foliar"


def _product_name(item_code, category=None):
	"""Name of the Spray Product for `item_code`, or None.

	A disabled product is deliberately still resolvable: it is disabled because
	its Item left the configured groups, and existing BOMs, spray plans and QR
	labels must keep resolving their rates and re-entry intervals. Filtering
	happens where products are *offered*, not where they are read back.
	"""
	if not item_code:
		return None
	filters = {"item": item_code}
	if category:
		filters["category"] = category
	return frappe.db.get_value(PRODUCT, filters, "name")


def is_spray_product(item_code, category=None):
	"""True when this Item has a Spray Product record, optionally of a category."""
	return bool(_product_name(item_code, category))


def is_chemical(item_code):
	return is_spray_product(item_code, CHEMICAL)


def is_foliar(item_code):
	return is_spray_product(item_code, FOLIAR)


def get_spray_product(item_code, category=None):
	name = _product_name(item_code, category)
	return frappe.get_cached_doc(PRODUCT, name) if name else None


def get_chemical(item_code):
	return get_spray_product(item_code, CHEMICAL)


def get_foliar(item_code):
	return get_spray_product(item_code, FOLIAR)


def get_product_rate(item_code, crop=None):
	"""Effective (lower, upper) rate limits per 1000L.

	The `crop_rates` row for `crop` wins where it sets either bound; otherwise
	the product's `default_*` limits apply. Returns `(None, None)` for an Item
	with no Spray Product record, which callers already read as "no bound".
	"""
	name = _product_name(item_code)
	if not name:
		return (None, None)
	if crop:
		row = frappe.db.get_value(
			"Spray Product Crop Rate",
			{"parent": name, "parenttype": PRODUCT, "crop": crop},
			["lower_rate_limit", "upper_rate_limit"],
			as_dict=True,
		)
		if row and (row.lower_rate_limit or row.upper_rate_limit):
			return (row.lower_rate_limit, row.upper_rate_limit)
	d = frappe.db.get_value(
		PRODUCT, name,
		["default_lower_rate_limit", "default_upper_rate_limit"], as_dict=True,
	)
	return (d.default_lower_rate_limit, d.default_upper_rate_limit) if d else (None, None)


def get_product_targets(item_code, crop=None):
	"""Target rows (list of {pest, disease}) for this product.

	`crop` is accepted and ignored: targets are a property of the product, not
	of the crop it is sprayed on. The per-crop override doctype that used to
	hold them held zero rows on every site, and only rates were ever varied per
	crop — which `crop_rates` now does. Kept in the signature so callers read
	the same as `get_product_rate` beside them.
	"""
	name = _product_name(item_code)
	if not name:
		return []
	# `parenttype` matters: the record's name is the item code, so filtering on
	# `parent` alone also matches the Item's own child rows.
	return frappe.get_all(
		"Chemical Targets",
		filters={
			"parent": name,
			"parenttype": PRODUCT,
			"parentfield": "default_targets",
		},
		fields=["pest", "disease"],
	)


def get_product_type(item_code):
	"""Product type (Insecticide/Fungicide/...) from the sidecar, else None."""
	name = _product_name(item_code)
	return frappe.db.get_value(PRODUCT, name, "type") if name else None


def get_product_codes(item_code, kind):
	"""IRAC/FRAC/GHS code values from the product's sidecar.

	kind: 'irac' | 'frac' | 'ghs'. Child doctype is e.g. 'IRAC Code Filter'.
	"""
	name = _product_name(item_code)
	if not name:
		return []
	rows = frappe.get_all(
		f"{kind.upper()} Code Filter",
		filters={"parent": name, "parenttype": PRODUCT, "parentfield": kind},
		fields=["code"],
	)
	return [r.code for r in rows if r.code]


def get_reentry_interval_hrs(item_code):
	"""Re-entry interval (hours) from the product's sidecar, or 0.

	Chemicals and foliars alike carry one. Replaces the deleted
	`Item.custom_reentry_interval_hrs`.
	"""
	name = _product_name(item_code)
	return flt(frappe.db.get_value(PRODUCT, name, "reentry_interval_hrs")) if name else 0.0


@frappe.whitelist()
def max_reentry_interval_hrs(item_codes):
	"""Longest re-entry interval across `item_codes` — the binding one for a
	tank mix, since the block stands until the slowest chemical clears.

	Whitelisted: the Work Order Desk form calls this directly. Accepts a JSON
	string (from the client) or a list.
	"""
	if isinstance(item_codes, str):
		item_codes = json.loads(item_codes)
	if not item_codes:
		return 0.0
	return max(
		(get_reentry_interval_hrs(c) for c in item_codes if c),
		default=0.0,
	)


def reentry_time(scheduled, hours):
	"""Scheduled application time + re-entry hours, as a Frappe datetime string.

	Returns None when there's no scheduled time to offset from (an unscheduled
	plan has no meaningful re-entry moment). `hours` of 0 is legitimate — a mix
	with no re-entry restriction clears immediately.
	"""
	if not scheduled:
		return None
	return get_datetime(scheduled) + timedelta(hours=flt(hours))


def crop_protection_item_codes(kind=None):
	"""Item codes under the configured chemical/foliar groups.

	kind: 'chemical' | 'foliar' | None (both). Replaces the old
	`{"item_group": "CHEMICALS"}` filters.
	"""
	groups = product_groups(kind)
	if not groups:
		return []
	codes = frappe.get_all("Item", filters={"item_group": ["in", groups]}, pluck="name")
	if not codes:
		return []
	# Drop products that were disabled by an Item Group change. They stay
	# resolvable by item code — existing BOMs and labels depend on that — but
	# they are no longer offered anywhere a product is chosen.
	disabled = set(
		frappe.get_all(
			PRODUCT,
			filters={"item": ["in", codes], "disabled": 1},
			pluck="item",
			limit_page_length=0,
		)
	)
	return [c for c in codes if c not in disabled]


# Legacy Item custom_* fields copied into a new sidecar. Scalars first, then
# child tables (source custom field -> sidecar field).
_LEGACY_SCALARS = {
	"custom_type": "type",
	"custom_toxicity": "toxicity",
	"custom_reentry_interval_hrs": "reentry_interval_hrs",
	"custom_lower_rate_limit": "default_lower_rate_limit",
	"custom_upper_rate_limit": "default_upper_rate_limit",
	"custom_low_stock_threshold": "low_stock_threshold",
	"custom_irac_moa": "irac_moa",
	"custom_frac_moa": "frac_moa",
	"custom_ghs_description": "ghs_description",
}
_LEGACY_CHILDREN = {
	"custom_active_ingredients": "active_ingredients",
	"custom_targets": "default_targets",
	"custom_chemical_intervention_threshhold": "default_requirements",
	"custom_irac": "irac",
	"custom_frac": "frac",
	"custom_ghs": "ghs",
}
_CHILD_STD = {
	"name", "parent", "parenttype", "parentfield", "idx", "doctype",
	"owner", "creation", "modified", "modified_by", "docstatus",
}


def _copy_legacy_fields(item, doc):
	"""Copy an Item's chemical custom_* values into a new sidecar doc."""
	for src, dst in _LEGACY_SCALARS.items():
		val = item.get(src)
		if val not in (None, ""):
			doc.set(dst, val)
	for src, dst in _LEGACY_CHILDREN.items():
		for row in (item.get(src) or []):
			d = row.as_dict()
			doc.append(dst, {k: v for k, v in d.items()
			                 if k not in _CHILD_STD and not str(k).startswith("_")})


#: `classify_item_group` returns these; `Spray Product.category` stores these.
_CATEGORY_BY_KIND = {"chemical": CHEMICAL, "foliar": FOLIAR}


def ensure_product_record(item_code):
	"""Create a Spray Product for an Item whose group is configured, if absent.

	Copies any legacy Item ``custom_*`` values. Returns ``(PRODUCT, name)`` when
	one was created, else None.
	"""
	item_group = frappe.db.get_value("Item", item_code, "item_group")
	category = _CATEGORY_BY_KIND.get(classify_item_group(item_group))
	if not category or is_spray_product(item_code):
		return None
	item = frappe.get_doc("Item", item_code)
	doc = frappe.new_doc(PRODUCT)
	doc.item = item_code
	doc.category = category
	_copy_legacy_fields(item, doc)
	doc.insert(ignore_permissions=True)
	return (PRODUCT, doc.name)


def sync_product_to_item_group(item_code):
	"""Reconcile an Item's Spray Product with its current Item Group.

	Three transitions, and the third is the one that had no handling at all:

	* **Into** a configured group — create the record, or re-enable it if the
	  Item is coming back.
	* **Between** a chemical group and a foliar group — update ``category``, so
	  the product starts being issued from the right store.
	* **Out of** every configured group — set ``disabled``. The record, its
	  rates, its IRAC/FRAC codes and its targets are kept, because BOMs, past
	  spray plans and issued QR labels still reference it; deleting would break
	  them and lose metadata the moment somebody re-groups the Item by mistake.

	Returns a short verb describing what changed, or None. Idempotent.
	"""
	item_group = frappe.db.get_value("Item", item_code, "item_group")
	category = _CATEGORY_BY_KIND.get(classify_item_group(item_group))
	name = _product_name(item_code)

	if not name:
		return "created" if category and ensure_product_record(item_code) else None

	current = frappe.db.get_value(
		PRODUCT, name, ["category", "disabled"], as_dict=True
	)

	if not category:
		if current.disabled:
			return None
		frappe.db.set_value(PRODUCT, name, "disabled", 1)
		return "disabled"

	changes = {}
	if current.disabled:
		changes["disabled"] = 0
	if current.category != category:
		changes["category"] = category
	if not changes:
		return None
	frappe.db.set_value(PRODUCT, name, changes)
	return "recategorised" if "category" in changes else "re-enabled"


def on_item_after_insert(doc, method=None):
	"""doc_events hook: auto-register a new spray-product Item and say so."""
	try:
		result = ensure_product_record(doc.name)
	except Exception:
		frappe.logger().exception("crop_protection.on_item_after_insert failed")
		return
	if result:
		_, name = result
		link = f"/app/spray-product/{quote(name)}"
		frappe.msgprint(
			f'Registered as a Spray Product. <a href="{link}">Open the record</a> '
			"to add its metadata.",
			title="Crop Protection",
			indicator="green",
		)


def on_item_update(doc, method=None):
	"""doc_events hook: follow the Item's group in and out of the configured set.

	Only an ``item_group`` change is interesting, and Items are saved constantly
	for unrelated reasons, so the hook exits immediately otherwise.
	"""
	before = doc.get_doc_before_save()
	if before is not None and before.item_group == doc.item_group:
		return
	try:
		action = sync_product_to_item_group(doc.name)
	except Exception:
		frappe.logger().exception("crop_protection.on_item_update failed")
		return
	if action == "disabled":
		frappe.msgprint(
			f"{doc.name} left the configured crop-protection Item Groups, so its "
			"Spray Product record was disabled. Its rates and codes are kept — "
			"move the Item back to re-enable it.",
			title="Crop Protection",
			indicator="orange",
		)
	elif action == "recategorised":
		frappe.msgprint(
			f"{doc.name} moved between chemical and foliar Item Groups. Its Spray "
			"Product category was updated, so it will now be issued from the other "
			"store.",
			title="Crop Protection",
			indicator="orange",
		)


@frappe.whitelist()
def export_to_chemicals():
	"""Backfill: ensure a Spray Product exists for every Item under the
	configured chemical groups. Idempotent."""
	return _export("chemical")


@frappe.whitelist()
def export_to_foliars():
	"""Backfill: ensure a Spray Product exists for every Item under the
	configured foliar groups. Idempotent."""
	return _export("foliar")


@frappe.whitelist()
def resync_products():
	"""Reconcile every Spray Product with its Item's current Item Group.

	The settings-page counterpart to the `on_update` hook: an Item Group can be
	added to or removed from the settings tables long after the Items in it were
	last saved, and nothing re-examines them. This does.

	Returns counts per action so the page can say what changed.
	"""
	from collections import Counter

	tally = Counter()
	for code in frappe.get_all(PRODUCT, pluck="item", limit_page_length=0):
		tally[sync_product_to_item_group(code) or "unchanged"] += 1
	for kind in ("chemical", "foliar"):
		for code in crop_protection_item_codes(kind):
			if not is_spray_product(code) and ensure_product_record(code):
				tally["created"] += 1
	frappe.db.commit()
	return dict(tally)


def item_dashboard(data):
	"""override_doctype_dashboards hook: link an Item to its Spray Product
	(linked via the ``item`` field, not by name)."""
	data.setdefault("non_standard_fieldnames", {})
	data["non_standard_fieldnames"][PRODUCT] = "item"
	data.setdefault("transactions", [])
	data["transactions"].append({
		"label": "Crop Protection",
		"items": [PRODUCT],
	})
	return data


def _export(kind):
	created = 0
	codes = crop_protection_item_codes(kind)
	for code in codes:
		if ensure_product_record(code):
			created += 1
	frappe.db.commit()
	return {"kind": kind, "scanned": len(codes), "created": created}


def item_uom_options(item_code):
	"""ERPNext's own allowed UOMs for an item: ``[{uom, conversion_factor}]``.

	Read straight from the Item's `UOM Conversion Detail` rows (the standard
	ERPNext mechanism), with the stock UOM guaranteed present at factor 1. No
	conversion table lives in this app — a "1 bottle = 500 g" constant in code
	would drift from whatever the user maintains on the Item, so the Item is the
	only source of truth and the operator's choice is limited to what it allows.

	`conversion_factor` follows the ERPNext convention: **stock-UOM quantity per
	1 of this UOM**. So for a Bottle-stocked item where 1 bottle is 500 g, Gram
	carries 0.002 and 1000 g resolves to 2 bottles.
	"""
	if not item_code:
		return []
	stock_uom = frappe.db.get_value("Item", item_code, "stock_uom")
	if not stock_uom:
		return []
	rows = frappe.get_all(
		"UOM Conversion Detail",
		filters={"parent": item_code, "parenttype": "Item"},
		fields=["uom", "conversion_factor"],
		order_by="idx asc",
	)
	out = [{"uom": stock_uom, "conversion_factor": 1.0}]
	seen = {stock_uom}
	for r in rows:
		uom = (r.get("uom") or "").strip()
		cf = flt(r.get("conversion_factor"))
		if not uom or uom in seen or cf <= 0:
			continue
		seen.add(uom)
		out.append({"uom": uom, "conversion_factor": cf})
	return out


def to_stock_qty(item_code, qty, uom=None):
	"""Convert `qty` expressed in `uom` into the item's stock UOM.

	Uses the item's own ERPNext conversion factor. Falls back to a 1:1 pass
	through when the UOM isn't one the item allows, so an unexpected value can't
	silently scale a quantity by a guess.
	"""
	q = flt(qty)
	if not item_code or not uom:
		return q
	for opt in item_uom_options(item_code):
		if opt["uom"] == uom:
			return q * flt(opt["conversion_factor"])
	return q
