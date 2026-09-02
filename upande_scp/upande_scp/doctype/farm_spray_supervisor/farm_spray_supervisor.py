import frappe
from frappe.model.document import Document

ROLE = "SCP Spray Supervisor"


def _assert_spray_supervisor_role(user: str) -> None:
    """Raise ValidationError if *user* does not hold the Spray Supervisor role."""
    roles = {r.role for r in frappe.get_all(
        "Has Role", filters={"parent": user}, fields=["role"]
    )}
    if ROLE not in roles:
        frappe.throw(
            f"User {user} does not hold the '{ROLE}' role.",
            title="Role required",
        )


def _has_role(user: str) -> bool:
    return bool(frappe.db.exists(
        "Has Role", {"parent": user, "parenttype": "User", "role": "SCP Spray Supervisor"}
    ))


class FarmSpraySupervisor(Document):
    def validate(self) -> None:
        if not self.user:
            return
        _assert_spray_supervisor_role(self.user)


def _has_role(user: str) -> bool:
    return bool(frappe.db.exists(
        "Has Role", {"parent": user, "parenttype": "User", "role": "SCP Spray Supervisor"}
    ))


def validate_farm_spray_supervisors(doc, method=None) -> None:
    """doc_events hook: called on Farm.validate.

    Frappe does not propagate validate() to child rows during a parent save, so
    the roster is enforced here.

    A row whose user has **lost** the role is dropped rather than raised on.
    Throwing looks stricter but was strictly worse: a single stale row made the
    whole Farm unsaveable, so nobody could roster anyone — for any role — until
    someone found and deleted it by hand. It cost me two roster edits before I
    understood why. And the stale row granted nothing anyway: every consumer
    re-checks the role at read time (the mobile plan download), so dropping it changes no
    access. It only stops dead data blocking live edits.

    A row for someone who never held the role still raises. That is a mistake
    being made right now, and the operator should hear about it.
    """
    rows = doc.get("spray_supervisors") or []
    stale = []
    for row in list(rows):
        if not row.user:
            continue
        if row.get("__islocal") or not row.get("name"):
            _assert_spray_supervisor_role(row.user)      # adding somebody: hard error
        elif not _has_role(row.user):
            stale.append(row.user)      # already saved, role since removed
            rows.remove(row)
    if stale:
        frappe.msgprint(
            "Removed from this farm's roster because they no longer hold the "
            "'SCP Spray Supervisor' role: " + ", ".join(sorted(stale)) + ".",
            title="Roster updated",
            indicator="orange",
        )
