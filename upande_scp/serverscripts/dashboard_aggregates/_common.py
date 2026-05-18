"""Shared helpers for the dashboard aggregation endpoints.

These functions are pure where possible so they can be unit-tested without a
Frappe site; functions that hit the database take explicit dependencies.
"""

import hashlib
import json
import re

import frappe



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
        parts.append("se.crop_scouted = %(crop)s")
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
