"""Chemical targeting enforcement: Strict or Warn (Scouting and Crop Protection Settings).

  Strict  every chemical row is assigned a pest / disease, the product must be VALID for it
          (registered default_targets, or its active-ingredient targets), a product with no
          registered or known target is refused, and the per-rule spray-check modes apply as configured.
  Warn    any chemical may be picked, regardless of registration, ingredient or IRAC / FRAC. Each
          row must STILL carry a target (finance needs it), but the targeting and rotation rules only
          WARN: they are shown on the floor plan and in approval and never block, and need no GM override.

The mode overrides the per-rule modes of TARGETING_RULES when Warn. New sites default to Strict; an
idempotent patch sets existing sites to Warn so operations never stop at the floor plan while the
product data is still being filled in.
"""

import frappe

from .engine import BLOCK, OFF, WARN

SETTINGS = "Scouting and Crop Protection Settings"
FIELD = "chemical_targeting_mode"
STRICT, WARN_MODE = "Strict", "Warn"
MODES = (STRICT, WARN_MODE)
#: rules the Warn mode softens to "Warn" (an Off rule stays Off)
TARGETING_RULES = ("target_match", "target_coverage", "moa_rotation", "max_sprays", "known_resistance")


def mode() -> str:
	v = frappe.db.get_single_value(SETTINGS, FIELD)
	return v if v in MODES else STRICT


def apply_mode(modes: dict, targeting: str) -> dict:
	"""The per-rule modes after the targeting mode: Warn turns every targeting / rotation rule
	that is on into Warn; Strict leaves them as configured."""
	out = dict(modes)
	if targeting == WARN_MODE:
		for r in TARGETING_RULES:
			if out.get(r) not in (None, OFF):
				out[r] = WARN
	return out


def untargeted_mode(targeting: str) -> str:
	"""How an untargeted product, or a row target the product is not valid for, is treated."""
	return BLOCK if targeting == STRICT else WARN
