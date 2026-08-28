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
