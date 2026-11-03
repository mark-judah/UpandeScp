"""
send_weekly_coverage_report.py
==============================
Weekly Greenhouse Coverage Report: for last week (Monday to Sunday), was every
greenhouse or block scouted, on which days, and by whom.

Every farm scouted in the last four weeks is covered, so a farm that stopped
scouting altogether still shows up — as a page of unscouted houses. A house is
any station of the farm (``farm_map.stations_for_farm``), the same list the
scout app offers. Unscouted houses come first, with the last day they were
scouted inside the four-week look-back.

Exposes:
- collect(week_start)                    : the week's data, per farm
- build_html(week_start)                 : HTML for the email and the PDF
- send_weekly_coverage_report()          : scheduler entry point (Mondays)
- trigger_coverage_email()  [whitelisted]: "Send now" button handler
- download_coverage_pdf()   [whitelisted]: PDF download handler
"""

from __future__ import annotations

import re
from datetime import timedelta

import frappe
from frappe.utils.pdf import get_pdf

from upande_scp.serverscripts.common.farm_map import stations_for_farm
from upande_scp.serverscripts.reports.report_recipients import report_recipients
from upande_scp.serverscripts.reports.report_sender import report_sender
from upande_scp.serverscripts.spray_plan_creator.crop_settings import wip_keywords

LOOKBACK_DAYS = 28
DAY_LETTERS = ("M", "T", "W", "T", "F", "S", "S")

INK = "#111111"
MUTED = "#6b6b6b"
RULE = "#e5e5e5"
BAD = "#b42318"
GOOD = "#067647"

# Kept short on purpose: every cell repeats its style, and Gmail clips a
# message past ~100 KB. The table carries the font, colour and alignment.
# Padding comes from cellpadding and top alignment from the row's valign.
TABLE = f'cellpadding="6" style="width:100%;border-collapse:collapse;margin:0 0 8px 0;font-size:13px;color:{INK};text-align:left;"'
TH = f'style="border-bottom:2px solid {INK};font-size:11px;text-transform:uppercase;"'
TD = f'style="border-bottom:1px solid {RULE}"'
TDN = f'style="border-bottom:1px solid {RULE};text-align:right"'


def last_week_start(today=None):
    """Monday of the week before ``today``'s."""
    today = frappe.utils.getdate(today)
    return today - timedelta(days=today.weekday() + 7)


def _house_expr() -> str:
    # Roses record the house in `greenhouse`, avocado and coffee in `block`.
    # Never alias it `station`: Scouting Entry has a column of that name, and
    # GROUP BY would silently group on the column instead.
    return "IFNULL(NULLIF(se.greenhouse, ''), se.block)"


def houses_for_farm(farm) -> list[str]:
    """The farm's stations, without CSUs and other WIP spray areas — those are
    typed Greenhouse on some sites but are never scouted. Same whole-word rule
    as ``crop_settings.is_wip_area``, with the keywords read once."""
    words = wip_keywords()
    wip = re.compile(r"\b(" + "|".join(re.escape(w) for w in words) + r")\b", re.IGNORECASE)
    return [s for s in stations_for_farm(farm) if not wip.search(s)]


def build_rows(stations, week_start, week_rows, last_seen, names) -> list[dict]:
    """One row per station, unscouted first. Pure.

    ``week_rows``: dicts of station, scout, day (date), n — the week's entries
    grouped by station × scout × day. ``last_seen``: station -> latest date
    scouted in the look-back before the week.
    """
    by_station: dict[str, dict] = {}
    for r in week_rows:
        s = by_station.setdefault(r["station"], {"days": set(), "scouts": {}, "entries": 0})
        s["days"].add((frappe.utils.getdate(r["day"]) - week_start).days)
        s["scouts"][r["scout"]] = s["scouts"].get(r["scout"], 0) + int(r["n"])
        s["entries"] += int(r["n"])

    rows = []
    for st in stations:
        s = by_station.get(st)
        if s:
            scouts = sorted(s["scouts"].items(), key=lambda kv: -kv[1])
            rows.append({
                "station": st,
                "scouted": True,
                "days": sorted(d for d in s["days"] if 0 <= d < 7),
                "scouts": [{"name": names.get(k) or k or "Unknown", "entries": v} for k, v in scouts],
                "entries": s["entries"],
                "last_seen": None,
            })
        else:
            rows.append({
                "station": st,
                "scouted": False,
                "days": [],
                "scouts": [],
                "entries": 0,
                "last_seen": last_seen.get(st),
            })
    rows.sort(key=lambda r: (r["scouted"], r["station"]))
    return rows


