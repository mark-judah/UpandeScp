"""What a scout may record on the ground beyond the counts, and the highest
count one observation may carry (scout capture settings spec, P1–P3).

Ported from Mona (`scouting/capture_settings.py`, f5f6392 / b338508 / da18194)
onto kaitet's Single, Scouting and Crop Protection Settings → Scouting, plus
``max_count`` (piece 6).

Three places need the same answers and must not each decide: the payload the
handset reads (``mobile/get_observations_details``), the photo upload
(``mobile/pest_image.attach_scouting_photo``) and the SCP settings page
(``spray_plan_creator/settings``). They ask here.

ABSENT MEANS THE DEFAULT. A site that never saved these fields has no
``tabSingles`` row for them. ``get_single_value`` and a loaded Single both cast
a missing Check to 0, so "nobody ever touched it" and "the GM switched it off"
would arrive identical (Mona hit exactly that restoring production, da18194).
Every reader here goes to ``tabSingles`` directly.

A SAVE MUST NOT WRITE THE CAST 0 EITHER. The Single's ``validate`` calls
``fill_unset``, which puts the default back on any capture field that has no
row and was not set explicitly in this save. ``ensure_defaults`` (schema step
and ``after_migrate``) writes the rows, so the gap closes for good.
"""

import frappe
from frappe import _

SETTINGS = "Scouting and Crop Protection Settings"

PHOTOS_FIELD = "allow_scout_photos"
COMMENTS_FIELD = "allow_scout_comments"
MAX_COUNT_FIELD = "max_count_per_observation"

#: The switches ``allows`` answers for, and the field behind each.
_SWITCHES = {"photos": PHOTOS_FIELD, "comments": COMMENTS_FIELD}

DEFAULT_MAX_COUNT = 15
MAX_COUNT_MIN = 1
MAX_COUNT_MAX = 10000
MAX_COUNT_MESSAGE = "Max count per observation must be a whole number from 1 to 10000."

GREETINGS_FIELD = "scout_greetings_enabled"

#: The capture fields and the value each reads as when nothing is stored.
CAPTURE_DEFAULTS = {PHOTOS_FIELD: 1, COMMENTS_FIELD: 1, MAX_COUNT_FIELD: DEFAULT_MAX_COUNT}
FIELDS = tuple(CAPTURE_DEFAULTS)
#: Every Single field guarded by fill_unset / ensure_defaults: the capture fields
#: plus the greeting switch (same unset-Check-casts-to-0 trap, so the same guard).
DEFAULTS = {**CAPTURE_DEFAULTS, GREETINGS_FIELD: 1}


def _raw(fieldname):
    """The stored value, or None when the Single has no row for it.

    Plain SQL: ``get_value`` orders by ``creation`` and tabSingles has no such
    column — it is a key/value table, not a doctype table."""
    row = frappe.db.sql(
        "SELECT value FROM tabSingles WHERE doctype = %s AND field = %s",
        (SETTINGS, fieldname),
    )
    value = row[0][0] if row else None
    return None if value in (None, "") else value


def allows(what: str) -> bool:
    """Is this kind of capture allowed? ``what`` is "photos" or "comments".

    Anything else is a programming error and says so: a typo that read as
    "allowed" would hand scouts a capability the GM had switched off."""
    try:
        fieldname = _SWITCHES[what]
    except KeyError:
        raise ValueError(
            f"{what!r} is not a scouting capture switch — expected one of "
            f"{', '.join(sorted(_SWITCHES))}"
        ) from None
    value = _raw(fieldname)
    if value is None:
        return True
    try:
        return bool(int(float(value)))
    except (TypeError, ValueError):
        return True


def _as_max_count(value):
    """``value`` as a whole number in 1–10000, else None."""
    try:
        number = float(str(value).strip())
    except (TypeError, ValueError):
        return None
    if not number.is_integer():
        return None
    number = int(number)
    return number if MAX_COUNT_MIN <= number <= MAX_COUNT_MAX else None


def greetings_enabled() -> bool:
    """Scout app birthday / milestone / encouragement card. Unset reads on."""
    value = _raw(GREETINGS_FIELD)
    if value is None:
        return True
    try:
        return bool(int(float(value)))
    except (TypeError, ValueError):
        return True


