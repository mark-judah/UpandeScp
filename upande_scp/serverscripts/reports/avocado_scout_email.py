"""Weekly avocado scout coverage email, for the avocado team only.

For the ISO week just ended, one email per avocado farm: per scout the trees
scouted, entries, blocks, active days and distance walked, then the farm's
blocks that nobody scouted that week. A scout is listed only from
``MIN_ENTRIES`` entries in the week.

Who gets it (the avocado team): the people of the farms that grow avocado
(``Farm Filter`` rows of the Avocado crop) and nobody else. For each such farm,

* the company's roster ``recipients_for_farm`` already uses for the block
  alerts: active Employees of the farm's company, linked to a user, holding a
  spray plan creator, general manager or farm manager role (or the farm's own
  "Farm Manager <farm>" role); plus
* active Employees whose own ``custom_farm`` is that farm, when set (it is empty
  for most staff, so it only adds, never restricts).

A company that grows only roses is not included, because no avocado farm of it
exists. Distance walked comes from the GPS fixes of consecutive entries of a
scout on a day, in time order; a jump over ``MAX_JUMP_M`` between two fixes is a
GPS glitch or a lift between blocks and is not counted.
"""
from __future__ import annotations

import math
from collections import defaultdict
from datetime import timedelta

import frappe

from upande_scp.serverscripts.reports import spray_records_email as SR
from upande_scp.serverscripts.reports.report_sender import report_sender
from upande_scp.serverscripts.scouting import cumulative_per_ha as C

CROP = "Avocado"
MIN_ENTRIES = 20
MAX_JUMP_M = 500.0
MAX_ROWS = 60

INK, MUTED, RULE, BAD = SR.INK, SR.MUTED, SR.RULE, SR.BAD
TABLE, TH, THN, TD, TDN = SR.TABLE, SR.TH, SR.THN, SR.TD, SR.TDN


# ── pure ────────────────────────────────────────────────────────────────────


def haversine_m(lat1, lon1, lat2, lon2) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _fix(lat, lon):
    try:
        la, lo = float(lat), float(lon)
    except (TypeError, ValueError):
        return None
    if not la and not lo:
        return None
    return la, lo


def walked_m(fixes, max_jump=MAX_JUMP_M) -> float:
    """Distance over time-ordered ``(lat, lon)`` fixes; legs over ``max_jump`` are
    skipped, and a missing fix breaks the chain rather than bridging it."""
    total, prev = 0.0, None
    for f in fixes:
        if f is None:
            prev = None
            continue
        if prev is not None:
            d = haversine_m(prev[0], prev[1], f[0], f[1])
            if d <= max_jump:
                total += d
        prev = f
    return total


def scout_rows(entries, min_entries=MIN_ENTRIES) -> tuple[list, list]:
    """``(listed, below)`` from entry dicts (scout, day, time, block, tree, lat, lon).

    ``listed``: one dict per scout with at least ``min_entries``; ``below``: the
    scouts who had fewer (id and count only), so the email can say they exist.
    """
    by: dict = defaultdict(list)
    for e in entries:
        by[e["scout"] or ""].append(e)
    listed, below = [], []
    for scout, rows in by.items():
        if len(rows) < min_entries:
            below.append({"scout": scout, "entries": len(rows)})
            continue
        days: dict = defaultdict(list)
        for r in rows:
            days[r["day"]].append(r)
        metres = 0.0
        for day_rows in days.values():
            day_rows.sort(key=lambda r: (str(r["time"] or ""),))
            metres += walked_m([_fix(r["lat"], r["lon"]) for r in day_rows])
        listed.append({
            "scout": scout, "entries": len(rows),
            "trees": len({r["tree"] for r in rows if r["tree"]}),
            "blocks": len({r["block"] for r in rows if r["block"]}),
            "days": len(days), "km": round(metres / 1000.0, 2),
        })
    listed.sort(key=lambda r: (-r["entries"], r["scout"]))
    below.sort(key=lambda r: (-r["entries"], r["scout"]))
    return listed, below


# ── data ────────────────────────────────────────────────────────────────────


def avocado_farms() -> list:
    return sorted({
        r.farm for r in frappe.get_all(
            "Farm Filter", filters={"parenttype": "Crop Scouted", "parent": CROP}, fields=["farm"],
            limit_page_length=0,
        ) if r.farm
    })


