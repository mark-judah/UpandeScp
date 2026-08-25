import frappe

from upande_scp.serverscripts.scouting import scouting_metrics
from upande_scp.serverscripts.common.cache_utils import (
    K_CROPS_SCOUTED,
    K_DISEASE_COLORS,
    K_PEST_COLORS,
    K_SCOUTING_PAYLOAD_PREFIX,
    K_SM_SEVERITY_THRESHOLDS,
    K_SM_UNITS_BY_WH,
    K_SM_ZONE_COUNTS_BY_GH,
    TTL_LONG,
    TTL_MEDIUM,
    TTL_SHORT,
    get_or_set,
    scouting_payload_version,
)


CACHE_TTL = 300  # seconds; legend colors + zone counts rarely change


def _cached_pest_colors():
    cache = frappe.cache()
    value = cache.get_value(K_PEST_COLORS)
    if value is None:
        value = frappe.get_all(
            "Pest",
            fields=["name", "pests_legend_color"],
            limit_page_length=0,
        )
        cache.set_value(K_PEST_COLORS, value, expires_in_sec=CACHE_TTL)
    return value


def _cached_disease_colors():
    cache = frappe.cache()
    value = cache.get_value(K_DISEASE_COLORS)
    if value is None:
        value = frappe.get_all(
            "Plant Disease",
            fields=["name", "disease_legend_color"],
            limit_page_length=0,
        )
        cache.set_value(K_DISEASE_COLORS, value, expires_in_sec=CACHE_TTL)
    return value


def _cached_zones_by_greenhouse():
    """{greenhouse: zone_count} — shares the Zone-invalidated cache with
    scouting_metrics_api so an edit flushes both this meta payload and any
    other consumer in a single hook."""
    return get_or_set(
        K_SM_ZONE_COUNTS_BY_GH,
        scouting_metrics.get_zone_counts_by_greenhouse,
        ttl=TTL_LONG,
    )


def _cached_units_by_warehouse():
    """{warehouse: {type, count, farm}} — zones for greenhouses, trees for blocks."""
    return get_or_set(
        K_SM_UNITS_BY_WH,
        scouting_metrics.get_units_by_warehouse,
        ttl=TTL_LONG,
    )


def _cached_crops_with_farms():
    return get_or_set(
        K_CROPS_SCOUTED,
        scouting_metrics.get_crops_with_farms,
        ttl=TTL_MEDIUM,
    )


def _cached_severity_thresholds():
    return get_or_set(
        K_SM_SEVERITY_THRESHOLDS,
        scouting_metrics.get_severity_thresholds,
        ttl=TTL_MEDIUM,
    )


CACHE_WINDOW_DAYS = 90  # months older than this serve uncached (see docs/data_caching.md)


def _week_cache_key(iso_year, iso_week):
    """Per-ISO-week cache key.

    Mirrors the previous monthly key but is finer-grained. Filtering by
    greenhouse / block is still applied in-memory after the cache hit so
    we don't store the same source rows once per (greenhouse, all) shape.
    """
    v = scouting_payload_version()
    return f"{K_SCOUTING_PAYLOAD_PREFIX}:{v}:{iso_year:04d}-W{iso_week:02d}"


def _weeks_in_range(from_date, to_date):
    """List of ``(iso_year, iso_week)`` tuples covering [from_date, to_date].

    Order is monotonic in time. Inputs that arrive swapped are normalised.
    """
    start = _coerce_date(from_date)
    end = _coerce_date(to_date)
    if start > end:
        start, end = end, start
    seen = []
    seen_set = set()
    cur = start
    while cur <= end:
        key = _iso_year_week(cur)
        if key not in seen_set:
            seen_set.add(key)
            seen.append(key)
        # Step forward by 7 days; this can skip into the next ISO week.
        from datetime import timedelta
        cur = cur + timedelta(days=1)
        # Fast-forward to Monday of the week containing `cur` so we don't
        # iterate day-by-day across long ranges.
        weekday = cur.isoweekday()  # Mon=1..Sun=7
        if weekday != 1:
            cur = cur + timedelta(days=(8 - weekday))
    return seen


