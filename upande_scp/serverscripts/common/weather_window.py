"""Spray-window weather for a spray plan.

The daily forecast in ``weather.py`` answers "what is tomorrow like". Whether a
spray goes well depends on the few hours it is applied in, so this answers it
for the plan's SPRAY WINDOW: the planned time to planned time + N hours (4 by
default: 06:00 to 10:00 on the planned day). It reads Open-Meteo's hourly
series (temperature, relative humidity, dew point, rain, rain probability, wind
and gusts), one request per farm and day, cached.

Flags (rain, wind, humidity, a small temperature-dew point spread) are
WARNINGS only: they never stop a plan. Their thresholds are in SCP Weather
Settings.

Dates outside the forecast: beyond ~16 days ahead the answer is "forecast not
available yet"; a past window is read from the archive API when it is older
than the forecast host serves, else "n/a".

The window is also written onto the Work Order (``custom_weather_snapshot``) at
submit, so the forecast the approver was shown is not lost once the day passes.
"""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta

import frappe
import requests

from upande_scp.serverscripts.common import weather as _w

_ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
_HOURLY_VARS = (
    "temperature_2m,relative_humidity_2m,dew_point_2m,precipitation,"
    "precipitation_probability,wind_speed_10m,wind_gusts_10m"
)
_HORIZON_DAYS = 15          # the forecast host serves up to 16 days; keep one back
_FORECAST_PAST_DAYS = 90    # and ~92 days of history; the archive covers older
_TTL_FUTURE = 30 * 60
_TTL_PAST = 6 * 60 * 60

DEFAULTS = {
    "spray_window_hours": 4,
    "rain_prob_warn": 40,
    "rain_mm_warn": 0.5,
    "wind_warn_kmh": 15.0,
    "gust_warn_kmh": 25.0,
    "humidity_warn_pct": 85,
    "dew_spread_warn_c": 2.0,
}


def get_settings() -> dict:
    """SCP Weather Settings with defaults filled; defaults alone if the doctype
    is not migrated yet (a site mid-update must not lose its weather)."""
    out = dict(DEFAULTS)
    try:
        doc = frappe.get_cached_doc("SCP Weather Settings")
    except Exception:
        return out
    for k, dflt in DEFAULTS.items():
        v = doc.get(k)
        if v not in (None, ""):
            try:
                out[k] = type(dflt)(v)
            except (TypeError, ValueError):
                pass
    if out["spray_window_hours"] < 1:
        out["spray_window_hours"] = DEFAULTS["spray_window_hours"]
    return out


# ── fetching ────────────────────────────────────────────────────────────────


def _fetch_hourly(lat: float, lon: float, day: date) -> list[dict]:
    """The 24 hourly rows of ``day`` (location-local clock), or ``[]``."""
    url = _w._OPEN_METEO_URL
    hourly = _HOURLY_VARS
    if (date.today() - day).days > _FORECAST_PAST_DAYS:
        url = _ARCHIVE_URL
        hourly = hourly.replace("precipitation_probability,", "")  # not archived
    params = {
        "latitude": lat, "longitude": lon, "hourly": hourly, "timezone": "auto",
        "start_date": day.isoformat(), "end_date": day.isoformat(),
    }
    resp = requests.get(url, params=params, timeout=_w._REQUEST_TIMEOUT)
    resp.raise_for_status()
    h = (resp.json().get("hourly")) or {}
    rows = []
    for i, t in enumerate(h.get("time") or []):
        rows.append({
            "time": t,
            "temp": _w._safe_float(h.get("temperature_2m"), i),
            "rh": _w._safe_float(h.get("relative_humidity_2m"), i),
            "dew": _w._safe_float(h.get("dew_point_2m"), i),
            "mm": _w._safe_float(h.get("precipitation"), i),
            "prob": _w._safe_float(h.get("precipitation_probability"), i),
            "wind": _w._safe_float(h.get("wind_speed_10m"), i),
            "gust": _w._safe_float(h.get("wind_gusts_10m"), i),
        })
    return rows


