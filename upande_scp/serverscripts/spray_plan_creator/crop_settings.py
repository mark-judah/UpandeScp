"""Spray-plan settings, resolved for one crop.

Roses are sprayed inside greenhouses on the Karen farms; avocado is an exposed
orchard on Lokitela; coffee is Endebess and Saboti. The same knob does not mean
the same thing across those — a wind speed that stops spraying an open orchard
is irrelevant inside a greenhouse, and a resistance-rotation window is a fact
about a pest complex, not about a company.

But most of the settings really are site-wide, and three independent copies of
them would be three things to keep in step and three places for them to drift.
So: **the Single is the default and a crop may override a knob.** A crop with
no override row inherits, and the absence of the row is the inheritance — there
is no separate "inherit" flag that can disagree with reality, and getting the
default back means deleting the row rather than remembering what it used to be.

## What may be overridden, and what may not

`OVERRIDABLE` is the whole list, and it is deliberately short. A setting earns a
place on it by being a fact about how a crop is grown or sprayed. Everything
else — the accounts, the chemical item groups, the timezone, whether a biometric
is required to submit — is a fact about the company, and a per-crop copy of it
would be an invitation to set the site into an inconsistent state.

Notably NOT overridable, having been considered:

* `allow_submit_without_biometric` / `bypass_owner_check` — controls on who may
  do what. A crop is not a security boundary.
* the accounts and item groups — the chart of accounts is company-level.
* `app_timezone` — a site has one clock.
* `progress_email_*` — one daily email covers the farm, not one per crop.

## Types

Override values are stored as Data because the settings they shadow are Ints,
Floats, Times and Checks and one column cannot be all of them. The parent Single
stays the authority on what a setting *is*: `resolve` reads the fieldtype off
its meta and coerces with it, so a new overridable field needs no code here
beyond its name.
"""

import frappe

SETTINGS_DOCTYPE = "Scouting and Crop Protection Settings"

# Fieldname → why a crop may differ. The reason is part of the definition: if a
# field cannot be given one, it does not belong here.
OVERRIDABLE = {
	"weather_wind_green_max_kmh": "An enclosed greenhouse and an exposed orchard do not stop spraying at the same wind speed.",
	"weather_wind_red_min_kmh": "As above, at the other end of the scale.",
	"weather_rain_green_max_pct": "Wash-off risk depends on the canopy and on whether the crop is under cover.",
	"weather_rain_red_min_pct": "As above.",
	"weather_temp_green_min_c": "Orchards and greenhouses sit in different microclimates.",
	"weather_temp_green_max_c": "As above.",
	"weather_temp_red_max_c": "As above.",
	"weather_temp_red_min_c": "As above.",
	"irac_rotation_window_days": "Resistance management follows the crop's pest complex, not the company.",
	"frac_rotation_window_days": "As above, for fungicides.",
	"spray_cutoff_time": "Orchard and greenhouse crews work to different days.",
	"postponement_max_days": "How far a spray may slip depends on the crop's spray interval.",
	"postponement_grace_minutes": "As above.",
	"auto_cancel_enabled": "A crop with few plans a season should not have them cancelled on a roses cadence.",
	"auto_cancel_dormant_days": "As above.",
	"csu_scan_verification": "How the handover into the work-in-progress area is verified. The flow is the same on every crop, but the crews and their equipment are not.",
	"wip_area_label": "What that area is called here. Roses call theirs the CSU; an orchard does not.",
}


def _coerce(value, fieldtype: str):
	"""Turn a stored Data value into what the parent field's type expects."""
	if value is None or value == "":
		return None
	if fieldtype in ("Int", "Check"):
		try:
			return int(float(value))
		except (TypeError, ValueError):
			return None
	if fieldtype in ("Float", "Currency", "Percent"):
		try:
			return float(value)
		except (TypeError, ValueError):
			return None
	return value


def overrides_for(crop: str, settings=None) -> dict:
	"""{fieldname: raw stored value} for one crop. Unknown fieldnames are
	ignored rather than trusted — `OVERRIDABLE` is the contract, and a row left
	behind by a field that has since been removed must not resurface."""
	crop = (crop or "").strip()
	if not crop:
		return {}
	settings = settings or frappe.get_single(SETTINGS_DOCTYPE)
	out = {}
	for row in settings.get("crop_overrides") or []:
		if (row.crop or "").strip() != crop:
			continue
		key = (row.setting or "").strip()
		if key in OVERRIDABLE:
			out[key] = row.value
	return out


