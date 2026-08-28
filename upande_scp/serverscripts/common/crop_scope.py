"""Which crops a user may see, and the chain that decides it.

A user belongs to an Employee, an Employee to a Company, a Company to a tree, a Farm
to a Company, and a crop to the farms it is grown on. Walk that and you have the
answer to "what may this person see" without anyone maintaining a second list::

    user → Employee.user_id → Employee.company
         → Company lft BETWEEN c.lft AND c.rgt      (descendants)
         → Farm.company IN (…)
         → Crop Scouted.farms ∋ farm

Company is a real nested set — `Kaitet Group` spans lft 1–16, `Karen Roses` is a leaf
at 2–3 — so descendants are one indexed range query rather than a recursive walk. That
also gives the group case for free: a user at the parent company matches every child's
range, so they see every crop without a rule of their own.

## `None` means unrestricted, an empty set means nothing

This distinction is the whole safety property, and it is easy to get backwards. `None`
is returned **only** for Administrator and System Manager. Everyone else gets a set,
and an empty set means they see nothing — never everything. A user with no Employee
record, or an Employee with no company, is not an administrator; they are a
misconfiguration, and the safe reading of a misconfiguration is silence.

The same `None`-means-unscoped sentinel is what `_approver_allowed_greenhouses` already
uses for farm scope, so the two read alike.

## Empty `Crop Scouted.farms` means nobody

It used to mean "applies to every farm", matching `FRAC Code Filter`'s convention. As a
display default that is convenient; as an access rule it is a hole that opens itself
every time someone adds a crop and does not tag it. Inverted here deliberately — the
cost is that an untagged crop is invisible, which a validation warning surfaces.
"""

from __future__ import annotations

import frappe

#: Roles that see everything regardless of their Employee. Deliberately short:
#: `SCP General Manager` is NOT here — a general manager belongs to a company like
#: anyone else, which is why Peter Kamuren (Karen Roses) sees only roses.
BYPASS_ROLES = ("Administrator", "System Manager")

_CACHE_KEY = "_scp_crop_scope"


def _cache() -> dict:
	"""Per-request memo. The chain is four indexed queries and is hit repeatedly."""
	store = getattr(frappe.local, _CACHE_KEY, None)
	if store is None:
		store = {}
		setattr(frappe.local, _CACHE_KEY, store)
	return store


def clear_cache() -> None:
	"""Drop the memo — for tests, and for anything that changes a user's employment."""
	if hasattr(frappe.local, _CACHE_KEY):
		delattr(frappe.local, _CACHE_KEY)


def _user(user: str | None) -> str:
	return user or frappe.session.user


def is_unrestricted(user: str | None = None) -> bool:
	"""True when this user is exempt from crop scoping entirely."""
	user = _user(user)
	if user == "Administrator":
		return True
	return bool(set(frappe.get_roles(user)) & set(BYPASS_ROLES))


def allowed_companies(user: str | None = None) -> set[str] | None:
	"""The user's own companies plus every company beneath them in the tree.

	`None` for an unrestricted user. An empty set for a user with no Employee record,
	or whose Employee names no company.
	"""
	user = _user(user)
	memo = _cache()
	key = ("companies", user)
	if key in memo:
		return memo[key]

	if is_unrestricted(user):
		memo[key] = None
		return None

	own = set()
	for row in frappe.get_all(
		"Employee", filters={"user_id": user}, fields=["company"]
	):
		if row.get("company"):
			own.add(row["company"])

	companies: set[str] = set()
	if own:
		# One range query per root rather than a recursive walk: a company's subtree is
		# exactly the rows whose lft falls inside its own [lft, rgt].
		for row in frappe.get_all(
			"Company", filters={"name": ["in", list(own)]}, fields=["name", "lft", "rgt"]
		):
			lft, rgt = row.get("lft"), row.get("rgt")
			if lft is None or rgt is None:
				# A tree that was never rebuilt: fall back to the company itself so a
				# missing nested-set index narrows access rather than widening it.
				companies.add(row["name"])
				continue
			for child in frappe.get_all(
				"Company",
				filters={"lft": [">=", lft], "rgt": ["<=", rgt]},
				fields=["name"],
			):
				companies.add(child["name"])

	memo[key] = companies
	return companies


