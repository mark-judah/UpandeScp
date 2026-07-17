"""Resolve scheduled-report email recipients (no hardcoded addresses).

Recipients come from the **Email Group** ``SCP Reports`` — a per-site mailing
list maintained in the desk UI, so no email addresses live in code. If that
lookup errors or the group is empty, we fall back to the **SCP IT** role (and
log an error) so a misconfigured group surfaces to IT instead of the report
silently going nowhere.
"""

import frappe

REPORT_EMAIL_GROUP = "SCP Reports"
IT_FALLBACK_ROLE = "SCP IT"


def _email_group_emails(group):
    """Subscribed members' emails of an Email Group."""
    rows = frappe.get_all(
        "Email Group Member",
        filters={"email_group": group, "unsubscribed": 0},
        pluck="email",
    )
    return [e.strip() for e in rows if e and "@" in e]


def _role_emails(role):
    """Enabled users' emails for a role."""
    out = []
    for user in frappe.get_all(
        "Has Role", filters={"role": role, "parenttype": "User"}, pluck="parent"
    ):
        enabled, email = frappe.db.get_value("User", user, ["enabled", "email"]) or (0, None)
        addr = (email or user or "").strip()
        if enabled and "@" in addr and addr not in out:
            out.append(addr)
    return out


def report_recipients():
    """Recipients for the scouting / trap / FCM reports.

    Primary: members of the ``SCP Reports`` Email Group. On error or when the
    group is empty, log and fall back to the ``SCP IT`` role.
    """
    try:
        emails = _email_group_emails(REPORT_EMAIL_GROUP)
        if emails:
            return emails
        frappe.log_error(
            title="SCP reports: recipient group empty",
            message=(
                f"Email Group '{REPORT_EMAIL_GROUP}' has no subscribed members; "
                f"falling back to the '{IT_FALLBACK_ROLE}' role."
            ),
        )
    except Exception:
        frappe.log_error(
            title="SCP reports: recipient lookup failed",
            message=f"Could not resolve '{REPORT_EMAIL_GROUP}':\n{frappe.get_traceback()}",
        )
    return _role_emails(IT_FALLBACK_ROLE)