def hourly_for(farm: str, day: date) -> list[dict] | None:
    """Hourly rows of one farm-day, cached. ``None`` = could not be fetched
    (no coordinates / outage); ``[]`` is never cached as success."""
    key = f"scp:wx_hourly:{farm}:{day.isoformat()}"
    cache = frappe.cache()
    hit = cache.get_value(key, expires=True)
    if hit is not None:
        return hit
    coords = _w._farm_coords(farm)
    if not coords:
        return None
    try:
        rows = _fetch_hourly(coords[0], coords[1], day)
    except Exception:
        frappe.log_error(title="open-meteo hourly fetch failed")
        return None
    if not rows:
        return None
    ttl = _TTL_PAST if day < date.today() else _TTL_FUTURE
    cache.set_value(key, rows, expires_in_sec=ttl)
    return rows


# ── the window ──────────────────────────────────────────────────────────────


def _to_dt(value) -> datetime | None:
    if isinstance(value, datetime):
        return value.replace(tzinfo=None)
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, 6, 0)
    if not value:
        return None
    s = str(value).strip()
    try:
        d = frappe.utils.get_datetime(s)
    except Exception:
        return None
    if len(s) <= 10:
        d = d.replace(hour=6)   # a date alone: the usual morning spray start
    return d.replace(tzinfo=None)


def _vals(rows, k):
    return [r[k] for r in rows if r.get(k) is not None]


def summarize(rows: list[dict], start: datetime, hours: int, cfg: dict | None = None) -> dict:
    """Pure: figures and warn flags for the rows inside [start, start+hours)."""
    cfg = cfg or DEFAULTS
    end = start + timedelta(hours=hours)
    inside = []
    for r in rows:
        try:
            t = datetime.fromisoformat(r["time"])
        except (KeyError, ValueError):
            continue
        # An hourly row stands for the hour that begins at its time.
        if start <= t < end:
            inside.append(r)
    if not inside:
        return {"status": "unavailable", "reason": "no_data"}
    temps, rhs, probs = _vals(inside, "temp"), _vals(inside, "rh"), _vals(inside, "prob")
    spreads = [r["temp"] - r["dew"] for r in inside if r.get("temp") is not None and r.get("dew") is not None]
    r1 = lambda x: None if x is None else round(x, 1)
    out = {
        "status": "ok",
        "window": {"start": start.strftime("%Y-%m-%d %H:%M"), "end": end.strftime("%Y-%m-%d %H:%M"), "hours": hours},
        "tempMin": r1(min(temps)) if temps else None,
        "tempMax": r1(max(temps)) if temps else None,
        "tempAvg": r1(sum(temps) / len(temps)) if temps else None,
        "humidityAvg": r1(sum(rhs) / len(rhs)) if rhs else None,
        "humidityMax": r1(max(rhs)) if rhs else None,
        "precipMm": r1(sum(_vals(inside, "mm"))) if _vals(inside, "mm") else None,
        "precipProb": int(max(probs)) if probs else None,
        "windMax": r1(max(_vals(inside, "wind"))) if _vals(inside, "wind") else None,
        "gustMax": r1(max(_vals(inside, "gust"))) if _vals(inside, "gust") else None,
        "dewSpreadMin": r1(min(spreads)) if spreads else None,
    }
    flags = []
    rain_hit = (out["precipProb"] is not None and out["precipProb"] >= cfg["rain_prob_warn"]) or (
        out["precipMm"] is not None and out["precipMm"] >= cfg["rain_mm_warn"])
    if rain_hit:
        flags.append({"kind": "rain", "text": "Rain likely in the spray window"})
    if (out["windMax"] is not None and out["windMax"] >= cfg["wind_warn_kmh"]) or (
            out["gustMax"] is not None and out["gustMax"] >= cfg["gust_warn_kmh"]):
        flags.append({"kind": "wind", "text": "Windy in the spray window (drift risk)"})
    if out["humidityMax"] is not None and out["humidityMax"] >= cfg["humidity_warn_pct"]:
        flags.append({"kind": "humidity", "text": "High humidity (slow drying, disease pressure)"})
    if out["dewSpreadMin"] is not None and out["dewSpreadMin"] <= cfg["dew_spread_warn_c"]:
        flags.append({"kind": "dew", "text": "Air near dew point (leaves stay wet)"})
    out["flags"] = flags
    return out


