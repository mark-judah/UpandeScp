"""Shared helpers for the dashboard aggregation endpoints.

These functions are pure where possible so they can be unit-tested without a
Frappe site; functions that hit the database take explicit dependencies.
"""

import hashlib
import json
import re

import frappe

from upande_scp.serverscripts.common import crop_catalog
from upande_scp.serverscripts.common import stage_roles
from upande_scp.serverscripts.common import threshold_bands as B



K_STAGE_ICON_MAP = "scp:dash_agg:stage_icon_map"
STAGE_ICON_MAP_TTL = 3600  # 1h — Stage is a small, rarely-edited catalog


def stage_icon_map() -> dict:
    """{stage_name: icon_key} from the Stage catalog. The icon_key IS a marker
    shape name (see frontend MarkerDefs), so the same stage renders the same
    shape across every pest/disease. Unknown stages resolve to "" -> the
    frontend falls back to a circle.

    Cached the same way as ``_cached_pest_colors``/``_cached_disease_colors``
    (get_complete_scouting_entries.py): this used to be a plain
    ``frappe.get_all`` called on every ``_shape()`` invocation, including
    warm-cache hits — the one query the endpoint should not have on a warm
    path. TTL-only invalidation is fine; nothing bumps this key on Stage
    edits, but the catalog changes rarely enough that the 1h staleness
    window is a non-issue.
    """
    cache = frappe.cache()
    value = cache.get_value(K_STAGE_ICON_MAP)
    if value is None:
        value = {
            s["name"]: (s.get("icon_key") or "")
            for s in frappe.get_all("Stage", fields=["name", "icon_key"], limit_page_length=0)
        }
        cache.set_value(K_STAGE_ICON_MAP, value, expires_in_sec=STAGE_ICON_MAP_TTL)
    return value


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


def clear_threshold_cache() -> None:
    """Drop the per-request threshold memo — after any band or measure write."""
    if hasattr(frappe.local, _THRESHOLD_CACHE_ATTR):
        delattr(frappe.local, _THRESHOLD_CACHE_ATTR)


def station_word(crop: str) -> str:
    """The station a Count is "per": ``"tree"`` for a crop scouted on Block
    warehouses (Orchard Trees — Lokitela's avocado), else ``"zone"``. Read from
    the crop's houses, so a new block crop needs no code change."""
    houses = crop_catalog.greenhouses_for_crop(crop) if crop else []
    if houses and frappe.db.count("Warehouse", {"name": ["in", houses], "warehouse_type": "Block"}):
        return "tree"
    return "zone"


def _zero_band(low, mod, high) -> bool:
    """All three thresholds at 0 → treat as unconfigured. We can't
    distinguish a real ``everything is High`` band from a default-zero
    row, so the safe call is to skip classification entirely."""
    return (low or 0) == 0 and (mod or 0) == 0 and (high or 0) == 0


