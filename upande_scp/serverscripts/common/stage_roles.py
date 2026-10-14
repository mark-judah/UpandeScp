"""Stage roles and weights (stage & variety spec S1–S6).

A Stage is a **Life stage** (Eggs, Larvae, Adult …), a **Form** the live pest
takes (Motiles, Singles, Colonies …) or a **Sign** of the pest (Damage, Web,
Ragged Margins). Live-pest prevalence counts Life stage and Form rows only; a
Sign row is reported as its own figure ("signs") and never as the pest (S3, S4).

``weight`` scales a stage's count in a pest's all-stage Count (S5): the Stage
master's weight, overridden for one crop's pest by its Pest Filter's Pests
Stages row (S6). A Frappe Float cannot be NULL, so an override of 0 means "use
the master's weight"; to drop a stage from every Count, set the master to 0.

**One site-wide Redis entry, built with raw SQL**, like ``crop_catalog``, and
dropped by any Stage / Pest Filter / Pests Stages / Crop Scouted change
(``cache_utils._DOC_INVALIDATIONS``) and by the thresholds editor's save. Every
column is read through ``has_column``: before the schema exists every stage
reads Life stage / 1.0, which is the pre-S3 behaviour.
"""

from __future__ import annotations

import frappe

from upande_scp.serverscripts.common.cache_utils import (
    K_STAGE_ROLES,
    TTL_MEDIUM,
    get_or_set,
    invalidate,
)

LIFE_STAGE = "Life stage"
FORM = "Form"
SIGN = "Sign"
ROLES = (LIFE_STAGE, FORM, SIGN)
#: The roles that are the live pest (S3).
LIVE_ROLES = frozenset({LIFE_STAGE, FORM})
DEFAULT_WEIGHT = 1.0

#: S2 — the seed. Every stage not listed is a Life stage.
SEED_SIGNS = ("Damage", "Damages", "FCM Damage", "Web", "Ragged Margins")
SEED_FORMS = ("Motiles", "Singles", "Colonies", "Scales", "Scale Insects", "Adult Cloud", "Adult Singles")
SEED_ROLES = {**{s: SIGN for s in SEED_SIGNS}, **{s: FORM for s in SEED_FORMS}}


# ── pure ───────────────────────────────────────────────────────────────────


def seed_role(stage) -> str:
    """The S2 role for a stage name (the seed patch's rule)."""
    return SEED_ROLES.get((stage or "").strip(), LIFE_STAGE)


def normalise_role(value) -> str:
    """A stored role, or Life stage for a blank / unknown one (the S1 default)."""
    value = (value or "").strip()
    return value if value in ROLES else LIFE_STAGE


def role_of(stage, roles) -> str:
    """The role of ``stage`` in ``roles`` (``{stage: role}``). A pest row with
    no stage, or a stage the master does not list, is a Life stage."""
    stage = (stage or "").strip()
    if not stage:
        return LIFE_STAGE
    return normalise_role((roles or {}).get(stage))


def is_live(stage, roles) -> bool:
    return role_of(stage, roles) in LIVE_ROLES


def _float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def resolve_weight(master, override) -> float:
    """S6: the Pests Stages override when it is set (> 0), else the master's
    weight (never negative), else 1.0."""
    o = _float(override)
    if o is not None and o > 0:
        return o
    m = _float(master)
    if m is None:
        return DEFAULT_WEIGHT
    return max(0.0, m)


def build(stage_rows, filter_rows) -> dict:
    """Fold the raw rows into the catalog. Pure.

    ``stage_rows``: ``{"name", "stage_role", "weight"}`` per Stage.
    ``filter_rows``: ``{"crop", "pest", "stage", "weight"}`` per Pests Stages row
    of a Pest Filter. Returns ``{"roles": {stage: role}, "weights": {stage:
    master weight}, "pests": {crop: {pest: {stage: effective weight}}}}`` —
    ``pests`` also lists which stages each crop's pest records."""
    roles: dict = {}
    weights: dict = {}
    for r in stage_rows or ():
        name = (r.get("name") or "").strip()
        if not name:
            continue
        roles[name] = normalise_role(r.get("stage_role"))
        weights[name] = resolve_weight(r.get("weight"), None)
    pests: dict = {}
    for r in filter_rows or ():
        crop = (r.get("crop") or "").strip()
        pest = (r.get("pest") or "").strip()
        stage = (r.get("stage") or "").strip()
        if not (crop and pest and stage):
            continue
        pests.setdefault(crop, {}).setdefault(pest, {})[stage] = resolve_weight(weights.get(stage), r.get("weight"))
    return {"roles": roles, "weights": weights, "pests": pests}


def weight_in(cat, crop, pest, stage) -> float:
    """``stage``'s weight for ``crop``'s ``pest``: the row's effective weight,
    else the master's, else 1.0."""
    stage = (stage or "").strip()
    per = ((cat.get("pests") or {}).get(crop or "") or {}).get(pest or "") or {}
    if stage in per:
        return per[stage]
    return resolve_weight((cat.get("weights") or {}).get(stage), None)


def signs_in(cat, crop, pest=None) -> list:
    """The Sign stages ``crop``'s Pest Filter lists for ``pest`` (any pest when
    None), sorted. Empty → the pest has no signs figure (S4)."""
    per = (cat.get("pests") or {}).get(crop or "") or {}
    roles = cat.get("roles") or {}
    pests = [pest] if pest else list(per)
    return sorted({s for p in pests for s in (per.get(p) or {}) if role_of(s, roles) == SIGN})


# ── cached catalog ─────────────────────────────────────────────────────────


def _load() -> dict:
    has = frappe.db.has_column
    role_col = "stage_role" if has("Stage", "stage_role") else "NULL"
    weight_col = "weight" if has("Stage", "weight") else "NULL"
    override_col = "s.weight" if has("Pests Stages", "weight") else "0"
    return build(
        frappe.db.sql(
            f"select name, {role_col} as stage_role, {weight_col} as weight from `tabStage`",
            as_dict=True,
        ),
        frappe.db.sql(
            f"""select pf.crop_scouted as crop, pf.pest as pest, s.stage as stage, {override_col} as weight
                from `tabPests Stages` s
                join `tabPest Filter` pf on pf.name = s.parent
                where s.parenttype = 'Pest Filter'
                  and ifnull(pf.crop_scouted, '') != '' and ifnull(pf.pest, '') != ''""",
            as_dict=True,
        ),
    )


def catalog() -> dict:
    return get_or_set(K_STAGE_ROLES, _load, ttl=TTL_MEDIUM) or {}


def invalidate_stage_roles() -> None:
    invalidate(K_STAGE_ROLES)


def role_map() -> dict:
    """``{stage: role}`` for every Stage."""
    return dict(catalog().get("roles") or {})


def master_weight(stage) -> float:
    return resolve_weight((catalog().get("weights") or {}).get((stage or "").strip()), None)


def stage_weight(crop, pest, stage) -> float:
    return weight_in(catalog(), crop, pest, stage)


def pest_weights(crop, pest) -> dict:
    """``{stage: effective weight}`` for every stage ``crop``'s ``pest`` records."""
    return dict(((catalog().get("pests") or {}).get(crop or "") or {}).get(pest or "") or {})


def sign_stages(crop, pest=None) -> list:
    return signs_in(catalog(), crop, pest)
