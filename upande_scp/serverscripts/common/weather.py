"""Per-farm weather forecast.

Pulls a 5-day outlook from Open-Meteo (https://open-meteo.com — free,
no API key, terms-of-use friendly for small commercial use). Cached per
farm for 30 minutes so a Dashboard refresh doesn't hammer the upstream
on every reload.

Coordinates source: ``Farm Map Coordinate`` child of ``Map Settings``,
the same table the avocado/heatmap pages already use to centre their
maps. If the farm has no coordinate row we return an empty payload —
the UI hides the card rather than guessing.
"""

import frappe
import requests


_OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
_TTL_SECONDS = 30 * 60  # 30 minutes — forecasts update hourly upstream
_REQUEST_TIMEOUT = 8     # seconds; never let weather block the UI for long


def _cache_key(farm: str) -> str:
    return f"scp:weather:{farm}"


def _farm_coords(farm: str) -> tuple | None:
    row = frappe.db.get_value(
        "Farm Map Coordinate",
        {"parent": "Map Settings", "farm": farm},
        ["lat", "lon"],
        as_dict=True,
    )
    if not row:
        return None
    try:
        return float(row["lat"]), float(row["lon"])
    except (TypeError, ValueError):
        return None


def _fetch_forecast(lat: float, lon: float) -> dict:
    """Call Open-Meteo for a 5-day daily forecast at the given coords."""
    params = {
        "latitude": lat,
        "longitude": lon,
        "daily": ",".join([
            "temperature_2m_max",
            "temperature_2m_min",
            "precipitation_sum",
            "precipitation_probability_max",
            "weathercode",
            "windspeed_10m_max",
        ]),
        "timezone": "auto",
        "forecast_days": 5,
    }
    resp = requests.get(_OPEN_METEO_URL, params=params, timeout=_REQUEST_TIMEOUT)
    resp.raise_for_status()
    data = resp.json()
    d = data.get("daily") or {}
    days = []
    times = d.get("time") or []
    for i, date in enumerate(times):
        days.append({
            "date":           date,
            "tempMax":        _safe_float(d.get("temperature_2m_max"), i),
            "tempMin":        _safe_float(d.get("temperature_2m_min"), i),
            "precipMm":       _safe_float(d.get("precipitation_sum"), i),
            "precipProb":     _safe_int  (d.get("precipitation_probability_max"), i),
            "weatherCode":    _safe_int  (d.get("weathercode"), i),
            "windMax":        _safe_float(d.get("windspeed_10m_max"), i),
        })
    return {
        "units": {
            "temp":   data.get("daily_units", {}).get("temperature_2m_max", "°C"),
            "precip": data.get("daily_units", {}).get("precipitation_sum", "mm"),
            "wind":   data.get("daily_units", {}).get("windspeed_10m_max", "km/h"),
        },
        "timezone": data.get("timezone", ""),
        "days":     days,
    }


def _safe_float(arr, i):
    try:
        return float(arr[i])
    except (TypeError, ValueError, IndexError):
        return None


def _safe_int(arr, i):
    try:
        return int(arr[i])
    except (TypeError, ValueError, IndexError):
        return None


@frappe.whitelist()
def get_farm_weather(farm: str | None = None) -> dict:
    """Return ``{farm, lat, lon, units, timezone, days[]}`` or an empty
    payload (``days=[]``) if the farm has no coords or the upstream call
    failed. Never raises so the page render isn't blocked by an outage."""
    farm = (farm or "").strip()
    if not farm:
        return {"farm": "", "days": []}

    cache = frappe.cache()
    key = _cache_key(farm)
    cached = cache.get_value(key, expires=True)
    if cached is not None:
        return cached

    coords = _farm_coords(farm)
    if not coords:
        # Cache the empty result briefly too — saves a DB hit on rapid
        # farm-switches in the picker.
        payload = {"farm": farm, "days": []}
        cache.set_value(key, payload, expires_in_sec=300)
        return payload

    lat, lon = coords
    try:
        forecast = _fetch_forecast(lat, lon)
    except Exception:
        # Open-Meteo outage / network drop — log once, return empty so the
        # UI hides the card. Don't bubble: a weather widget should never
        # break the spray-planning flow.
        frappe.log_error(title="open-meteo fetch failed")
        return {"farm": farm, "lat": lat, "lon": lon, "days": []}

    payload = {"farm": farm, "lat": lat, "lon": lon, **forecast}
    cache.set_value(key, payload, expires_in_sec=_TTL_SECONDS)
    return payload


# ---------------------------------------------------------------------------
# Historical weekly weather — for correlating pest trend against conditions
# ---------------------------------------------------------------------------
# The forecast above answers "should we spray tomorrow". This answers a
# different question: did the weather in the weeks leading up to now explain
# the pest trend? That needs the PAST, aggregated to the same ISO weeks the
# scouting data is bucketed into, so the two can be read side by side.

_HISTORY_WEEKS = 5
# Open-Meteo's forecast endpoint serves recent history via `past_days` (max 92),
# which keeps this on the same host/params as the forecast call instead of
# introducing the separate archive API. 5 weeks + the current partial week.
_PAST_DAYS = _HISTORY_WEEKS * 7 + 7
_HISTORY_TTL = 6 * 60 * 60  # 6h — past weather doesn't change


def _history_cache_key(farm: str, frm: str = "", to: str = "") -> str:
    return f"scp:weather_hist_v2:{farm}:{frm}:{to}"