def load_thresholds(crop: str) -> dict:
    """``{(kind, obs_name, stage): spec}`` for one Crop Scouted; ``stage=""`` is
    the row's own (all-stage) band.

    A spec is ``{"low", "mod", "high", "measure", "row_measure", "count_stages",
    "count_weights", "reading_types"}``. ``measure`` is what this key is judged in
    (``threshold_bands.effective_measure``). ``count_stages`` are the stages a
    Count figure sums: every counted stage for the row key, the stage itself for
    a stage key. ``count_stages`` for the row key holds counted Life stage / Form
    stages only — a Sign is never the pest (stage & variety S5) — and
    ``count_weights`` carries their weights (``((stage, w), …)``); a stage key
    reads its raw count (``()``). Unset (all-zero) and misordered bands are left out, so they
    classify nothing. Memoised per request; ``clear_threshold_cache`` drops it.
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
    _load_kind(
        out, crop,
        parent_table="Pest Filter", child_table="Pests Stages",
        obs_col="pest", kind="pest",
    )
    _load_kind(
        out, crop,
        parent_table="Disease Filter", child_table="Disease Stages",
        obs_col="disease", kind="disease",
    )

    cache[crop] = out
    return out


def _usable(low, mod, high) -> bool:
    return B.is_configured(low, mod, high) and B.bands_ascending(low, mod, high)


def _count_weights(crop: str, obs: str, stages) -> tuple:
    """S5/S6: ``((stage, weight), …)`` for a row's Count, sorted — hashable,
    so the StationWeeks memo can key on it."""
    return tuple(sorted((s, stage_roles.stage_weight(crop, obs, s)) for s in stages))


def _load_kind(out: dict, crop: str, *, parent_table: str, child_table: str, obs_col: str, kind: str) -> None:
    """Populate ``out`` for one kind with one LEFT JOIN. A filter row with no
    stage children comes back once with every ``s_*`` column NULL; that is not a
    stage entry. Count is honoured only for a pest with a counted stage (D1)."""
    measure_col = "pf.measure" if frappe.db.has_column(parent_table, "measure") else "'Percentage'"
    rows = frappe.db.sql(
        f"""
        SELECT pf.name AS row_name, pf.`{obs_col}` AS obs, {measure_col} AS measure,
               pf.low_threshold, pf.moderate_threshold, pf.high_threshold,
               s.stage AS s_stage, s.reading_type AS s_rt, s.low_threshold AS s_low,
               s.moderate_threshold AS s_mod, s.high_threshold AS s_high
        FROM `tab{parent_table}` pf
        LEFT JOIN `tab{child_table}` s
            ON s.parent = pf.name AND s.parenttype = %(parent_table)s
        WHERE pf.crop_scouted = %(crop)s
        """,
        {"crop": crop, "parent_table": parent_table},
        as_dict=True,
    )
    roles = stage_roles.role_map() if kind == "pest" else {}
    by_row: dict = {}
    for r in rows:
        by_row.setdefault(r["row_name"], []).append(r)

    for group in by_row.values():
        head = group[0]
        obs = head["obs"]
        stages = [r for r in group if r["s_stage"] is not None]
        reading_types = {(r["s_stage"] or "").strip(): (r["s_rt"] or "") for r in stages}
        # S5: a pest's Count sums its counted LIVE stages — a Sign (damage,
        # webs) recorded as a number is still not the pest.
        counted = frozenset(
            s for s, rt in reading_types.items()
            if rt == B.COUNT and (kind != "pest" or stage_roles.is_live(s, roles))
        )
        row_measure = head["measure"] if head["measure"] in B.MEASURES else B.PERCENTAGE
        if kind != "pest" or not counted:
            row_measure = B.PERCENTAGE
        shared = {"row_measure": row_measure, "reading_types": reading_types}

        if _usable(head["low_threshold"], head["moderate_threshold"], head["high_threshold"]):
            out[(kind, obs, "")] = {
                "low":  float(head["low_threshold"] or 0),
                "mod":  float(head["moderate_threshold"] or 0),
                "high": float(head["high_threshold"] or 0),
                "measure": row_measure,
                "count_stages": counted,
                "count_weights": _count_weights(crop, obs, counted) if kind == "pest" else (),
                **shared,
            }
        for r in stages:
            if not _usable(r["s_low"], r["s_mod"], r["s_high"]):
                continue
            stage = (r["s_stage"] or "").strip()
            out[(kind, obs, stage)] = {
                "low":  float(r["s_low"] or 0),
                "mod":  float(r["s_mod"] or 0),
                "high": float(r["s_high"] or 0),
                "measure": B.effective_measure(row_measure, reading_types.get(stage, "")),
                "count_stages": frozenset({stage}),
                "count_weights": (),
                **shared,
            }


def severity_from_pct(
    pct: float,
    thresholds: dict | None,
) -> str | None:
    """Classify a figure against {low, mod, high} with the one band classifier
    (``threshold_bands.band_of``). Returns ``"high" | "moderate" | "low" | None``;
    ``thresholds=None``, unconfigured, misordered or below every band → None."""
    if not thresholds:
        return None
    return B.band_of(pct, thresholds.get("low"), thresholds.get("mod"), thresholds.get("high")) or None


def band_spec(crop: str, kind: str, obs_name: str, stage: str = "") -> dict | None:
    """The bands a (kind, observation, stage) figure is judged against, and the
    measure it is judged in: the stage's own bands first, else the row's bands
    read in the stage's measure (a tick-box stage under a Count row is a share,
    and its Count — were it counted — would be that stage's alone)."""
    thresholds = load_thresholds(crop)
    if not thresholds:
        return None
    stage = (stage or "").strip()
    if stage:
        own = thresholds.get((kind, obs_name, stage))
        if own:
            return own
    row = thresholds.get((kind, obs_name, ""))
    if not row or not stage:
        return row
    return {
        **row,
        "measure": B.effective_measure(row["row_measure"], row["reading_types"].get(stage, "")),
        "count_stages": frozenset({stage}),
        "count_weights": (),
    }


