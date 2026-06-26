"""Shared helpers for the dashboard aggregation endpoints.

These functions are pure where possible so they can be unit-tested without a
Frappe site; functions that hit the database take explicit dependencies.
"""

import hashlib
import json
import re

import frappe



def stage_icon_map() -> dict:
    """{stage_name: icon_key} from the Stage catalog. The icon_key IS a marker
    shape name (see frontend MarkerDefs), so the same stage renders the same
    shape across every pest/disease. Unknown stages resolve to "" -> the
    frontend falls back to a circle."""
    return {
        s["name"]: (s.get("icon_key") or "")
        for s in frappe.get_all("Stage", fields=["name", "icon_key"], limit_page_length=0)
    }


def resolve_greenhouse_scope(
    greenhouse: str,
    farm: str,
    farms_map: dict,
) -> list | None:
    """Match the Dashboard.tsx greenhouseScope rule:

    - explicit greenhouse wins → [greenhouse]
    - farm without greenhouse → farms_map[farm] (empty list if farm unknown)
    - both empty → None (i.e. no greenhouse filter)
    """
    if greenhouse:
        return [greenhouse]
    if farm:
        return list(farms_map.get(farm, []))
    return None


def filter_hash(filters: dict) -> str:
    """20-char hex of SHA-1(JSON with sorted keys). Stable across argument order."""
    payload = json.dumps(filters, sort_keys=True, default=str)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:20]


def pest_severity(count) -> str | None:
    """Mirror aggregate.ts sevByMagnitude: count > 15 → high, > 5 → moderate."""
    try:
        n = int(count or 0)
    except (TypeError, ValueError):
        return None
    if n > 15:
        return "high"
    if n > 5:
        return "moderate"
    return None


_HIGH_RE = re.compile(r"high|severe|active", re.IGNORECASE)
_MOD_RE = re.compile(r"moderate|medium", re.IGNORECASE)


def disease_severity(s) -> str | None:
    """Mirror aggregate.ts sevByDiseaseKeyword."""
    text = (s or "").strip()
    if not text:
        return None
    if _HIGH_RE.search(text):
        return "high"
    if _MOD_RE.search(text):
        return "moderate"
    return None


# ─── % of zones severity ────────────────────────────────────────────────
# The new model: severity comes from ``% of zones in the greenhouse that
# have this (pest|disease, stage) observation``, compared to thresholds
# stored on the ``Crop Scouted`` doctype's Pest Filter / Disease Filter
# rows (with per-stage overrides on the stages child rows).
#
# Threshold lookup precedence:
#   1. Per-stage row on the filter's stages child (matched by stage name)
#   2. Aggregate fallback on the parent Pest Filter / Disease Filter
#
# A filter row whose three thresholds are all zero is treated as
# "unconfigured" — severity stays None instead of classifying every
# nonzero pct as ``low``. That matches the seeded-with-zeros behaviour
# the GM sees on a fresh install and avoids spamming alerts before
# anyone has tuned the numbers.

# Lightweight per-call cache. Threshold lookups can be hit many times
# inside a single aggregate, so we cache by crop on ``frappe.local`` and
# rebuild when the underlying Crop Scouted doc is bumped.
_THRESHOLD_CACHE_ATTR = "_scp_threshold_cache"


def _threshold_cache() -> dict:
    cache = getattr(frappe.local, _THRESHOLD_CACHE_ATTR, None)
    if cache is None:
        cache = {}
        setattr(frappe.local, _THRESHOLD_CACHE_ATTR, cache)
    return cache


def _zero_band(low, mod, high) -> bool:
    """All three thresholds at 0 → treat as unconfigured. We can't
    distinguish a real ``everything is High`` band from a default-zero
    row, so the safe call is to skip classification entirely."""
    return (low or 0) == 0 and (mod or 0) == 0 and (high or 0) == 0