def collect(week_start=None) -> dict:
    week_start = frappe.utils.getdate(week_start) if week_start else last_week_start()
    week_end = week_start + timedelta(days=6)
    look_from = week_start - timedelta(days=LOOKBACK_DAYS)
    week_rows = frappe.db.sql(
        f"""
        SELECT {_house_expr()} AS house, se.scouts_name AS scout, se.date_of_capture AS day, COUNT(*) AS n
        FROM `tabScouting Entry` se
        WHERE se.date_of_capture BETWEEN %(start)s AND %(end)s AND se.docstatus < 2
        GROUP BY house, scout, day
        """,
        {"start": week_start, "end": week_end},
        as_dict=True,
    )
    for r in week_rows:
        r["station"] = r.pop("house")
    # Four weeks is ~1M rows on a busy site. Each column grouped on its own is
    # answered from the (date, greenhouse) / (date, block) indexes alone, with
    # no row reads — which is also why docstatus is not filtered here.
    last_seen: dict = {}
    for col in ("greenhouse", "block"):
        for house, day in frappe.db.sql(
            f"""
            SELECT `{col}`, MAX(date_of_capture)
            FROM `tabScouting Entry`
            WHERE date_of_capture >= %(from)s AND date_of_capture < %(start)s AND IFNULL(`{col}`, '') != ''
            GROUP BY `{col}`
            """,
            {"from": look_from, "start": week_start},
        ):
            if day and (house not in last_seen or day > last_seen[house]):
                last_seen[house] = day

    seen = {r.station for r in week_rows if r.station} | {s for s in last_seen if s}
    farms = sorted({
        f for f in frappe.get_all(
            "Warehouse", filters={"name": ["in", list(seen)]}, pluck="custom_farm", limit_page_length=0
        ) if f
    }) if seen else []

    scouts = {r.scout for r in week_rows if r.scout}
    names = dict(
        frappe.get_all(
            "Employee", filters={"name": ["in", list(scouts)]}, fields=["name", "employee_name"],
            as_list=True, limit_page_length=0,
        )
    ) if scouts else {}

    out = []
    for farm in farms:
        rows = build_rows(houses_for_farm(farm), week_start, week_rows, last_seen, names)
        if not rows:
            continue
        out.append({
            "farm": farm,
            "rows": rows,
            "total": len(rows),
            "scouted": sum(1 for r in rows if r["scouted"]),
        })
    return {"week_start": week_start, "week_end": week_end, "farms": out}


def _fmt(d) -> str:
    return frappe.utils.formatdate(d, "dd MMM")


def _week_label(data) -> str:
    return f"{_fmt(data['week_start'])} – {frappe.utils.formatdate(data['week_end'], 'dd MMM yyyy')}"


def _days_html(days) -> str:
    """M T W T F S S in monospace, scouted days in ink and the rest a dot."""
    return "<tt>" + " ".join(letter if i in days else "·" for i, letter in enumerate(DAY_LETTERS)) + "</tt>"


def _row_html(r) -> str:
    esc = frappe.utils.escape_html
    if r["scouted"]:
        status = f'<b style="color:{GOOD};">Scouted</b>'
        who = "<br>".join(f'{esc(s["name"])} ({s["entries"]})' for s in r["scouts"])
    else:
        last = f'last scouted {_fmt(r["last_seen"])}' if r["last_seen"] else f"not in the last {LOOKBACK_DAYS // 7} weeks"
        status = f'<b style="color:{BAD};">Not scouted</b><br><small style="color:{MUTED};">{last}</small>'
        who = "—"
    return (
        f"<tr valign=\"top\"><td {TD}>{esc(r['station'])}</td><td {TD}>{status}</td>"
        f"<td {TD}>{_days_html(r['days'])}</td><td {TD}>{who}</td><td {TDN}>{r['entries'] or ''}</td></tr>"
    )


def build_html(week_start=None, data=None) -> str:
    data = data or collect(week_start)
    total = sum(f["total"] for f in data["farms"])
    scouted = sum(f["scouted"] for f in data["farms"])
    parts = [
        f'<div style="font-family:Poppins,Arial,sans-serif;color:{INK};max-width:820px;">',
        '<h2 style="margin:0 0 4px 0;font-size:20px;">Greenhouse Coverage — Weekly</h2>',
        f'<p style="margin:0 0 18px 0;color:{MUTED};font-size:13px;">{_week_label(data)} · '
        f"{scouted} of {total} houses scouted"
        + (f' · <span style="color:{BAD};font-weight:600;">{total - scouted} not scouted</span>' if total - scouted else "")
        + "</p>",
    ]
    if not data["farms"]:
        parts.append(f'<p style="color:{MUTED};">No farm has been scouted in the last {LOOKBACK_DAYS // 7} weeks.</p>')
    for f in data["farms"]:
        missed = f["total"] - f["scouted"]
        parts.append(
            f'<h3 style="margin:22px 0 6px 0;font-size:15px;">{frappe.utils.escape_html(f["farm"])}'
            f' <span style="font-weight:400;color:{MUTED};font-size:13px;">· {f["scouted"]} of {f["total"]} scouted'
            + (f' · <span style="color:{BAD};">{missed} not scouted</span>' if missed else "")
            + "</span></h3>"
        )
        parts.append(
            f"<table {TABLE}>"
            f"<tr><th {TH}>House</th><th {TH}>Status</th><th {TH}>Days scouted</th><th {TH}>Scouted by (entries)</th>"
            f'<th {TH[:-1]}text-align:right;">Entries</th></tr>'
        )
        parts.extend(_row_html(r) for r in f["rows"])
        parts.append("</table>")
    parts.append(
        f'<p style="margin:18px 0 0 0;color:{MUTED};font-size:11px;">Every greenhouse and block of each farm scouted '
        f"in the last {LOOKBACK_DAYS // 7} weeks. A house counts as scouted when it has at least one Scouting Entry that week.</p></div>"
    )
    return "".join(parts)


def _subject(data) -> str:
    return f"Greenhouse Coverage: Weekly Report ({_week_label(data)})"


def send_weekly_coverage_report(week_start=None):
    """Scheduler entry point — builds and sends the weekly coverage email."""
    data = collect(week_start)
    frappe.sendmail(
        recipients=report_recipients(),
        subject=_subject(data),
        message=build_html(data=data),
        sender=report_sender(),
    )


@frappe.whitelist()
def trigger_coverage_email(week_start=None):
    send_weekly_coverage_report(week_start)
    return {"ok": True, "recipients": report_recipients()}


@frappe.whitelist()
def download_coverage_pdf(week_start=None):
    data = collect(week_start)
    frappe.local.response.filename = f"greenhouse_coverage_{data['week_start']}.pdf"
    frappe.local.response.filecontent = get_pdf(build_html(data=data))
    frappe.local.response.type = "download"