def allowed_farms(user: str | None = None) -> set[str] | None:
	"""Every farm belonging to a company this user may see."""
	user = _user(user)
	memo = _cache()
	key = ("farms", user)
	if key in memo:
		return memo[key]

	companies = allowed_companies(user)
	if companies is None:
		memo[key] = None
		return None

	farms: set[str] = set()
	if companies:
		for row in frappe.get_all(
			"Farm", filters={"company": ["in", list(companies)]}, fields=["name"]
		):
			farms.add(row["name"])

	memo[key] = farms
	return farms


def allowed_crops(user: str | None = None) -> set[str] | None:
	"""Every crop grown on a farm this user may see.

	A crop with no farms tagged reaches nobody. See the module docstring — that is a
	deliberate inversion of the old "empty means all" reading.
	"""
	user = _user(user)
	memo = _cache()
	key = ("crops", user)
	if key in memo:
		return memo[key]

	farms = allowed_farms(user)
	if farms is None:
		memo[key] = None
		return None

	crops: set[str] = set()
	if farms:
		for row in frappe.get_all(
			"Farm Filter",
			filters={"parenttype": "Crop Scouted", "farm": ["in", list(farms)]},
			fields=["parent"],
		):
			crops.add(row["parent"])

	memo[key] = crops
	return crops


def assert_crop(crop: str, user: str | None = None) -> None:
	"""Refuse an operation on a crop this user may not see."""
	if not crop:
		return
	crops = allowed_crops(user)
	if crops is None or crop in crops:
		return
	frappe.throw(
		f"{crop} is not grown on any farm you have access to.",
		frappe.PermissionError,
	)


def allowed_greenhouses(user: str | None = None) -> set[str] | None:
	"""Warehouses belonging to a farm this user may see.

	Work Orders carry no crop — only `custom_greenhouse` — so a spray plan is scoped by
	where it happens rather than by what grows there. `Warehouse.custom_farm` is the only
	warehouse-to-farm edge in the system.
	"""
	user = _user(user)
	memo = _cache()
	key = ("greenhouses", user)
	if key in memo:
		return memo[key]

	farms = allowed_farms(user)
	if farms is None:
		memo[key] = None
		return None

	houses: set[str] = set()
	if farms:
		for row in frappe.get_all(
			"Warehouse", filters={"custom_farm": ["in", list(farms)]}, fields=["name"]
		):
			houses.add(row["name"])

	memo[key] = houses
	return houses


# ───────────────────── crop context, for the UI's dropdowns ──────────────────
#
# Two different narrowings meet in the frontend and are easy to conflate:
#
#   * **who you are** — the gate above. A Karen Roses user never sees Lokitela.
#   * **where you are** — the crop section you have navigated into. Inside Avocado,
#     a farm picker should offer Lokitela and nothing else, even to an administrator
#     who is entitled to every farm.
#
# The second is context, not permission, so it narrows everyone including the
# unrestricted. The two compose: the answer is always the intersection.


def farms_for_crop(crop: str | None) -> set[str] | None:
	"""Farms this crop is grown on. `None` when no crop is given."""
	if not crop:
		return None
	farms: set[str] = set()
	for row in frappe.get_all(
		"Farm Filter",
		filters={"parenttype": "Crop Scouted", "parent": crop},
		fields=["farm"],
	):
		if row.get("farm"):
			farms.add(row["farm"])
	return farms


def scoped_farms(crop: str | None = None, user: str | None = None) -> set[str] | None:
	"""The farms a user may see, narrowed to a crop's farms when one is in play.

	`None` means "no restriction at all" and can only come back when the user is
	unrestricted *and* no crop context was given.
	"""
	mine = allowed_farms(user)
	theirs = farms_for_crop(crop)
	if theirs is None:
		return mine
	if mine is None:
		return theirs
	return mine & theirs