def load_thresholds(crop: str) -> dict:
    """Return ``{(kind, obs_name, stage): {low, mod, high}}`` for one Crop
    Scouted doc, plus aggregate fallbacks keyed by ``(kind, obs_name, "")``.

    ``kind`` is ``"pest"`` or ``"disease"``. ``stage=""`` is the
    aggregate-fallback entry. Empty crop returns an empty map (severity
    classifier will just return None for everything).
    """
    crop = (crop or "").strip()
    if not crop:
        return {}
    cache = _threshold_cache()
    if crop in cache:
        return cache[crop]

    if not frappe.db.exists("Crop Scouted", crop):
        cache[crop] = {}
        return cache[crop]

    out: dict = {}

    # Pests: walk Pest Filter → its Pests Stages children
    pest_rows = frappe.db.sql(
        """
        SELECT pf.name AS row_name, pf.pest, pf.low_threshold,
               pf.moderate_threshold, pf.high_threshold
        FROM `tabPest Filter` pf
        WHERE pf.crop_scouted = %(crop)s
        """,
        {"crop": crop},
        as_dict=True,
    )
    for pf in pest_rows:
        if not _zero_band(pf["low_threshold"], pf["moderate_threshold"], pf["high_threshold"]):
            out[("pest", pf["pest"], "")] = {
                "low":  float(pf["low_threshold"] or 0),
                "mod":  float(pf["moderate_threshold"] or 0),
                "high": float(pf["high_threshold"] or 0),
            }
        stage_rows = frappe.db.sql(
            """
            SELECT stage, low_threshold, moderate_threshold, high_threshold
            FROM `tabPests Stages`
            WHERE parent = %(row)s AND parenttype = 'Pest Filter'
            """,
            {"row": pf["row_name"]},
            as_dict=True,
        )
        for sr in stage_rows:
            if _zero_band(sr["low_threshold"], sr["moderate_threshold"], sr["high_threshold"]):
                continue
            out[("pest", pf["pest"], (sr["stage"] or "").strip())] = {
                "low":  float(sr["low_threshold"] or 0),
                "mod":  float(sr["moderate_threshold"] or 0),
                "high": float(sr["high_threshold"] or 0),
            }

    # Diseases: same shape via Disease Filter → Disease Stages
    dis_rows = frappe.db.sql(
        """
        SELECT df.name AS row_name, df.disease, df.low_threshold,
               df.moderate_threshold, df.high_threshold
        FROM `tabDisease Filter` df
        WHERE df.crop_scouted = %(crop)s
        """,
        {"crop": crop},
        as_dict=True,
    )
    for df in dis_rows:
        if not _zero_band(df["low_threshold"], df["moderate_threshold"], df["high_threshold"]):
            out[("disease", df["disease"], "")] = {
                "low":  float(df["low_threshold"] or 0),
                "mod":  float(df["moderate_threshold"] or 0),
                "high": float(df["high_threshold"] or 0),
            }
        stage_rows = frappe.db.sql(
            """
            SELECT stage, low_threshold, moderate_threshold, high_threshold
            FROM `tabDisease Stages`
            WHERE parent = %(row)s AND parenttype = 'Disease Filter'
            """,
            {"row": df["row_name"]},
            as_dict=True,
        )
        for sr in stage_rows:
            if _zero_band(sr["low_threshold"], sr["moderate_threshold"], sr["high_threshold"]):
                continue
            out[("disease", df["disease"], (sr["stage"] or "").strip())] = {
                "low":  float(sr["low_threshold"] or 0),
                "mod":  float(sr["moderate_threshold"] or 0),
                "high": float(sr["high_threshold"] or 0),
            }

    cache[crop] = out
    return out


def severity_from_pct(
    pct: float,
    thresholds: dict | None,
) -> str | None:
    """Classify a zone-coverage percentage against {low, mod, high}.

    Returns ``"high" | "moderate" | "low" | None``. ``thresholds=None``
    or unconfigured → None. Bands are inclusive of the high end so a
    pct exactly at the high threshold classifies as High."""
    if not thresholds:
        return None
    high = thresholds.get("high") or 0
    mod = thresholds.get("mod") or 0
    low = thresholds.get("low") or 0
    if high > 0 and pct >= high:
        return "high"
    if mod > 0 and pct >= mod:
        return "moderate"
    if low > 0 and pct >= low:
        return "low"
    return None


def severity_for(
    crop: str,
    kind: str,
    obs_name: str,
    stage: str,
    pct: float,
) -> str | None:
    """Look up thresholds for (crop, kind, obs_name, stage) — stage rule
    first, aggregate fallback — and classify ``pct``."""
    thresholds = load_thresholds(crop)
    if not thresholds:
        return None
    stage_key = (kind, obs_name, (stage or "").strip())
    agg_key = (kind, obs_name, "")
    band = thresholds.get(stage_key) or thresholds.get(agg_key)
    return severity_from_pct(pct, band)