def house_value(crop: str, kind: str, obs_name: str, stage: str, weeks, wh: str, fig) -> float | None:
    """A house's latest-week figure in the measure its bands are read in:
    ``fig["prevalence"]`` for a Percentage, the average count per scouted
    station (``weeks.count_latest``) for a Count. None when there is none."""
    spec = band_spec(crop, kind, obs_name, stage)
    if spec and spec["measure"] == B.COUNT:
        cfig = weeks.count_latest(wh, kind, obs_name, stages=spec["count_stages"],
                                  weights=spec.get("count_weights"))
        return cfig["value"] if cfig else None
    return fig.get("prevalence") if fig else None


def severity_for(
    crop: str,
    kind: str,
    obs_name: str,
    stage: str,
    value: float | None,
) -> str | None:
    """Classify ``value`` — already in the measure ``band_spec`` names; get it
    with ``house_value`` — against the stage band, else the row band."""
    if value is None:
        return None
    return severity_from_pct(value, band_spec(crop, kind, obs_name, stage))


K_DASH_AGG_PREFIX = "scp:dash_agg"
# Bumped when an aggregate's meaning changes without its filters changing, so a
# deploy never serves a payload computed under the old rules. "crop2": crop-less
# entries count under their greenhouse's crop and off-crop pests/diseases drop out.
# "thr1": severity is judged in the row's measure (Percentage or Count) by
# threshold_bands.band_of, so a payload cached under "prev1" may be mis-classed.
# "stg1": pest prevalence counts live stages only and payloads carry ``signs`` /
# ``varieties`` (stage & variety spec S3, S4, S7).
# "pin1": the house_clusters aggregate (spread spec C4) joins the namespace.
# "hot2": a Percentage section's ``hot`` is judged on its Wilson lower bound.
# "hot1": greenhouse_detail sections carry ``hot`` (hot-spots spec H7).
# "prev1": percentages are station prevalence per ISO week over stations SCOUTED
# (common/prevalence.py), and payloads carry margin / sections / reliability.
K_DASH_AGG_SCHEMA = "stg1"
# Versioning the key with K_SCOUTING_PAYLOAD_VERSION was the original design,
# but every Scouting Entry insert/update bumps that stamp via
# cache_utils.invalidate_on_change — on a busy site (mobile syncs) the
# cache never warmed because the version flipped between cold compute and
# warm read. That version stamp was dropped in favour of a bare TTL.
#
# Bare TTL has its own cost: on a quiet site the cache is discarded every
# TTL seconds even though nothing changed, so most operators pay the cold
# (multi-second) compute instead of the warm (millisecond) one.
#
# Fix: reinstate a version stamp, but *debounce* the bump instead of firing
# it unconditionally on every write. ``cache_utils.publish_scouting_dirty``
# calls ``bump_dash_agg_version()`` on every scouting write; that function
# only actually increments the stamp for the first caller to win a
# ``SET NX EX`` lock, and is a no-op for every other write inside the same
# debounce window. Net effect:
#   - quiet period: stamp never bumps, keys stay warm for the full TTL.
#   - busy period: stamp bumps at most once per debounce window — same
#     staleness bound as the old unconditional-bump design, just without
#     the write amplification that kept the cache permanently cold.
# Old keys under a stale version orphan and expire via TTL; nothing needs
# to clean them up.
K_DASH_AGG_VERSION = "scp:dash_agg:ver"
K_DASH_AGG_BUMP_LOCK = "scp:dash_agg:bump_lock"
# 20 minutes, agreed with the operator as the acceptable staleness for a
# dashboard whose default view is a 30-day window. At the previous 60s the
# stamp bumped once a minute all through a scouting day, so every cached
# aggregate orphaned once a minute while a full rebuild costs ~16s — the cache
# could never stay warm and nearly every dashboard open paid the cold path.
# Measured on kaitetv16: overview lands at 2,555 ms warm vs 16,178 ms cold.
DASH_AGG_BUMP_DEBOUNCE = 1200  # seconds — the staleness bound for aggregates
DASH_AGG_TTL = 1800  # seconds — safe to raise now that the version stamp bounds staleness


