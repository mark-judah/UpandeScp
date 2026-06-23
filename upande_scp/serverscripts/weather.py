"""Per-farm weather forecast.

Pulls a 5-day outlook from Open-Meteo (https://open-meteo.com — free,
no API key, terms-of-use friendly for small commercial use). Cached per
farm for 30 minutes so a Dashboard refresh doesn't hammer the upstream
on every reload.

Coordinates source: ``Farm Map Coordinate`` child of ``Map Settings``,
the same table the heatmap pages already use to centre their
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