def _iso_week_label(date_str: str) -> str:
    """``2026-07-13`` → ``2026-W29``, matching the scouting/terrain buckets."""
    from datetime import datetime

    try:
        d = datetime.strptime(str(date_str)[:10], "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return ""
    iso = d.isocalendar()
    return f"{iso[0]:04d}-W{iso[1]:02d}"


def _fetch_history(lat: float, lon: float, frm: str = "", to: str = "") -> list:
    """Daily rows for an explicit date range, or the trailing default window.

    An explicit range matters because the weeks worth showing are the weeks the
    GREENHOUSE WAS SCOUTED, which may be well behind today — on this site the
    newest scouting is ~29 days old, so a "last 5 weeks from now" window barely
    overlaps the data it is meant to explain.

    Open-Meteo's forecast endpoint serves history back ~92 days. Older ranges
    would need the separate archive API; they return empty here rather than
    silently reporting the wrong dates.
    """
    params = {
        "latitude": lat,
        "longitude": lon,
        "daily": ",".join([
            "temperature_2m_max",
            "temperature_2m_min",
            "precipitation_sum",
            "relative_humidity_2m_mean",
            "windspeed_10m_max",
        ]),
        "timezone": "auto",
    }
    if frm and to:
        params["start_date"] = frm
        params["end_date"] = to
    else:
        params["past_days"] = _PAST_DAYS
        params["forecast_days"] = 1
    resp = requests.get(_OPEN_METEO_URL, params=params, timeout=_REQUEST_TIMEOUT)
    resp.raise_for_status()
    d = (resp.json().get("daily") or {})
    out = []
    for i, date in enumerate(d.get("time") or []):
        out.append({
            "date":     date,
            "tempMax":  _safe_float(d.get("temperature_2m_max"), i),
            "tempMin":  _safe_float(d.get("temperature_2m_min"), i),
            "precipMm": _safe_float(d.get("precipitation_sum"), i),
            "humidity": _safe_float(d.get("relative_humidity_2m_mean"), i),
            "windMax":  _safe_float(d.get("windspeed_10m_max"), i),
        })
    return out


def _weekly_from_daily(days: list) -> list:
    """Fold daily rows into ISO weeks.

    Rainfall SUMS (a week's total is the meaningful figure for pest pressure);
    temperature, humidity and wind AVERAGE. Each week also carries the change
    from the week before, which is what the 3D view highlights — "rain up 18mm
    on last week" is the readable signal, not the absolute total.
    """
    buckets: dict = {}
    for r in days:
        wk = _iso_week_label(r["date"])
        if not wk:
            continue
        b = buckets.setdefault(
            wk, {"week": wk, "precipMm": 0.0, "_t": [], "_h": [], "_w": [], "days": 0}
        )
        b["days"] += 1
        if r["precipMm"] is not None:
            b["precipMm"] += r["precipMm"]
        if r["tempMax"] is not None and r["tempMin"] is not None:
            b["_t"].append((r["tempMax"] + r["tempMin"]) / 2)
        if r["humidity"] is not None:
            b["_h"].append(r["humidity"])
        if r["windMax"] is not None:
            b["_w"].append(r["windMax"])

    def mean(xs):
        return round(sum(xs) / len(xs), 1) if xs else None

    weeks = []
    for wk in sorted(buckets):
        b = buckets[wk]
        weeks.append({
            "week":     wk,
            "precipMm": round(b["precipMm"], 1),
            "tempMean": mean(b["_t"]),
            "humidity": mean(b["_h"]),
            "windMean": mean(b["_w"]),
            "days":     b["days"],
            # A week with only a day or two of data (the range edges) would
            # otherwise read as a drought next to a full week.
            "partial":  b["days"] < 7,
        })

    # Week-on-week deltas, computed after sorting so "previous" is meaningful.
    for i, w in enumerate(weeks):
        prev = weeks[i - 1] if i else None
        w["precipDelta"] = (
            None if not prev else round(w["precipMm"] - prev["precipMm"], 1)
        )
        w["tempDelta"] = (
            None
            if not prev or w["tempMean"] is None or prev["tempMean"] is None
            else round(w["tempMean"] - prev["tempMean"], 1)
        )
        w["humidityDelta"] = (
            None
            if not prev or w["humidity"] is None or prev["humidity"] is None
            else round(w["humidity"] - prev["humidity"], 1)
        )
    return weeks


@frappe.whitelist()
def get_farm_weather_history(
    farm: str | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
) -> dict:
    """``{farm, weeks[]}`` — weekly weather for the farm, each week with totals,
    means and the change on the week before.

    Pass ``from_date``/``to_date`` to cover the period actually being looked at
    (the weeks a greenhouse was scouted). Without them it falls back to the
    trailing ~5 weeks from today, which is only right when the data is current.

    Never raises: an outage or a farm with no coordinates yields ``weeks: []``
    and the UI hides the panel.
    """
    farm = (farm or "").strip()
    frm = (from_date or "").strip()[:10]
    to = (to_date or "").strip()[:10]
    if not farm:
        return {"farm": "", "weeks": []}

    cache = frappe.cache()
    key = _history_cache_key(farm, frm, to)
    cached = cache.get_value(key, expires=True)
    if cached is not None:
        return cached

    coords = _farm_coords(farm)
    if not coords:
        payload = {"farm": farm, "weeks": []}
        cache.set_value(key, payload, expires_in_sec=300)
        return payload

    lat, lon = coords
    try:
        days = _fetch_history(lat, lon, frm, to)
    except Exception:
        frappe.log_error(title="open-meteo history fetch failed")
        return {"farm": farm, "lat": lat, "lon": lon, "weeks": []}

    weeks = _weekly_from_daily(days)
    if not (frm and to):
        # Trailing-window mode only: trim to the most recent N. With an explicit
        # range the caller already said which weeks it wants.
        weeks = weeks[-(_HISTORY_WEEKS + 1):]
    payload = {"farm": farm, "lat": lat, "lon": lon, "weeks": weeks}
    cache.set_value(key, payload, expires_in_sec=_HISTORY_TTL)
    return payload