def _coerce_date(value):
    """Accept ``date``, ``datetime`` or ISO/Frappe-style strings."""
    from datetime import date, datetime

    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if not value:
        raise ValueError("date required")
    text = str(value)[:10]
    return datetime.strptime(text, "%Y-%m-%d").date()


def _iso_year_week(d):
    """Return ``(iso_year, iso_week)`` for a date. Follows ISO 8601 — the year
    of the Thursday in the same week, so the last few days of December may
    belong to ISO week 1 of the next year (and vice versa)."""
    iso = d.isocalendar()
    return (iso[0], iso[1])


def _week_bounds(iso_year, iso_week):
    """Return ``(monday_date, sunday_date)`` for an ISO ``(year, week)`` pair."""
    from datetime import date, timedelta

    # ISO uses Monday=1. ``date.fromisocalendar`` returns the Monday.
    monday = date.fromisocalendar(iso_year, iso_week, 1)
    sunday = monday + timedelta(days=6)
    return monday, sunday


def _is_recent_week(iso_year, iso_week):
    """Whether (iso_year, iso_week) sits inside the rolling cache window."""
    from datetime import date, timedelta

    _, sunday = _week_bounds(iso_year, iso_week)
    cutoff = date.today() - timedelta(days=CACHE_WINDOW_DAYS)
    return sunday >= cutoff


def _fetch_week_entries(iso_year, iso_week):
    """Return the normalized entries for one ISO week.

    Cached per-week, version-stamped, capped to the rolling
    ``CACHE_WINDOW_DAYS`` window. Greenhouse/block filtering is the caller's
    responsibility — keeping the cache key week-only avoids storing the same
    source rows once per filter shape.
    """
    cache = frappe.cache()
    cache_key = _week_cache_key(iso_year, iso_week)
    cached = cache.get_value(cache_key)
    if cached is not None:
        return cached

    monday, sunday = _week_bounds(iso_year, iso_week)
    entries = _build_month_entries(monday.isoformat(), sunday.isoformat())

    if _is_recent_week(iso_year, iso_week):
        # 24h TTL so a recent week stays hot all day without depending on the
        # hourly prewarm. Safe: every scouting write busts the exact ISO week it
        # touches (invalidate_scouting_week_for_doc), so the active week never
        # serves stale data and historical weeks rarely change.
        cache.set_value(cache_key, entries, expires_in_sec=TTL_LONG)
    return entries


def _filter_entries(entries, from_date, to_date, greenhouse_filter):
    from_d = _coerce_date(from_date)
    to_d = _coerce_date(to_date)
    gh = (greenhouse_filter or "").strip()

    # Short-circuit: if the requested range matches an ISO week, skip the
    # per-row date filter — entries pulled for one cached week already
    # satisfy it.
    from_is_monday = from_d.isoweekday() == 1
    range_is_one_week = (to_d - from_d).days == 6
    skip_date_filter = from_is_monday and range_is_one_week

    from_s = from_d.isoformat()
    to_s = to_d.isoformat()
    out = []
    for e in entries:
        d = e.get("date_of_capture")
        if not d:
            continue
        if not skip_date_filter:
            ds = str(d)[:10]
            if ds < from_s or ds > to_s:
                continue
        if gh and e.get("greenhouse") != gh and e.get("block") != gh:
            continue
        out.append(e)
    return out


def _fetch_scouting_payload(from_date, to_date, greenhouse_filter, include_meta=True):
    """Cached wrapper. Stitches ISO-week cache slices and applies the
    greenhouse / block filter in-memory.

    On a warm cache this is one Redis read per week covered by the range,
    plus a Python list filter. On a miss only the missing weeks are built.
    """
    weeks = _weeks_in_range(from_date, to_date)
    all_entries = []
    for (iy, iw) in weeks:
        all_entries.extend(_fetch_week_entries(iy, iw))

    entries = _filter_entries(all_entries, from_date, to_date, greenhouse_filter)
    payload = {
        "entries": entries,
        "total_entries": len(entries),
        "filters_applied": {
            "from_date": str(from_date),
            "to_date": str(to_date),
            "greenhouse": greenhouse_filter,
        },
    }
    if include_meta:
        payload["pest_colors"] = _cached_pest_colors()
        payload["disease_colors"] = _cached_disease_colors()
        payload["zones_by_greenhouse"] = _cached_zones_by_greenhouse()
        payload["units_by_greenhouse"] = _cached_units_by_warehouse()
        payload["crops_scouted"] = _cached_crops_with_farms()
        payload["severity_thresholds"] = _cached_severity_thresholds()
    return payload


