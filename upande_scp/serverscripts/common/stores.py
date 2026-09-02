"""Which warehouse a farm issues chemicals and foliars from.

``Farm.custom_chemical_store`` and ``Farm.custom_fertilizer_store`` are the
mapping. They are authoritative here, and the Application Plan's store lock
already treats them that way.

## Why the name fallback survives

The obvious cleanup is to delete the ``LIKE 'Chemical Store%'`` matching
entirely — it hardcodes a warehouse-naming convention into an app that must
install anywhere, and it was duplicated across six call sites in two modules.

The data says not yet. On kaitet, five farms (Lokitela, Saboti, Vale, Chepsito,
Endebess) have a chemical-store warehouse but no ``custom_chemical_store`` link,
so removing the fallback would silently stop loaning working for them — a
regression dressed as a cleanup.

So the convention stays, but it now lives in exactly one module instead of six,
it is clearly the *second* thing tried, and ``unmapped_farms`` names the farms
that are relying on it. Once those five are mapped, ``STORE_NAME_PREFIXES`` and
``_by_name`` can be deleted outright and nothing else has to change.
"""

import frappe

#: kind -> the `Farm` link field holding that store.
STORE_LINK_FIELDS = {
	"chemical": "custom_chemical_store",
	"foliar": "custom_fertilizer_store",
}

#: kind -> the legacy warehouse-name prefix. Fallback only; see the module
#: docstring for the conditions under which this can go.
STORE_NAME_PREFIXES = {
	"chemical": "Chemical Store",
	"foliar": "Fertilizer Store",
}


def _by_name(farm: str, kind: str) -> list:
	prefix = STORE_NAME_PREFIXES.get(kind)
	if not prefix:
		return []
	return frappe.get_all(
		"Warehouse",
		filters={
			"custom_farm": farm,
			"is_group": 0,
			"disabled": 0,
			"name": ("like", f"{prefix}%"),
		},
		pluck="name",
		order_by="name asc",
	)


def farm_stores(farm: str | None, kind: str = "chemical") -> list:
	"""Warehouses ``farm`` issues ``kind`` from — the link, else the name match.

	A list rather than a single name because a farm can legitimately have more
	than one store under the naming convention (kaitet's Kapkolia has both its
	own store and the garage store), and stock has to be summed across them.
	"""
	if not farm:
		return []
	field = STORE_LINK_FIELDS.get(kind)
	if field:
		mapped = frappe.db.get_value("Farm", farm, field)
		if mapped:
			return [mapped]
	return _by_name(farm, kind)


def primary_store(farm: str | None, kind: str = "chemical") -> str | None:
	"""The one store to post against. ``None`` when the farm has none."""
	stores = farm_stores(farm, kind)
	if not stores:
		return None
	if len(stores) == 1:
		return stores[0]
	# Several name-matched stores: prefer the one named for the farm itself over
	# an auxiliary like "Chemical Store - Garage".
	prefix = f"{STORE_NAME_PREFIXES.get(kind, '')} {farm}".lower()
	preferred = [s for s in stores if s.lower().startswith(prefix)]
	return (preferred or stores)[0]


def farms_with_stores() -> set:
	"""Every farm that can issue chemicals or foliars at all.

	Link-mapped farms plus farms whose store is only name-matched, so this
	answers the same question the old warehouse sweep did without enumerating
	warehouses by name at the call site.
	"""
	farms = set(
		frappe.get_all(
			"Farm",
			or_filters=[[f, "is", "set"] for f in STORE_LINK_FIELDS.values()],
			pluck="name",
		)
	)
	rows = frappe.get_all(
		"Warehouse",
		filters={"is_group": 0, "disabled": 0, "custom_farm": ("is", "set")},
		or_filters=[
			["name", "like", f"{prefix}%"] for prefix in STORE_NAME_PREFIXES.values()
		],
		fields=["custom_farm"],
		distinct=True,
	)
	farms |= {r["custom_farm"] for r in rows if r.get("custom_farm")}
	return farms


def unmapped_farms() -> list:
	"""Farms whose store is resolved only by the name convention.

	Each one is a farm that breaks the day the convention is dropped, so this is
	the checklist for retiring ``STORE_NAME_PREFIXES``. Surfaced rather than
	logged so it can be shown on the settings page.
	"""
	out = []
	for farm in sorted(farms_with_stores()):
		for kind, field in STORE_LINK_FIELDS.items():
			if frappe.db.get_value("Farm", farm, field):
				continue
			if _by_name(farm, kind):
				out.append({"farm": farm, "kind": kind, "stores": _by_name(farm, kind)})
	return out