K_DASH_AGG_PREFIX = "scp:dash_agg"
# Versioning the key with K_SCOUTING_PAYLOAD_VERSION was the original design,
# but every Scouting Entry insert/update bumps that stamp via
# cache_utils.invalidate_on_change — on a busy site (mobile syncs) the
# cache never warmed because the version flipped between cold compute and
# warm read. Drop the version stamp; rely on TTL for staleness bounds, and
# rely on the scp:scouting:dirty realtime channel for prompt invalidation
# in the browser (frontend refetches, which hits a still-warm key but with
# server-side recompute on TTL expiry).
DASH_AGG_TTL = 60  # seconds — bound stale window when realtime push misses


def _build_key(endpoint: str, filters: dict) -> str:
    return f"{K_DASH_AGG_PREFIX}:{endpoint}:{filter_hash(filters)}"


def cached_aggregate(endpoint: str, filters: dict, compute, force: bool = False):
    """Read-through cache for an aggregate endpoint.

    `compute` is a zero-arg callable producing the payload. `force=True`
    skips the read and overwrites the cached value with a freshly computed
    one.

    We do NOT use ``cache_utils.get_or_set`` because Frappe's
    ``RedisWrapper.get_value`` (called without ``expires=True``) memoizes
    the cached value — including ``None`` — into ``frappe.local.cache``.
    A subsequent ``set_value`` with ``expires_in_sec`` only updates Redis;
    the in-process ``None`` memo stays, so future reads in the same
    worker keep returning ``None`` and ``compute()`` runs every call.
    The fix is to pass ``expires=True`` on the read, which the wrapper
    documents as "don't store it in frappe.local".
    """
    cache = frappe.cache()
    key = _build_key(endpoint, filters)
    if not force:
        cached = cache.get_value(key, expires=True)
        if cached is not None:
            return cached
    payload = compute()
    cache.set_value(key, payload, expires_in_sec=DASH_AGG_TTL)
    return payload


DASH_AGG_PROGRESS_EVENT = "scp:dash_agg:progress"


def publish_progress(job_id: str, percent: int, label: str = "") -> None:
    """Push a progress event to the calling user's socket.

    ``after_commit=False`` so the message is flushed immediately while the
    worker is still computing; otherwise it would queue until the request
    ends and the client would only see 100% at completion. No-ops when
    ``job_id`` is falsy so endpoints can skip the work when the caller did
    not pass a job id (warm-cache hits never reach here anyway).
    """
    if not job_id:
        return
    try:
        frappe.publish_realtime(
            event=DASH_AGG_PROGRESS_EVENT,
            message={"job_id": job_id, "percent": int(percent), "label": label},
            user=frappe.session.user,
            after_commit=False,
        )
    except Exception:
        # Realtime is best-effort UI sugar; never let it break the response.
        pass


def parent_filter_conditions(
    from_date: str,
    to_date: str,
    crop: str,
    greenhouse_scope: list | None,
) -> tuple:
    """Build a ``(sql_where, params_dict)`` pair restricting tabScouting Entry.

    Returns ('1=0', {}) if greenhouse_scope is an empty list (i.e. farm with
    no greenhouses — filter excludes everything). None means no greenhouse
    filter at all.
    """
    if greenhouse_scope == []:
        return "1=0", {}

    parts = ["se.date_of_capture BETWEEN %(from_date)s AND %(to_date)s"]
    params = {"from_date": from_date, "to_date": to_date}

    if crop:
        # Roses-only sites (e.g. mona) leave crop_scouted unset on every
        # Scouting Entry, so a strict equality filter drops every row. Treat
        # unset crop as a match: only EXCLUDE rows tagged to a different crop.
        parts.append(
            "(se.crop_scouted = %(crop)s "
            "OR se.crop_scouted IS NULL OR se.crop_scouted = '')"
        )
        params["crop"] = crop

    if greenhouse_scope is not None:
        # MySQL/MariaDB: place-holder list expansion via frappe.db.escape
        gh_list = ", ".join(frappe.db.escape(g) for g in greenhouse_scope)
        parts.append(f"(se.greenhouse IN ({gh_list}) OR se.block IN ({gh_list}))")

    return " AND ".join(parts), params


def coerce_date(value, default=None) -> str:
    """Accept date/datetime/'YYYY-MM-DD' and return canonical 'YYYY-MM-DD'."""
    if not value:
        return default or ""
    if hasattr(value, "isoformat"):
        return value.isoformat()[:10]
    return str(value)[:10]
