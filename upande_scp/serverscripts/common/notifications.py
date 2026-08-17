"""In-app notifications for SCP.

One path for everything the app needs to tell someone about. Writes Frappe's
``Notification Log`` — the doctype holding notification *instances*, which is
what the Desk bell reads — and fires a realtime event so an open page updates its
unread badge without polling.

(``Notification`` is a different doctype: alert *rules*. We deliberately don't
use it — our triggers are ordinary Python, not conditions on a doc save.)

Audience is resolved from roles and from store/farm assignment, never passed in
by a client. Notifying is best-effort: a notification that fails must never roll
back the transaction that earned it.
"""

import frappe

#: Realtime event the SPA subscribes to for live unread counts.
EVENT = "scp:notification"

#: Our own taxonomy. ``Notification Log.type`` is a fixed Frappe enum
#: (Alert / Share / Assignment / Energy Point), so the category lives in the
#: custom field ``scp_category`` — encoding it in the subject would turn
#: filtering into a substring search.
CATEGORIES = ("loan", "transfer", "procurement", "stock")

_NEVER_NOTIFY = {"Administrator", "Guest", "", None}


def _clean(users):
    """De-duplicate, drop system accounts, keep only enabled users."""
    wanted = {u for u in (users or []) if u not in _NEVER_NOTIFY}
    if not wanted:
        return []
    enabled = frappe.get_all(
        "User",
        filters={"name": ("in", list(wanted)), "enabled": 1},
        pluck="name",
    )
    return sorted(enabled)


def users_for_role(role):
    """Enabled users holding `role`."""
    if not role:
        return []
    return _clean(frappe.get_all("Has Role", filters={"role": role}, pluck="parent"))


def users_for_store(warehouse):
    """Keepers assigned to this specific store.

    Reads ``Farm Store Keeper.warehouse`` for both the per-farm rows and the
    general-store rows on the settings Single. Falls back to the farm's keepers
    when no row names the store, so an unmigrated site still notifies somebody
    rather than silently nobody.
    """
    if not warehouse:
        return []
    users = frappe.get_all(
        "Farm Store Keeper", filters={"warehouse": warehouse}, pluck="user"
    )
    if users:
        return _clean(users)
    farm = frappe.db.get_value("Warehouse", warehouse, "custom_farm")
    return users_for_farm(farm) if farm else []


def users_for_farm(farm, include_planners=True, include_keepers=True):
    """The people responsible for a farm: its store keepers and its spray-plan
    creators/approvers. Used to address a farm without knowing who staffs it."""
    if not farm:
        return []
    users = []
    if include_keepers:
        users += frappe.get_all(
            "Farm Store Keeper",
            filters={"parent": farm, "parenttype": "Farm"},
            pluck="user",
        )
    if include_planners:
        for dt in ("Farm Spray Plan Creator", "Farm Spray Plan Approver"):
            if not frappe.db.table_exists(dt):
                continue
            users += frappe.get_all(
                dt, filters={"parent": farm, "parenttype": "Farm"}, pluck="user"
            )
    return _clean(users)


def notify(users, subject, body="", ref_doctype=None, ref_name=None, category=None):
    """Send one in-app notification to each user. Returns the users notified.

    Best-effort by design: a failure here is logged and swallowed, because the
    caller's real work (approving a loan, publishing an allocation) must not be
    undone by a notification problem.
    """
    recipients = _clean(users if isinstance(users, (list, tuple, set)) else [users])
    if not recipients:
        return []
    if category and category not in CATEGORIES:
        # `scp_category` is a Select, so an unknown value makes Frappe REJECT the
        # insert — which would lose the message entirely. Drop the category and
        # deliver anyway: the notification matters, its filterability doesn't.
        frappe.log_error(f"unknown scp notification category: {category}", "scp notify")
        category = None

    sent = []
    for user in recipients:
        try:
            doc = frappe.get_doc({
                "doctype": "Notification Log",
                "for_user": user,
                "type": "Alert",
                "subject": subject,
                "email_content": body or subject,
                "document_type": ref_doctype,
                "document_name": ref_name,
            })
            if category:
                doc.scp_category = category
            doc.insert(ignore_permissions=True)
            sent.append(user)
        except Exception:
            frappe.log_error(frappe.get_traceback(), "scp notify insert failed")

    for user in sent:
        try:
            frappe.publish_realtime(EVENT, {"category": category}, user=user)
        except Exception:
            # Realtime is an optimisation; the row is already stored and the
            # page recomputes its count on mount.
            pass
    return sent


# ---------------------------------------------------------------------------
# Read API for the notifications page
# ---------------------------------------------------------------------------
# Every endpoint resolves the user from the session. None of them accept a
# `for_user` — doing so would let any user read another's notifications.


@frappe.whitelist()
def list_notifications(category=None, unread_only=0, limit=50, offset=0):
    filters = {"for_user": frappe.session.user}
    if category:
        filters["scp_category"] = category
    if str(unread_only) in ("1", "true", "True"):
        filters["read"] = 0
    try:
        limit = max(1, min(int(limit), 200))
        offset = max(0, int(offset))
    except (TypeError, ValueError):
        limit, offset = 50, 0

    rows = frappe.get_all(
        "Notification Log",
        filters=filters,
        fields=[
            "name", "subject", "email_content", "read", "creation",
            "document_type", "document_name", "scp_category",
        ],
        order_by="creation desc",
        limit_page_length=limit,
        limit_start=offset,
    )
    return {"notifications": rows, "unread": unread_count()}


@frappe.whitelist()
def unread_count():
    return frappe.db.count(
        "Notification Log", {"for_user": frappe.session.user, "read": 0}
    )


@frappe.whitelist()
def mark_read(names=None, all=0):
    """Mark specific notifications, or every one of the user's, as read."""
    import json

    user = frappe.session.user
    if str(all) in ("1", "true", "True"):
        frappe.db.set_value(
            "Notification Log", {"for_user": user, "read": 0}, "read", 1,
            update_modified=False,
        )
        frappe.db.commit()
        return {"unread": 0}

    if isinstance(names, str):
        try:
            names = json.loads(names)
        except (TypeError, ValueError):
            names = [names]
    for name in (names or []):
        # Scoped by for_user as well as name, so a guessed name from another
        # user's inbox can't be touched.
        frappe.db.set_value(
            "Notification Log", {"name": name, "for_user": user}, "read", 1,
            update_modified=False,
        )
    frappe.db.commit()
    return {"unread": unread_count()}
