# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

"""One rule for reading a user's roles, because two sites spell them differently.

kaitet namespaced its roles with an ``SCP `` prefix — "SCP General Manager",
"SCP Spray Plan Approver" — and mona did not. Both families now exist on mona:
the unprefixed ones its staff have always held, and a prefixed set created
2026-09-23 and handed to nineteen people.

The React sidebar already compares with the prefix stripped
(``AppSidebar.tsx``, ``sameRole``). The server compared literally. So a user
holding "SCP Spray Plan Approver" was shown the Approvals page and then refused
its data — the page loads, the list says "Failed to load work orders", and
nothing tells them the two halves disagree about what their role is called.

Matching with the prefix off on both sides means a gate written either way
answers on either site. Comparison is also case-insensitive: the site carries
"spray plan manager" in lower case alongside the title-cased roles, and a gate
should not turn on somebody's capitalisation.

This is a widening: on mona it takes spray plan approvers from 6 to 24. That is
the intent — the prefixed roles were granted deliberately — and approvals stay
scoped per farm by ``_ensure_wo_in_approver_scope`` regardless.
"""

import frappe

PREFIX = "scp "


def bare(role: str) -> str:
    """A role name with the namespace prefix and casing removed."""
    r = (role or "").strip().lower()
    return r[len(PREFIX) :] if r.startswith(PREFIX) else r


def roles_of(user: str | None = None) -> set[str]:
    """Every role the user holds, reduced to its bare name."""
    return {bare(r) for r in (frappe.get_roles(user or frappe.session.user) or [])}


def has_any_role(*roles, user: str | None = None) -> bool:
    """True when the user holds any of ``roles``, either spelling.

    Accepts names or iterables of names so the existing role tuples and sets
    can be passed straight through.
    """
    wanted: set[str] = set()
    for r in roles:
        if isinstance(r, str):
            wanted.add(bare(r))
        else:
            wanted.update(bare(x) for x in r)
    return bool(roles_of(user) & wanted)


def spellings(role: str) -> tuple[str, str]:
    """Both names a role goes by here: bare, and SCP-prefixed.

    For the gate that has to hit the database directly instead of reading the
    role cache — it cannot compare bare names in Python, so it asks after both.
    """
    r = (role or "").strip()
    if r.lower().startswith(PREFIX):
        r = r[len(PREFIX) :]
    return (r, f"SCP {r}")