def resolve(crop: str = "") -> dict:
	"""Effective spray-plan settings for `crop`, and which keys were overridden.

	Returns ``{"crop", "effective", "defaults", "overridden"}``. Callers that
	just want a value should use `value_for`; this shape exists for the settings
	page, which has to show both numbers and say which one is in force.
	"""
	settings = frappe.get_single(SETTINGS_DOCTYPE)
	meta = frappe.get_meta(SETTINGS_DOCTYPE)

	defaults = {key: settings.get(key) for key in OVERRIDABLE}
	effective = dict(defaults)
	overridden = []

	for key, raw in overrides_for(crop, settings).items():
		field = meta.get_field(key)
		coerced = _coerce(raw, field.fieldtype if field else "Data")
		if coerced is None:
			# A row with an empty value is the same as no row. Treating it as an
			# override of "nothing" would silently zero the setting.
			continue
		effective[key] = coerced
		overridden.append(key)

	return {
		"crop": crop,
		"effective": effective,
		"defaults": defaults,
		"overridden": sorted(overridden),
	}


def value_for(key: str, crop: str = ""):
	"""One setting, for one crop. The default when the crop has no override."""
	if key not in OVERRIDABLE:
		# Not overridable means there is nothing crop-specific to resolve — read
		# the Single directly rather than pretending this call did something.
		return frappe.db.get_single_value(SETTINGS_DOCTYPE, key)
	return resolve(crop)["effective"].get(key)


def replace_overrides(crop: str, values: dict) -> dict:
	"""Set this crop's overrides to exactly `values`; drop the rest.

	A key mapped to None or "" is removed rather than stored empty, because an
	empty override and no override have to mean the same thing — otherwise the
	page would have two different ways to say "inherit" and only one of them
	would work.
	"""
	crop = (crop or "").strip()
	if not crop:
		frappe.throw("A crop is required to save overrides.")
	if not frappe.db.exists("Crop Scouted", crop):
		frappe.throw(f"{crop} is not a scouted crop.")

	settings = frappe.get_single(SETTINGS_DOCTYPE)
	kept = [
		row
		for row in (settings.get("crop_overrides") or [])
		if (row.crop or "").strip() != crop
	]
	settings.set("crop_overrides", kept)

	written = []
	for key, raw in (values or {}).items():
		if key not in OVERRIDABLE:
			continue
		if raw is None or str(raw).strip() == "":
			continue
		settings.append(
			"crop_overrides",
			{"crop": crop, "setting": key, "value": str(raw).strip()},
		)
		written.append(key)

	settings.save(ignore_permissions=True)
	frappe.db.commit()
	return {"crop": crop, "overridden": sorted(written)}


# The word roses have always used, and the fallback for a site that has never
# configured this. Keeping it means nothing changes for an existing site.
DEFAULT_WIP_KEYWORD = "CSU"


def wip_keywords() -> list:
	"""Words that mark a warehouse as a work-in-progress spray area.

	The flow is the same on every crop — chemicals are transferred into a
	holding area, mixed there, and sprayed out of it — but the place has a
	different name on an orchard than on a rose farm. This used to be the
	literal string "CSU" in a SQL LIKE and in a regex in the React app, which
	meant an area called anything else was simply never found: not listed, not
	shown as holding stock, not offered to a store keeper.

	Site-wide rather than per-crop, because the store dashboards are organised
	by farm and warehouse and a single list has to match all of them at once.
	What the area is *called* on screen is per-crop — see `wip_area_label` in
	OVERRIDABLE.

	Empty falls back to CSU, so a site that never touches this keeps behaving
	exactly as it did.
	"""
	settings = frappe.get_single(SETTINGS_DOCTYPE)
	words = []
	for row in settings.get("wip_area_keywords") or []:
		word = (getattr(row, "keyword", "") or "").strip()
		if word and word.lower() not in [w.lower() for w in words]:
			words.append(word)
	return words or [DEFAULT_WIP_KEYWORD]


def is_wip_area(warehouse_name: str) -> bool:
	"""Whole-word, case-insensitive — the rule the React app already applied.

	Whole-word matters: a substring match makes "Focus Store" a WIP area
	because it contains "cus", and there is no way for an operator to see why.
	"""
	import re

	name = warehouse_name or ""
	for word in wip_keywords():
		if re.search(rf"\b{re.escape(word)}\b", name, re.IGNORECASE):
			return True
	return False