def max_count() -> int:
    """The highest count the handset accepts for one observation or one trap
    pest (piece 6). Unset — or a stored value no handset could use — reads 15,
    so a bad row can never make every count unrecordable."""
    value = _raw(MAX_COUNT_FIELD)
    return (_as_max_count(value) if value is not None else None) or DEFAULT_MAX_COUNT


def clean_max_count(value) -> int:
    """The settings page's guard: a whole number from 1 to 10000, or a
    ValidationError that saves nothing."""
    number = _as_max_count(value)
    if number is None:
        frappe.throw(_(MAX_COUNT_MESSAGE), title=_("Invalid max count"))
    return number


TRAP_RULES_FIELD = "trap_photo_rules"


def trap_photo_rules() -> dict:
    """{pest: photo_required} for every pest with a rule row. A pest with no row
    reads as not required — the table's rows ARE the setting, so there is no
    unset-Check cast to guard against (unlike the switches above)."""
    if not frappe.db.exists("DocType", "Trap Photo Rule"):
        return {}
    rows = frappe.db.sql(
        "SELECT pest, photo_required FROM `tabTrap Photo Rule` "
        "WHERE parenttype = %s AND parentfield = %s ORDER BY idx",
        (SETTINGS, TRAP_RULES_FIELD),
    )
    return {pest: bool(req) for pest, req in rows if pest}


def trap_pest_choices() -> list:
    """The pests a trap has caught, plus any with a rule — the rows the settings
    page offers a switch for."""
    caught = frappe.db.sql(
        "SELECT DISTINCT pest FROM `tabTrap Scouting Entry` "
        "WHERE parenttype = 'Scouting Entry' AND IFNULL(pest, '') != ''",
        pluck=True,
    )
    return sorted(set(caught) | set(trap_photo_rules()))


def trap_photo_required(pest: str) -> bool:
    return bool(trap_photo_rules().get(pest))


def clean_trap_rules(rows) -> list:
    """The settings page's rows as unique ``{pest, photo_required}`` dicts."""
    out, seen = [], set()
    for r in rows or []:
        pest = ((r.get("pest") if isinstance(r, dict) else r) or "").strip()
        if not pest or pest in seen:
            continue
        seen.add(pest)
        required = r.get("photo_required") if isinstance(r, dict) else 0
        out.append({"pest": pest, "photo_required": 1 if frappe.utils.cint(required) else 0})
    return out


def as_payload() -> dict:
    """The ``capture`` block of getObservationsDetails. It rides with the
    observations because the handset decides what to draw while it builds the
    round, and a second request is one more thing to fail with no signal."""
    return {
        "photos": allows("photos"),
        "comments": allows("comments"),
        "max_count": max_count(),
        # Trap pests whose catches need a photo; the app enforces it (follow-up).
        "trap_photo_required": sorted(p for p, req in trap_photo_rules().items() if req),
    }


def as_settings() -> dict:
    """The three values as the SCP settings page edits them. Never read them
    off a loaded Single: its Checks are cast to 0 when no row is stored."""
    return {
        PHOTOS_FIELD: int(allows("photos")),
        COMMENTS_FIELD: int(allows("comments")),
        MAX_COUNT_FIELD: max_count(),
    }


def fill_unset(doc) -> list:
    """Called from the Single's ``validate``: give every capture field that has
    no stored row its default, unless this save set it on purpose
    (``doc.flags.capture_explicit``, filled by ``save_spray_plan_settings``).
    Returns the fields filled."""
    explicit = set(doc.flags.get("capture_explicit") or ())
    filled = []
    for field, default in DEFAULTS.items():
        if field in explicit or _raw(field) is not None:
            continue
        doc.set(field, default)
        filled.append(field)
    return filled


def ensure_defaults() -> list:
    """``after_migrate`` (and Task 1's schema step): write each capture default
    whose row is absent, and never touch a stored value. Writes rows directly,
    no document save, so nothing else on the Single is re-validated."""
    if not frappe.db.exists("DocType", SETTINGS):
        return []
    meta = frappe.get_meta(SETTINGS)
    written = []
    for field, default in DEFAULTS.items():
        if meta.get_field(field) is None or _raw(field) is not None:
            continue
        frappe.db.set_single_value(SETTINGS, field, default)
        written.append(field)
    return written