def recipients(farm) -> list:
    """The avocado team of a farm: see the module docstring."""
    out = list(C.recipients_for_farm(farm))
    if frappe.db.has_column("Employee", "custom_farm"):
        users = frappe.get_all(
            "Employee", filters={"custom_farm": farm, "status": "Active", "user_id": ["is", "set"]},
            pluck="user_id", limit_page_length=0,
        )
        for u in users:
            enabled, email = frappe.db.get_value("User", u, ["enabled", "email"]) or (0, None)
            addr = (email or u or "").strip()
            if enabled and "@" in addr and u not in ("Administrator", "Guest") and addr not in out:
                out.append(addr)
    return out


def collect(farm, monday) -> dict:
    from upande_scp.serverscripts.reports import block_weekly_report as W

    sunday = monday + timedelta(days=6)
    blocks = W._blocks_for_farm(farm)
    entries = []
    if blocks:
        for scout, day, time, block, tree, lat, lon in frappe.db.sql(
            """SELECT scouts_name, date_of_capture, time_of_capture, block, tree, latitude, longitude
                 FROM `tabScouting Entry`
                WHERE block IN %(blocks)s AND date_of_capture BETWEEN %(a)s AND %(b)s AND docstatus < 2""",
            {"blocks": tuple(blocks), "a": monday, "b": sunday},
        ):
            entries.append({"scout": scout, "day": day, "time": time, "block": block, "tree": tree,
                            "lat": lat, "lon": lon})
    listed, below = scout_rows(entries)
    names = C._scout_names([r["scout"] for r in listed + below])
    for r in listed + below:
        r["name"] = names.get(r["scout"]) or r["scout"] or "Unknown"
    scouted = {e["block"] for e in entries if e["block"]}
    return {
        "farm": farm, "monday": monday, "sunday": sunday, "blocks_total": len(blocks),
        "blocks_scouted": len(scouted), "unscouted": [b for b in blocks if b not in scouted],
        "scouts": listed, "below": below, "entries": len(entries),
    }


# ── render ──────────────────────────────────────────────────────────────────


def subject(data, test=False) -> str:
    s = f"{data['farm']} avocado: scout coverage, week {data['monday'].isocalendar()[1]}"
    return f"[Test] {s}" if test else s


def filename(data) -> str:
    y, w, _ = data["monday"].isocalendar()
    return f"{data['farm']}_avocado_scouts_{y}-W{w:02d}.xlsx".replace(" ", "_")


def render(data, test=False) -> str:
    esc = frappe.utils.escape_html
    body = "".join(
        f'<tr valign="top"><td {TD}>{esc(r["name"])}</td><td {TDN}>{r["trees"]}</td><td {TDN}>{r["entries"]}</td>'
        f'<td {TDN}>{r["blocks"]}</td><td {TDN}>{r["days"]}</td><td {TDN}>{r["km"]:.1f} km</td></tr>'
        for r in data["scouts"][:MAX_ROWS]
    )
    scouts = (
        f"<table {TABLE}><tr><th {TH}>Scout</th><th {THN}>Trees</th><th {THN}>Entries</th><th {THN}>Blocks</th>"
        f"<th {THN}>Active days</th><th {THN}>Walked</th></tr>{body}</table>"
        if body else f'<p style="color:{MUTED};">No scout reached {MIN_ENTRIES} entries this week.</p>'
    )
    below = (
        f'<p style="margin:0 0 8px 0;color:{MUTED};font-size:11px;">{len(data["below"])} more with fewer than '
        f"{MIN_ENTRIES} entries are not listed.</p>" if data["below"] else ""
    )
    un = data["unscouted"]
    unscouted = (
        f'<p style="margin:14px 0 0 0;font-size:12px;"><b style="color:{BAD};">Blocks not scouted this week ({len(un)})</b>: '
        f'{", ".join(esc(b) for b in un[:60])}{" and more" if len(un) > 60 else ""}.</p>'
        if un else f'<p style="margin:14px 0 0 0;font-size:12px;">Every block was scouted this week.</p>'
    )
    test_note = f'<p style="margin:0 0 10px 0;color:{MUTED};font-size:12px;"><b>Test email</b>: not the scheduled report.</p>' if test else ""
    y, w, _ = data["monday"].isocalendar()
    return (
        f'<div style="font-family:Poppins,Arial,sans-serif;color:{INK};max-width:760px;">{test_note}'
        f'<h2 style="margin:0 0 4px 0;font-size:19px;">Avocado scout coverage: {esc(data["farm"])}</h2>'
        f'<p style="margin:0 0 16px 0;color:{MUTED};font-size:13px;">Week {w}, {y} ({data["monday"]:%d %b} to {data["sunday"]:%d %b})'
        f' · {data["entries"]} entries · {data["blocks_scouted"]} of {data["blocks_total"]} blocks scouted</p>'
        f"{scouts}{below}{unscouted}"
        f'<p style="margin:16px 0 0 0;color:{MUTED};font-size:11px;">Walked distance adds the GPS fixes of a scout\'s entries '
        f"in time order each day, ignoring jumps over {int(MAX_JUMP_M)} m. A scout is listed from {MIN_ENTRIES} entries in the week.</p></div>"
    )