def _build_month_entries(from_date, to_date):
    """Run the SQL join for one date range and return the entries list only.

    Identical to ``_build_scouting_payload`` minus the meta payload (meta has
    its own per-key caches; see _cached_* helpers above). Greenhouse filtering
    is intentionally NOT applied here — the cache is shared across all
    consumers."""
    scouting_entries = frappe.get_all(
        "Scouting Entry",
        filters=[["date_of_capture", "between", [from_date, to_date]]],
        fields=[
            "name",
            "scouts_name",
            "greenhouse",
            "bed",
            "zone",
            "block",
            "`row`",
            "tree",
            "crop_scouted",
            "time_of_capture",
            "date_of_capture",
            "owner",
            "modified_by",
            "modified",
            "latitude",
            "longitude",
        ],
        order_by="date_of_capture desc, time_of_capture desc",
        limit_page_length=0,
    )
    if not scouting_entries:
        return []

    entry_names = [e["name"] for e in scouting_entries]
    entries_dict = {e["name"]: e for e in scouting_entries}

    pests = frappe.get_all(
        "Pests Scouting Entry",
        filters=[["parent", "in", entry_names]],
        fields=["parent", "plant_section", "pest", "stage", "count"],
        limit_page_length=0,
    )
    diseases = frappe.get_all(
        "Diseases Scouting Entry",
        filters=[["parent", "in", entry_names]],
        fields=["parent", "disease", "plant_section", "stage"],
        limit_page_length=0,
    )
    traps = frappe.get_all(
        "Trap Scouting Entry",
        filters=[["parent", "in", entry_names]],
        fields=["parent", "trap", "pest", "location", "count"],
        limit_page_length=0,
    )

    for p in pests:
        parent = p.pop("parent", None)
        if parent in entries_dict:
            entries_dict[parent].setdefault("pests", []).append(p)
    for d in diseases:
        parent = d.pop("parent", None)
        if parent in entries_dict:
            entries_dict[parent].setdefault("diseases", []).append(d)
    for t in traps:
        parent = t.pop("parent", None)
        if parent in entries_dict:
            entries_dict[parent].setdefault("traps", []).append(t)

    return list(entries_dict.values())


@frappe.whitelist()
def getCompleteScoutingEntries(from_date=None, to_date=None, greenhouse=None):
    try:
        from_date = from_date or frappe.form_dict.get("from_date")
        to_date = to_date or frappe.form_dict.get("to_date")
        greenhouse_filter = greenhouse or frappe.form_dict.get("greenhouse")

        if not from_date or not to_date:
            frappe.throw("from_date and to_date are required")

        return _fetch_scouting_payload(from_date, to_date, greenhouse_filter, include_meta=True)
    except Exception as e:
        frappe.log_error(f"Error in scouting data extraction: {str(e)}", "Scouting Entry API")
        frappe.throw(str(e))


@frappe.whitelist()
def getScoutingEntriesChunk(from_date=None, to_date=None, greenhouse=None, include_meta=0):
    """Lean monthly-chunk endpoint for the scouting dashboard.

    When include_meta is falsy, skips pest_colors/disease_colors/zones_by_greenhouse
    so background chunks don't re-ship shared metadata that the client fetched once.
    """
    try:
        from_date = from_date or frappe.form_dict.get("from_date")
        to_date = to_date or frappe.form_dict.get("to_date")
        greenhouse_filter = greenhouse or frappe.form_dict.get("greenhouse")
        include_meta_flag = str(include_meta).lower() in ("1", "true", "yes")

        if not from_date or not to_date:
            frappe.throw("from_date and to_date are required")

        return _fetch_scouting_payload(
            from_date,
            to_date,
            greenhouse_filter,
            include_meta=include_meta_flag,
        )
    except Exception as e:
        frappe.log_error(f"Error in scouting chunk extraction: {str(e)}", "Scouting Entry API")
        frappe.throw(str(e))