def window_weather(farm: str, start, hours: int | None = None) -> dict:
    """Weather for one farm's spray window starting at ``start``. Always returns
    a dict with ``status``: ``ok`` | ``unavailable`` (+ ``reason``)."""
    cfg = get_settings()
    hours = int(hours or cfg["spray_window_hours"])
    t0 = _to_dt(start)
    if not farm:
        return {"status": "unavailable", "reason": "no_farm"}
    if not t0:
        return {"status": "unavailable", "reason": "no_date"}
    today = date.today()
    if (t0.date() - today).days > _HORIZON_DAYS:
        return {"status": "unavailable", "reason": "beyond_horizon",
                "message": "Forecast not available yet"}
    # A window can run past midnight: take the following day as well.
    days = {t0.date(), (t0 + timedelta(hours=hours)).date()}
    rows: list[dict] = []
    for d in sorted(days):
        got = hourly_for(farm, d)
        if got is None:
            if d == t0.date():
                reason = "no_coordinates" if not _w._farm_coords(farm) else "fetch_failed"
                msg = "No weather location for this farm" if reason == "no_coordinates" else (
                    "Weather is not available right now" if t0.date() >= today else "n/a")
                return {"status": "unavailable", "reason": reason, "message": msg}
            continue
        rows += got
    out = summarize(rows, t0, hours, cfg)
    if out["status"] != "ok":
        out["message"] = "n/a"
    else:
        out["past"] = t0.date() < today
    return out


# ── endpoints ───────────────────────────────────────────────────────────────


@frappe.whitelist()
def get_window_weather(items) -> list[dict]:
    """``items``: JSON list of ``{key, farm, start[, wo]}``; returns the same list with
    a ``weather`` dict each. Plans of one farm and day share one cached fetch."""
    items = frappe.parse_json(items) if isinstance(items, str) else (items or [])
    out = []
    for it in items[:200]:
        farm = (it.get("farm") or "").strip()
        row = {"key": it.get("key"), "farm": farm, "weather": window_weather(farm, it.get("start"))}
        if it.get("wo"):
            # What was forecast when the plan was submitted (alongside the live one).
            raw = frappe.db.get_value("Work Order", it["wo"], "custom_weather_snapshot")
            snap = frappe.parse_json(raw) if raw else None
            row["snapshot"] = snap if isinstance(snap, dict) and snap.get("status") == "ok" else None
        out.append(row)
    return out


def _farm_of_plan(wo) -> str:
    gh = wo.get("custom_greenhouse")
    return (frappe.db.get_value("Warehouse", gh, "custom_farm") if gh else "") or wo.get("custom_farm") or ""


def snapshot_for(wo) -> dict | None:
    """The window forecast for a plan, in the shape stored on the Work Order."""
    start = wo.get("custom_scheduled_application_time") or wo.get("planned_start_date")
    farm = _farm_of_plan(wo)
    w = window_weather(farm, start)
    if w.get("status") != "ok":
        return {"status": "unavailable", "reason": w.get("reason"), "farm": farm,
                "taken_at": frappe.utils.now()}
    w["farm"] = farm
    w["taken_at"] = frappe.utils.now()
    w["source"] = "Open-Meteo"
    return w


def stamp_snapshot(doc, method=None) -> None:
    """``Work Order`` before_submit: record the spray-window weather as it was
    forecast when the plan was submitted. Never blocks a submit."""
    try:
        if doc.get("custom_type") != "Application Floor Plan":
            return
        snap = snapshot_for(doc)
        if snap:
            doc.custom_weather_snapshot = json.dumps(snap)
    except Exception:
        frappe.log_error(frappe.get_traceback(), "weather snapshot at submit")