def workbook_bytes(data) -> bytes:
    import io

    from openpyxl import Workbook
    from openpyxl.styles import Font

    wb = Workbook()
    ws = wb.active
    ws.title = "Scouts"
    ws.append(["Scout", "Employee", "Trees", "Entries", "Blocks", "Active days", "Walked (km)"])
    for r in data["scouts"]:
        ws.append([r["name"], r["scout"], r["trees"], r["entries"], r["blocks"], r["days"], r["km"]])
    ws2 = wb.create_sheet("Not scouted")
    ws2.append(["Block"])
    for b in data["unscouted"]:
        ws2.append([b])
    ws3 = wb.create_sheet("Below minimum")
    ws3.append(["Scout", "Entries"])
    for r in data["below"]:
        ws3.append([r["name"], r["entries"]])
    for sheet in wb.worksheets:
        for c in sheet[1]:
            c.font = Font(bold=True)
        for col in sheet.columns:
            sheet.column_dimensions[col[0].column_letter].width = min(40, max(10, max(len(str(c.value or "")) for c in col) + 2))
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ── sending ─────────────────────────────────────────────────────────────────


def send_farm(farm, monday, *, only_to=None, data=None) -> dict:
    to = [only_to] if only_to else recipients(farm)
    if not to:
        return {"sent": False, "reason": "no recipients"}
    data = data or collect(farm, monday)
    company = frappe.db.get_value("Farm", farm, "company")
    try:
        frappe.sendmail(
            recipients=to, subject=subject(data, bool(only_to)), message=render(data, bool(only_to)),
            attachments=[{"fname": filename(data), "fcontent": workbook_bytes(data)}],
            sender=report_sender(company),
        )
    except Exception:
        frappe.log_error(frappe.get_traceback(), f"avocado scout email: {farm}")
        return {"sent": False, "reason": "send failed"}
    return {"sent": True, "recipients": to}


def send_weekly_avocado_scouts(today=None, force=False) -> list:
    """Daily scheduler entry: sends on the configured weekday for the last ISO week."""
    enabled, day = SR.settings_for("avocado_scout")
    if not force and (not enabled or not SR.is_send_day(day, today)):
        return []
    monday = SR.last_week_monday(today)
    out = []
    for farm in avocado_farms():
        try:
            out.append({"farm": farm, **send_farm(farm, monday)})
        except Exception:
            frappe.log_error(frappe.get_traceback(), f"avocado scout email: {farm}")
    frappe.db.commit()
    return out


def _sample(farm=None, week_start=None):
    farms = avocado_farms()
    farm = farm or (farms[0] if farms else None)
    if not farm or farm not in farms:
        frappe.throw("No farm that grows avocado was found.")
    monday = frappe.utils.getdate(week_start) if week_start else SR.last_week_monday()
    return farm, monday


@frappe.whitelist()
def preview_avocado_scout_email(farm=None, week_start=None) -> str:
    SR._may_trigger()
    farm, monday = _sample(farm, week_start)
    return render(collect(farm, monday), test=True)


@frappe.whitelist()
def send_test_avocado_scout_email(farm=None, week_start=None) -> dict:
    SR._may_trigger()
    farm, monday = _sample(farm, week_start)
    email = frappe.db.get_value("User", frappe.session.user, "email") or frappe.session.user
    if "@" not in (email or ""):
        frappe.throw("Your user has no email address to send the test to.")
    return {**send_farm(farm, monday, only_to=email), "to": email, "farm": farm}
