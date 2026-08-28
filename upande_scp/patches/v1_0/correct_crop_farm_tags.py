"""Correct the crop→farm tags before they become an access rule.

`Crop Scouted.farms` was a display filter, and a wrong row in it cost nothing. Once
`crop_scope` reads it to decide what a person may see, the same row decides access,
and two of them were wrong:

* **`Rose → Vale`** — Vale belongs to Kaitet Ltd. and grows no roses; the farm has no
  rose beds and never had a rose scouting entry. Left in place it would hand roses to
  every Kaitet Ltd. user, which is exactly the leak this gate exists to close.
* **Coffee had no farms at all.** Under the old "empty means every farm" reading that
  made coffee visible to everyone; under the new one it makes coffee visible to nobody.
  Neither is right. Coffee grows on Endebess and Saboti.

Left alone deliberately, because the `Crop Scouted` validation now surfaces them and a
guess is worse than a warning:

* `Rose → Eldama` — Eldama has no company, so the chain reaches it from nowhere.
* `Rose → SIMO` — SIMO's company is `Kaitet Group`, the parent, so only a group-level
  user gets it. That may well be intended.

Idempotent: adds only what is missing, removes only the exact row named.
"""

import frappe

CROP = "Crop Scouted"

ADD = (
	("Coffee", "Endebess"),
	("Coffee", "Saboti"),
)

REMOVE = (
	("Rose", "Vale"),
)


def execute():
	for crop, farm in ADD:
		if not frappe.db.exists(CROP, crop):
			print(f"[crop-tags] no such crop {crop!r}; skipped")
			continue
		if not frappe.db.exists("Farm", farm):
			print(f"[crop-tags] no such farm {farm!r}; skipped")
			continue
		if frappe.db.exists(
			"Farm Filter", {"parent": crop, "parenttype": CROP, "farm": farm}
		):
			continue
		doc = frappe.get_doc(CROP, crop)
		doc.append("farms", {"farm": farm})
		doc.flags.ignore_permissions = True
		doc.flags.ignore_validate = True
		doc.save(ignore_permissions=True)
		print(f"[crop-tags] {crop} += {farm}")

	for crop, farm in REMOVE:
		rows = frappe.get_all(
			"Farm Filter",
			filters={"parent": crop, "parenttype": CROP, "farm": farm},
			pluck="name",
		)
		for row in rows:
			frappe.delete_doc("Farm Filter", row, force=True, ignore_permissions=True)
			print(f"[crop-tags] {crop} -= {farm}")

	frappe.db.commit()