@frappe.whitelist()
def get_entries_since(since=None, greenhouse=None, farm=None, limit=2000):
    """Delta endpoint: rows whose ``modified`` is strictly greater than ``since``.

    Used by the IndexedDB client to advance its watermark without re-shipping
    a full month. Bypasses the L1 payload cache (which is keyed by month);
    the row count is bounded by ``limit`` and the caller is expected to keep
    calling until ``has_more`` is false.

    Response:
        {
            server_now: ISO ts (advance the client watermark to this),
            entries:    [normalized entries],
            has_more:   bool — true if the limit was hit,
            since:      echo of the input,
        }
    """
    from datetime import datetime

    since = since or frappe.form_dict.get("since")
    greenhouse_filter = greenhouse or frappe.form_dict.get("greenhouse")
    farm_filter = farm or frappe.form_dict.get("farm")
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        limit = 2000
    limit = max(1, min(limit, 10000))

    if not since:
        # Sentinel so the first sync grabs everything from the rolling window.
        from datetime import date, timedelta

        since = (date.today() - timedelta(days=CACHE_WINDOW_DAYS)).isoformat() + " 00:00:00"

    server_now = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")

    base_filters = [["modified", ">", since]]
    or_filters = None
    if greenhouse_filter:
        or_filters = [
            ["greenhouse", "=", greenhouse_filter],
            ["block", "=", greenhouse_filter],
        ]

    entries = frappe.get_all(
        "Scouting Entry",
        filters=base_filters,
        or_filters=or_filters,
        fields=[
            "name",
            "scouts_name",
            "greenhouse",
            "bed",
            "zone",
            "block",
            "`row`",
            "tree",
            "crop_scouted",
            "time_of_capture",
            "date_of_capture",
            "owner",
            "modified_by",
            "modified",
            "latitude",
            "longitude",
        ],
        order_by="modified asc",
        limit_page_length=limit + 1,
    )

    has_more = len(entries) > limit
    if has_more:
        entries = entries[:limit]

    if farm_filter and entries:
        from upande_scp.serverscripts.scouting import scouting_metrics

        farms_map = scouting_metrics.get_farms_and_warehouses() or {}
        allowed = set(farms_map.get(farm_filter, []) or [])
        entries = [
            e for e in entries
            if (e.get("greenhouse") in allowed) or (e.get("block") in allowed)
        ]

    if entries:
        entry_names = [e["name"] for e in entries]
        entries_dict = {e["name"]: e for e in entries}
        pests = frappe.get_all(
            "Pests Scouting Entry",
            filters=[["parent", "in", entry_names]],
            fields=["parent", "plant_section", "pest", "stage", "count"],
            limit_page_length=0,
        )
        diseases = frappe.get_all(
            "Diseases Scouting Entry",
            filters=[["parent", "in", entry_names]],
            fields=["parent", "disease", "plant_section", "stage"],
            limit_page_length=0,
        )
        traps = frappe.get_all(
            "Trap Scouting Entry",
            filters=[["parent", "in", entry_names]],
            fields=["parent", "trap", "pest", "location", "count"],
            limit_page_length=0,
        )
        for p in pests:
            parent = p.pop("parent", None)
            if parent in entries_dict:
                entries_dict[parent].setdefault("pests", []).append(p)
        for d in diseases:
            parent = d.pop("parent", None)
            if parent in entries_dict:
                entries_dict[parent].setdefault("diseases", []).append(d)
        for t in traps:
            parent = t.pop("parent", None)
            if parent in entries_dict:
                entries_dict[parent].setdefault("traps", []).append(t)
        entries = list(entries_dict.values())

    return {
        "server_now": server_now,
        "since": since,
        "entries": entries,
        "has_more": has_more,
    }
