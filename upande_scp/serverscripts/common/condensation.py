"""Condensation risk (downy mildew) from greenhouse sensors.

Downy mildew needs leaf wetness; air that sits within a couple of degrees of
its dew point makes leaves wet. The humidity sensors report relative humidity
and temperature separately, so the dew point is computed here (Magnus formula)
from each sensor's paired readings.

The ``upande_sensors`` app (doctypes ``Sensor``, ``Sensor Reading``) is not
installed on every site, so every read is guarded by a table-existence check
and the hourly job is a no-op without it.

SENSOR -> GREENHOUSE.  Sensors carry only GPS, no greenhouse. ``map_sensors``
places each on the greenhouse outline (``Warehouse.custom_raw_geojson``, a
GeoJSON polygon; the Zone polygons stand in for a house with no outline of its
own): inside an outline wins, else the nearest outline within
``sensor_nearest_m`` metres, else it stays unmapped. The result is stored on
**Sensor Greenhouse Map** (one row per deveui). A row with Source = Manual is
the GM's decision and is never overwritten.

RULE.  Per greenhouse, per 30-minute slot, the mean of its sensors' (temperature
minus dew point). A run of slots at or under the spread limit lasting the
configured hours raises ONE **Condensation Alert** per greenhouse per day,
which notifies that farm's scouts and managers.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta

import frappe

SENSOR = "Sensor"
READING = "Sensor Reading"
MAP = "Sensor Greenhouse Map"
ALERT = "Condensation Alert"

SLOT_MIN = 30
_B, _C = 17.62, 243.12          # Magnus constants (water, -45..60 C)

DEFAULTS = {
    "condensation_alerts_enabled": 1,
    "condensation_spread_c": 2.0,
    "condensation_hours": 2.0,
    "condensation_lookback_hours": 12,
    "sensor_nearest_m": 40,
    "sensor_pair_minutes": 15,
}


def get_settings() -> dict:
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
    return out


def sensors_available() -> bool:
    return bool(frappe.db.table_exists(SENSOR) and frappe.db.table_exists(READING))


# ── pure maths ──────────────────────────────────────────────────────────────


def dew_point(temp_c: float, rh: float) -> float | None:
    """Magnus dew point in C; ``None`` for a humidity outside (0, 100]."""
    try:
        t, h = float(temp_c), float(rh)
    except (TypeError, ValueError):
        return None
    if h <= 0 or h > 100.5:
        return None
    h = min(h, 100.0)
    g = math.log(h / 100.0) + _B * t / (_C + t)
    return _C * g / (_B - g)


def pair_readings(temps: list, hums: list, max_gap_min: int = 15) -> list[tuple]:
    """``[(timestamp, temp, rh)]``: each humidity reading with the nearest
    temperature reading of the SAME sensor inside ``max_gap_min`` minutes.
    ``temps``/``hums`` are ``(datetime, value)`` lists."""
    temps = sorted(temps)
    out = []
    gap = timedelta(minutes=max_gap_min)
    j = 0
    for ts, rh in sorted(hums):
        while j + 1 < len(temps) and abs(temps[j + 1][0] - ts) <= abs(temps[j][0] - ts):
            j += 1
        if temps and abs(temps[j][0] - ts) <= gap:
            out.append((ts, temps[j][1], rh))
    return out


def _slot(ts: datetime) -> datetime:
    return ts.replace(minute=(ts.minute // SLOT_MIN) * SLOT_MIN, second=0, microsecond=0)


def house_slots(sensor_pairs: dict) -> dict:
    """``{slot: {spread, rh, n}}`` for one greenhouse: the mean over its sensors
    (a single faulty sensor does not raise the house) of temp - dew point."""
    acc: dict = {}
    for pairs in sensor_pairs.values():
        per_sensor: dict = {}
        for ts, t, rh in pairs:
            dp = dew_point(t, rh)
            if dp is None:
                continue
            per_sensor.setdefault(_slot(ts), []).append((t - dp, rh))
        for slot, vals in per_sensor.items():
            a = acc.setdefault(slot, [])
            a.append((sum(v[0] for v in vals) / len(vals), max(v[1] for v in vals)))
    return {
        s: {"spread": sum(v[0] for v in vals) / len(vals), "rh": max(v[1] for v in vals), "n": len(vals)}
        for s, vals in acc.items()
    }


def risk_runs(slots: dict, spread_c: float, hours: float) -> list[dict]:
    """Runs of consecutive slots at or under ``spread_c`` lasting >= ``hours``."""
    step = timedelta(minutes=SLOT_MIN)
    ok = sorted(s for s, v in slots.items() if v["spread"] <= spread_c)
    runs, cur = [], []
    for s in ok:
        if cur and s - cur[-1] > step:
            runs.append(cur)
            cur = []
        cur.append(s)
    if cur:
        runs.append(cur)
    out = []
    for r in runs:
        dur = (r[-1] - r[0]) + step
        if dur >= timedelta(hours=hours):
            out.append({
                "start": r[0], "end": r[-1] + step, "hours": round(dur.total_seconds() / 3600, 2),
                "min_spread": round(min(slots[s]["spread"] for s in r), 2),
                "max_rh": round(max(slots[s]["rh"] for s in r), 1),
                "sensors": max(slots[s]["n"] for s in r),
            })
    return out


# ── geometry ────────────────────────────────────────────────────────────────


def _rings(geojson) -> list[list[list[tuple]]]:
    """Polygons as ``[outer, hole, ...]`` rings of ``(lon, lat)`` from any
    GeoJSON (FeatureCollection / Feature / Polygon / MultiPolygon)."""
    if isinstance(geojson, str):
        try:
            geojson = json.loads(geojson)
        except ValueError:
            return []
    polys: list = []

    def walk(g):
        if not isinstance(g, dict):
            return
        t = g.get("type")
        if t == "FeatureCollection":
            for f in g.get("features") or []:
                walk(f)
        elif t == "Feature":
            walk(g.get("geometry"))
        elif t == "Polygon":
            polys.append([[(float(p[0]), float(p[1])) for p in ring] for ring in g.get("coordinates") or []])
        elif t == "MultiPolygon":
            for poly in g.get("coordinates") or []:
                polys.append([[(float(p[0]), float(p[1])) for p in ring] for ring in poly])
        elif t == "GeometryCollection":
            for x in g.get("geometries") or []:
                walk(x)

    try:
        walk(geojson)
    except (TypeError, ValueError, IndexError):
        return []
    return [p for p in polys if p and len(p[0]) >= 3]


def _in_ring(lon, lat, ring) -> bool:
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        if (y1 > lat) != (y2 > lat) and lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def in_polygon(lon, lat, poly) -> bool:
    return _in_ring(lon, lat, poly[0]) and not any(_in_ring(lon, lat, h) for h in poly[1:])


def _dist_m(lon, lat, poly) -> float:
    """Metres from the point to the polygon's outer edge (local flat-earth)."""
    k_lat = 111320.0
    k_lon = 111320.0 * math.cos(math.radians(lat))
    px, py = 0.0, 0.0
    best = float("inf")
    ring = poly[0]
    for i in range(len(ring)):
        x1, y1 = (ring[i][0] - lon) * k_lon, (ring[i][1] - lat) * k_lat
        x2, y2 = (ring[(i + 1) % len(ring)][0] - lon) * k_lon, (ring[(i + 1) % len(ring)][1] - lat) * k_lat
        dx, dy = x2 - x1, y2 - y1
        seg = dx * dx + dy * dy
        t = 0.0 if seg == 0 else max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / seg))
        best = min(best, math.hypot(x1 + t * dx - px, y1 + t * dy - py))
    return best


