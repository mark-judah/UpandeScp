"""Employee search for the Spray Plan team-member editor.

The team-member editor on the React (`ApplicationPlan.tsx`) and legacy
(`new_application_floor_plan`) pages lets operators add/remove individuals
per-plan without mutating the master ``Spray Team`` list. To populate the
"Add member" picker, both pages call ``search_employees`` here.

We surface name + payroll number (the Employee's ``name`` field is the
payroll/employee number at Upande, e.g. ``200986``) so the operator sees
both pieces of info, not just the numeric ID.
"""
from __future__ import annotations

import frappe

from .drafts import _require_creator
from .scope import _resolve_user_scope


@frappe.whitelist()
def search_employees(query: str = "", limit: int = 20) -> list[dict]:
    """Return up to ``limit`` Active employees matching ``query``.

    Match is a case-insensitive substring on either the Employee ID (the
    payroll number) or the auto-built ``employee_name``. Results are scoped
    to companies the user has farm access to, when farms are configured —
    Administrators and users without any farm scope see everyone (so the
    Scouting and Crop Protection Settings flow still works for setup users).

    Returns dicts shaped ``{employee, employee_name, designation, department,
    company}`` — enough for the picker to render a rich row + dedupe by
    employee ID on the client.
    """
    user = _require_creator()
    scope = _resolve_user_scope(user)

    try:
        limit_int = max(1, min(int(limit), 100))
    except (TypeError, ValueError):
        limit_int = 20

    q = (query or "").strip()
    like = f"%{q.lower()}%" if q else "%"

    # Restrict to companies the user has warehouse access to (derived from
    # farm scope). Empty scope means we don't constrain — the role guard
    # still gates access.
    companies: list[str] = []
    if scope.get("warehouses"):
        wh_names = [w["name"] for w in scope["warehouses"]]
        companies = list({
            (row.company or "") for row in frappe.db.sql(
                """SELECT DISTINCT company FROM `tabWarehouse`
                    WHERE name IN %(names)s AND company IS NOT NULL AND company != ''""",
                {"names": tuple(wh_names) or ("",)},
                as_dict=True,
            )
        })
        companies = [c for c in companies if c]

    params: dict = {"like": like, "limit": limit_int}
    company_clause = ""
    if companies and user != "Administrator":
        company_clause = "AND company IN %(companies)s"
        params["companies"] = tuple(companies)

    rows = frappe.db.sql(
        f"""SELECT name AS employee,
                   employee_name,
                   designation,
                   department,
                   company,
                   image
              FROM `tabEmployee`
             WHERE status = 'Active'
               AND (LOWER(name) LIKE %(like)s
                    OR LOWER(employee_name) LIKE %(like)s
                    OR LOWER(COALESCE(employee_number, '')) LIKE %(like)s)
               {company_clause}
             ORDER BY employee_name ASC
             LIMIT %(limit)s""",
        params,
        as_dict=True,
    )
    return rows