def scoped_greenhouses(crop: str | None = None, user: str | None = None) -> set[str] | None:
	"""Warehouses under `scoped_farms`. `None` means no restriction."""
	farms = scoped_farms(crop, user)
	if farms is None:
		return None
	if not farms:
		return set()
	houses: set[str] = set()
	for row in frappe.get_all(
		"Warehouse", filters={"custom_farm": ["in", list(farms)]}, fields=["name"]
	):
		houses.add(row["name"])
	return houses


# ─────────────────────────── permission hooks ────────────────────────────────


def _in_clause(values: set[str]) -> str:
	return ", ".join(frappe.db.escape(v) for v in sorted(values))


def crop_query_condition(user: str | None = None) -> str:
	"""`permission_query_conditions` for `Crop Scouted`.

	Returns `1=0` rather than `""` for a user with no crops. An empty string means
	"no condition", which is the opposite of what an empty scope should mean, and is
	the mistake this function exists to not make.
	"""
	crops = allowed_crops(user)
	if crops is None:
		return ""
	if not crops:
		return "1=0"
	return f"`tabCrop Scouted`.name IN ({_in_clause(crops)})"


def crop_has_permission(doc, ptype: str = "read", user: str | None = None) -> bool:
	"""`has_permission` for `Crop Scouted` — the single-document counterpart."""
	crops = allowed_crops(user)
	if crops is None:
		return True
	name = getattr(doc, "name", None) or (doc.get("name") if hasattr(doc, "get") else None)
	return bool(name) and name in crops


def scouting_entry_query_condition(user: str | None = None) -> str:
	"""`permission_query_conditions` for `Scouting Entry`.

	Scoped on `crop_scouted`, which every one of the 297,131 rows on kaitet carries —
	not on the greenhouse. Avocado entries have no greenhouse at all (avocado is
	recorded against blocks), so a farm-based condition would hide every avocado entry
	while looking correct for roses.
	"""
	crops = allowed_crops(user)
	if crops is None:
		return ""
	if not crops:
		return "1=0"
	return f"`tabScouting Entry`.crop_scouted IN ({_in_clause(crops)})"


def scouting_entry_has_permission(doc, ptype: str = "read", user: str | None = None) -> bool:
	crops = allowed_crops(user)
	if crops is None:
		return True
	crop = getattr(doc, "crop_scouted", None)
	if not crop:
		# A row with no crop cannot be placed. Refused rather than allowed: an
		# unclassifiable record is not the same as an unrestricted one.
		return False
	return crop in crops


def work_order_query_condition(user: str | None = None) -> str:
	"""`permission_query_conditions` for `Work Order`.

	**Only Application Floor Plans are scoped.** 1,786 of the Work Orders on kaitet are
	livestock and manufacturing orders with no `custom_type` and no greenhouse; a
	condition that gated every Work Order by farm would hide all of them from everyone,
	which is both wrong and nothing to do with crop protection.

	Scoped by greenhouse rather than by crop because a Work Order carries no crop field
	— `custom_greenhouse` and `custom_variety` are all it has, and all 3,370 floor plans
	resolve through the greenhouse to a farm.
	"""
	houses = allowed_greenhouses(user)
	if houses is None:
		return ""
	unscoped = (
		"(`tabWork Order`.custom_type IS NULL "
		"OR `tabWork Order`.custom_type != 'Application Floor Plan')"
	)
	if not houses:
		return unscoped
	return (
		f"({unscoped} OR `tabWork Order`.custom_greenhouse IN ({_in_clause(houses)}))"
	)


def work_order_has_permission(doc, ptype: str = "read", user: str | None = None) -> bool:
	houses = allowed_greenhouses(user)
	if houses is None:
		return True
	if (getattr(doc, "custom_type", None) or "") != "Application Floor Plan":
		return True  # not a spray plan; crop scope has no opinion
	return (getattr(doc, "custom_greenhouse", None) or "") in houses
