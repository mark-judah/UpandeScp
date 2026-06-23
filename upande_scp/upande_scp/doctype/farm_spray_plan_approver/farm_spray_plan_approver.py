import frappe
from frappe.model.document import Document


def _assert_spray_plan_approver_role(user: str) -> None:
    """Raise ValidationError if *user* does not hold the Spray Plan Approver role."""
    roles = {r.role for r in frappe.get_all(
        "Has Role", filters={"parent": user}, fields=["role"]
    )}
    if "Spray Plan Approver" not in roles:
        frappe.throw(
            f"User {user} does not hold the 'Spray Plan Approver' role.",
            title="Role required",
        )


class FarmSprayPlanApprover(Document):
    def validate(self) -> None:
        if not self.user:
            return
        _assert_spray_plan_approver_role(self.user)


def validate_farm_spray_plan_approvers(doc, method=None) -> None:
    """doc_events hook: called on Farm.validate.

    Mirrors the creator-role validator: Frappe doesn't propagate validate()
    to child rows during a parent save, so we re-check role membership for
    every row written to ``Farm.spray_plan_approvers``.
    """
    for row in doc.get("spray_plan_approvers") or []:
        if row.user:
            _assert_spray_plan_approver_role(row.user)