def _area(poly) -> float:
    r = poly[0]
    return abs(sum(r[i][0] * r[(i + 1) % len(r)][1] - r[(i + 1) % len(r)][0] * r[i][1] for i in range(len(r)))) / 2


def locate(lon, lat, houses: dict, nearest_m: float) -> dict:
    """Place a point. ``houses`` is ``{name: [polygon, ...]}``. Returns
    ``{greenhouse, method: inside|nearest|none, distance_m}``. Inside several
    outlines (nested/overlapping): the smallest one."""
    inside = []
    for name, polys in houses.items():
        for p in polys:
            if in_polygon(lon, lat, p):
                inside.append((_area(p), name))
    if inside:
        return {"greenhouse": min(inside)[1], "method": "inside", "distance_m": 0.0}
    best = (float("inf"), None)
    for name, polys in houses.items():
        for p in polys:
            d = _dist_m(lon, lat, p)
            if d < best[0]:
                best = (d, name)
    if best[1] and best[0] <= nearest_m:
        return {"greenhouse": best[1], "method": "nearest", "distance_m": round(best[0], 1)}
    return {"greenhouse": None, "method": "none", "distance_m": round(best[0], 1) if best[1] else None}


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None


# ── sensor -> greenhouse map ────────────────────────────────────────────────