def dash_agg_version() -> int:
    """Current version stamp for the dashboard aggregate cache namespace."""
    cache = frappe.cache()
    v = cache.get_value(K_DASH_AGG_VERSION)
    if v is None:
        v = 1
        cache.set_value(K_DASH_AGG_VERSION, v)
    return v


def bump_dash_agg_version() -> None:
    """Debounced version bump — see the DASH_AGG_TTL comment above.

    Acquires a short-lived Redis lock with ``SET <lock> 1 EX <debounce> NX``
    semantics: only the caller that wins the lock (the first one in the
    window) increments the stamp. Every other caller inside the same window
    returns immediately without touching Redis again. ``RedisWrapper`` (a
    subclass of ``redis.Redis``) exposes the raw ``set`` command with its
    native ``nx``/``ex`` kwargs, so this bypasses the higher-level
    ``set_value`` wrapper on purpose.
    """
    cache = frappe.cache()
    lock_key = cache.make_key(K_DASH_AGG_BUMP_LOCK)
    acquired = cache.set(name=lock_key, value=b"1", ex=DASH_AGG_BUMP_DEBOUNCE, nx=True)
    if not acquired:
        return
    v = cache.get_value(K_DASH_AGG_VERSION) or 1
    cache.set_value(K_DASH_AGG_VERSION, int(v) + 1)


def _build_key(endpoint: str, filters: dict) -> str:
    return f"{K_DASH_AGG_PREFIX}:v{dash_agg_version()}:{K_DASH_AGG_SCHEMA}:{endpoint}:{filter_hash(filters)}"


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


#: How long a job's progress stays readable after its last update. Long enough to
#: outlive a slow poll, short enough that abandoned jobs evaporate.
DASH_AGG_PROGRESS_TTL = 120


def _progress_key(job_id: str) -> str:
    return f"scp:dash_agg:progress:{job_id}"


def publish_progress(job_id: str, percent: int, label: str = "") -> None:
    """Record progress for a job, two ways.

    **Cache** is the one that actually reaches the SPA. The standalone
    ``/scp_app`` shell does not load Frappe's socket.io bundle, so
    ``frappe.realtime`` is undefined there and every realtime event published
    below is dropped on the floor — which is why the loader used to show a
    simulated creep instead of the real figure. Writing the percent to a cache key
    the client can poll makes the number real wherever the page is hosted.

    **Realtime** is still published for the Desk-hosted case, where it arrives
    sooner and costs the client nothing. ``after_commit=False`` so it flushes while
    the worker is still computing; otherwise the client would only ever see 100% at
    completion.

    No-ops when `job_id` is falsy, so endpoints can skip the work when the caller
    did not pass one (warm-cache hits never reach here anyway).
    """
    if not job_id:
        return
    percent = max(0, min(100, int(percent)))
    try:
        frappe.cache().set_value(
            _progress_key(job_id),
            {"percent": percent, "label": label},
            expires_in_sec=DASH_AGG_PROGRESS_TTL,
        )
    except Exception:
        # Progress is UI sugar; never let it break the response it describes.
        pass
    try:
        frappe.publish_realtime(
            event=DASH_AGG_PROGRESS_EVENT,
            message={"job_id": job_id, "percent": percent, "label": label},
            user=frappe.session.user,
            after_commit=False,
        )
    except Exception:
        pass


