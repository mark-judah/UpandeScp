"""Shared helpers for the dashboard aggregation endpoints.

These functions are pure where possible so they can be unit-tested without a
Frappe site; functions that hit the database take explicit dependencies.
"""

import hashlib
import json
import re

import frappe

from upande_scp.serverscripts.cache_utils import get_or_set, scouting_payload_version


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
DASH_AGG_TTL = 120  # seconds


def _build_key(endpoint: str, filters: dict) -> str:
    v = scouting_payload_version()
    return f"{K_DASH_AGG_PREFIX}:v{v}:{endpoint}:{filter_hash(filters)}"


def cached_aggregate(endpoint: str, filters: dict, compute, force: bool = False):
    """Read-through cache for an aggregate endpoint.

    `compute` is a zero-arg callable producing the payload. `force=True`
    skips the read and overwrites the cached value with a freshly computed
    one. Backed by the same Redis adapter as ``cache_utils.get_or_set``;
    any ``frappe.cache()`` failure propagates to the caller as a 500 — we
    do not silently swallow it.
    """
    key = _build_key(endpoint, filters)
    if force:
        payload = compute()
        frappe.cache().set_value(key, payload, expires_in_sec=DASH_AGG_TTL)
        return payload
    return get_or_set(key, compute, ttl=DASH_AGG_TTL)