def greenhouse_outlines() -> dict:
    """``{warehouse: [polygon, ...]}`` for every farm warehouse with an outline;
    Zone polygons for a house that has none of its own."""
    out: dict = {}
    for r in frappe.get_all(
        "Warehouse", filters={"custom_raw_geojson": ["is", "set"], "custom_farm": ["is", "set"]},
        fields=["name", "custom_raw_geojson"], limit_page_length=0,
    ):
        polys = _rings(r.custom_raw_geojson)
        if polys:
            out[r.name] = polys
    if frappe.db.table_exists("Zone"):
        farmed = set(frappe.get_all("Warehouse", filters={"custom_farm": ["is", "set"]}, pluck="name", limit_page_length=0))
        zoned: dict = {}
        for z in frappe.get_all("Zone", filters={"geojson": ["is", "set"]}, fields=["greenhouse", "geojson"], limit_page_length=0):
            if z.greenhouse in farmed and z.greenhouse not in out:
                zoned.setdefault(z.greenhouse, []).extend(_rings(z.geojson))
        out.update({k: v for k, v in zoned.items() if v})
    return out


def map_sensors(nearest_m: float | None = None) -> dict:
    """Place every Sensor on a greenhouse and store it on Sensor Greenhouse Map.
    Manual rows are kept. Returns counts."""
    counts = {"inside": 0, "nearest": 0, "none": 0, "manual": 0, "no_gps": 0}
    if not sensors_available():
        return counts
    nearest_m = get_settings()["sensor_nearest_m"] if nearest_m is None else nearest_m
    houses = greenhouse_outlines()
    cols = {c.lower() for c in frappe.db.get_table_columns(SENSOR)}
    fields = ["deveui", "latitude", "longitude"] + (["sensor_site"] if "sensor_site" in cols else [])
    for s in frappe.get_all(SENSOR, fields=fields, limit_page_length=0):
        if not s.deveui:
            continue
        existing = frappe.db.get_value(MAP, s.deveui, ["source"], as_dict=True) if frappe.db.exists(MAP, s.deveui) else None
        if existing and existing.source == "Manual":
            counts["manual"] += 1
            continue
        lat, lon = _num(s.latitude), _num(s.longitude)
        if lat is None or lon is None:
            counts["no_gps"] += 1
            placed = {"greenhouse": None, "method": "no GPS", "distance_m": None}
        else:
            placed = locate(lon, lat, houses, nearest_m)
            counts[placed["method"]] += 1
        vals = {
            "greenhouse": placed["greenhouse"], "source": "Auto", "method": placed["method"],
            "distance_m": placed["distance_m"], "latitude": lat, "longitude": lon,
            "sensor_site": s.get("sensor_site"),
        }
        if existing:
            frappe.db.set_value(MAP, s.deveui, vals, update_modified=False)
        else:
            frappe.get_doc({"doctype": MAP, "deveui": s.deveui, **vals}).insert(ignore_permissions=True)
    return counts