@frappe.whitelist()
def job_progress(job_id=None):
    """How far along a cold aggregate call is. Polled by the loading bar.

    Returns ``None`` when nothing is recorded — the normal case for a warm-cache
    hit, and the signal the client uses to stay indeterminate rather than invent a
    number. Job ids are client-generated UUIDs carrying no data, so reading one is
    not a disclosure; the payload is a percent and a label.
    """
    if not job_id:
        return None
    try:
        return frappe.cache().get_value(_progress_key(str(job_id)))
    except Exception:
        return None


def partition_scope(names, units=None) -> tuple:
    """Split warehouse names into (greenhouse-type, block-type).

    The location column a Scouting Entry populates is decided by the
    warehouse's type, not by the crop: on kaitet 293 769 entries resolve
    via `greenhouse` (warehouse_type 'Greenhouse') and 3 362 via `block`
    ('Block'), with zero rows carrying both or neither. Keying on type
    rather than crop also means a new block-based crop needs no code change.

    Unknown names default to greenhouse — 2 775 kaitet entries have a NULL
    crop and use the greenhouse column, and dropping them would silently
    change every dashboard number.
    """
    if units is None:
        from upande_scp.serverscripts.scouting import scouting_metrics
        units = scouting_metrics.get_units_by_warehouse() or {}
    ghs, blocks = [], []
    for n in names:
        if (units.get(n) or {}).get("type") == "block":
            blocks.append(n)
        else:
            ghs.append(n)
    return ghs, blocks


def parent_filter_conditions(
    from_date: str,
    to_date: str,
    crop: str,
    greenhouse_scope: list | None,
    units=None,
) -> tuple:
    """Build a ``(sql_where, params_dict)`` pair restricting tabScouting Entry.

    Returns ('1=0', {}) if greenhouse_scope is an empty list (i.e. farm with
    no greenhouses — filter excludes everything). None means no greenhouse
    filter at all.

    A single-column predicate is emitted whenever the scope is all one
    warehouse type, which is what lets scouting_date_gh_idx /
    scouting_date_block_idx drive the query. Mixed scopes keep the
    disjunction; that is rare and correctness wins over the index.
    """
    if greenhouse_scope == []:
        return "1=0", {}

    parts = ["se.date_of_capture BETWEEN %(from_date)s AND %(to_date)s"]
    params = {"from_date": from_date, "to_date": to_date}

    if crop:
        # D5: an entry with no crop counts under its greenhouse's crop. The
        # params also carry the crop's pest/disease lists for obs_filter (D4).
        parts.append(crop_catalog.entry_crop_condition("se"))
        params.update(crop_catalog.crop_sql_params(crop))

    if greenhouse_scope is not None:
        ghs, blocks = partition_scope(greenhouse_scope, units=units)
        gh_sql = ", ".join(frappe.db.escape(g) for g in ghs)
        blk_sql = ", ".join(frappe.db.escape(b) for b in blocks)
        if ghs and blocks:
            parts.append(
                f"(se.greenhouse IN ({gh_sql}) OR se.block IN ({blk_sql}))"
            )
        elif blocks:
            parts.append(f"se.block IN ({blk_sql})")
        else:
            parts.append(f"se.greenhouse IN ({gh_sql})")

    return " AND ".join(parts), params


def obs_filter(kind: str, column: str, params: dict) -> str:
    """D4: ``" AND <column> IN (the crop's pests|diseases)"``.

    Keyed off the params ``parent_filter_conditions`` produced, so a query only
    has to pass what it already has; ``""`` when no crop is in play.
    """
    if "crop_pests" not in params:
        return ""
    return " AND " + crop_catalog.obs_crop_condition(kind, column)


def coerce_date(value, default=None) -> str:
    """Accept date/datetime/'YYYY-MM-DD' and return canonical 'YYYY-MM-DD'."""
    if not value:
        return default or ""
    if hasattr(value, "isoformat"):
        return value.isoformat()[:10]
    return str(value)[:10]
