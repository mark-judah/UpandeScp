"""One crop's value for one spray-plan setting.

A row exists only where a crop differs from the site default. Its absence is
the inheritance: there is no "inherit" flag to get out of step with reality,
and nothing to clear when somebody wants the default back — they delete the
row.

`value` is Data because the settings it shadows are Ints, Floats, Times and
Checks, and one column cannot be all of them. `crop_settings.resolve()` coerces
each one using the type the parent Single declares for that fieldname, so the
parent stays the single authority on what a setting *is* and this table only
says what it is *here*.
"""

from frappe.model.document import Document


class SCPCropSettingOverride(Document):
	pass