@frappe.whitelist()
def remap_sensors() -> dict:
    """GM action: re-run the automatic GPS placement (Manual rows are kept)."""
    frappe.only_for(("SCP General Manager", "System Manager"))
    out = map_sensors()
    frappe.db.commit()
    return out


# ── readings -> alerts ──────────────────────────────────────────────────────


def _load_readings(deveuis: list, since: datetime) -> list[tuple]:
    """``[(deveui, 'Temperature'|'Humidity', datetime, value)]``. One seam for tests."""
    rows = frappe.db.sql(
        f"""SELECT deveui, sensor_type, `timestamp` AS ts, `value` AS v FROM `tab{READING}`
            WHERE `timestamp` >= %s AND sensor_type IN ('Temperature', 'Humidity') AND deveui IN %s""",
        (since, tuple(deveuis)), as_dict=True,
    )
    return [(r.deveui, r.sensor_type, frappe.utils.get_datetime(r.ts), _num(r.v)) for r in rows if _num(r.v) is not None]


def _cold_room_sensors() -> set:
    cols = {c.lower() for c in frappe.db.get_table_columns(SENSOR)}
    if "track_in_cold_room" not in cols:
        return set()
    return set(frappe.get_all(SENSOR, filters={"track_in_cold_room": 1}, pluck="deveui", limit_page_length=0))


def evaluate_houses(now: datetime | None = None, cfg: dict | None = None) -> dict:
    """``{greenhouse: [runs]}`` for every mapped greenhouse meeting the rule."""
    cfg = cfg or get_settings()
    now = now or frappe.utils.now_datetime()
    mapping = {
        r.deveui: r.greenhouse
        for r in frappe.get_all(MAP, filters={"greenhouse": ["is", "set"]}, fields=["deveui", "greenhouse"], limit_page_length=0)
    }
    for d in _cold_room_sensors():
        mapping.pop(d, None)
    if not mapping:
        return {}
    since = now - timedelta(hours=int(cfg["condensation_lookback_hours"]))
    per: dict = {}
    for dev, kind, ts, v in _load_readings(list(mapping), since):
        per.setdefault(dev, {"Temperature": [], "Humidity": []})[kind].append((ts, v))
    by_house: dict = {}
    for dev, kinds in per.items():
        pairs = pair_readings(kinds["Temperature"], kinds["Humidity"], int(cfg["sensor_pair_minutes"]))
        if pairs:
            by_house.setdefault(mapping[dev], {})[dev] = pairs
    out = {}
    for house, sp in by_house.items():
        runs = risk_runs(house_slots(sp), float(cfg["condensation_spread_c"]), float(cfg["condensation_hours"]))
        if runs:
            out[house] = runs
    return out


# ── notice ──────────────────────────────────────────────────────────────────

SUBJECT = "Condensation risk - scout for downy mildew"


def scout_users(company) -> list[str]:
    """Enabled users of the company's Employees who hold a scout role."""
    if not company:
        return []
    users = frappe.get_all("Employee", filters={"company": company, "status": "Active", "user_id": ["is", "set"]},
                           pluck="user_id", limit_page_length=0)
    if not users:
        return []
    have = set(frappe.get_all("Has Role", filters={"parenttype": "User", "parent": ["in", users],
                                                    "role": ["in", ["SCP Scout", "Scout"]]},
                              pluck="parent", limit_page_length=0))
    return [u for u in users if u in have and u not in ("Administrator", "Guest")]


def _notify(alert, farm: str, house: str, run: dict) -> list[str]:
    from upande_scp.serverscripts.reports.report_sender import report_sender
    from upande_scp.serverscripts.scouting.cumulative_per_ha import recipients_for_farm

    company = frappe.db.get_value("Farm", farm, "company") if farm else None
    emails = recipients_for_farm(farm, company)
    short = house.rsplit(" - ", 1)[0]
    body = (
        f"{short} has sat within {alert.min_spread:.1f} C of its dew point for "
        f"{run['hours']:.1f} hours ({run['start']:%H:%M} to {run['end']:%H:%M}), "
        f"humidity up to {run['max_rh']:.0f}%. Leaves stay wet in these conditions: "
        "scout for downy mildew in this house."
    )
    # In-app notice to the farm's scouts and managers.
    in_app = set(scout_users(company))
    in_app.update(e for e in emails if frappe.db.exists("User", e))
    for u in sorted(in_app):
        try:
            frappe.get_doc({
                "doctype": "Notification Log", "for_user": u, "type": "Alert", "subject": f"{SUBJECT}: {short}",
                "email_content": body, "document_type": ALERT, "document_name": alert.name,
            }).insert(ignore_permissions=True)
        except Exception:
            frappe.log_error(frappe.get_traceback(), "condensation notice")
    if emails:
        try:
            frappe.sendmail(recipients=emails, subject=f"{SUBJECT}: {short}", message=f"<p>{body}</p>",
                            reference_doctype=ALERT, reference_name=alert.name,
                            sender=report_sender(company))
        except Exception:
            frappe.log_error(frappe.get_traceback(), "condensation email")
    return sorted(in_app | set(emails))


def raise_alerts(now: datetime | None = None) -> list[str]:
    """One Condensation Alert per greenhouse per day. Returns new alert names."""
    cfg = get_settings()
    if not int(cfg["condensation_alerts_enabled"]) or not sensors_available():
        return []
    made = []
    for house, runs in evaluate_houses(now, cfg).items():
        run = max(runs, key=lambda r: r["end"])
        farm = frappe.db.get_value("Warehouse", house, "custom_farm")
        doc = frappe.get_doc({
            "doctype": ALERT, "greenhouse": house, "farm": farm, "alert_date": run["end"].date(),
            "hours": run["hours"], "min_spread": run["min_spread"], "max_humidity": run["max_rh"],
            "sensors": run["sensors"], "first_seen": run["start"], "last_seen": run["end"],
        })
        try:
            doc.insert(ignore_permissions=True)
        except frappe.DuplicateEntryError:
            continue        # already raised for this house today
        who = _notify(doc, farm, house, run)
        frappe.db.set_value(ALERT, doc.name, {"recipients": ", ".join(who), "emailed_at": frappe.utils.now_datetime()},
                            update_modified=False)
        made.append(doc.name)
    frappe.db.commit()
    return made


def hourly() -> None:
    """Scheduler (hourly): refresh the sensor map for new sensors, then check."""
    if not sensors_available():
        return
    try:
        map_sensors()
    except Exception:
        frappe.log_error(frappe.get_traceback(), "condensation: map sensors")
    raise_alerts()


@frappe.whitelist()
def get_condensation_alerts(farms=None, days: int = 1) -> list[dict]:
    """Recent alerts for the in-app card, newest first, optionally for some farms."""
    if not frappe.db.table_exists(ALERT):
        return []
    farms = frappe.parse_json(farms) if isinstance(farms, str) and farms.startswith("[") else farms
    if isinstance(farms, str):
        farms = [f for f in farms.split(",") if f.strip()]
    filters = {"alert_date": [">=", frappe.utils.add_days(frappe.utils.nowdate(), -(int(days) - 1))]}
    if farms:
        filters["farm"] = ["in", list(farms)]
    return frappe.get_list(
        ALERT, filters=filters, order_by="last_seen desc", limit_page_length=100,
        fields=["name", "greenhouse", "farm", "alert_date", "hours", "min_spread", "max_humidity", "first_seen", "last_seen"],
    )
