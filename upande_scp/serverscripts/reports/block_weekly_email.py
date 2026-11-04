"""End-of-week cumulative per-hectare report email for block-grown crops.

Every Monday morning, for the ISO week just ended, one email per farm goes to the
same people who get the cumulative threshold alerts (``recipients_for_farm``):
per block, each pest and disease with its week's count per hectare against its
threshold, the crossings that already alerted that week, the blocks with no area
(no per-ha figure can be given for them) and the totals, with the weekly block
workbook attached. Dressed like the alert email (UFD ink and paper, pills, no
strips, no emoji).

A crop whose cumulative alerts are paused (``cumulative_alert_paused``, crop
override) sends nothing, here or there.
"""
from __future__ import annotations

from datetime import timedelta

import frappe

from upande_scp.serverscripts.common import clusters as CL
from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.common import cumulative_rules as R
from upande_scp.serverscripts.reports import block_weekly_report as W
from upande_scp.serverscripts.reports.progress_email_v2 import (
    CARD, FAINT, FONT, INK, LINE, MUTED, PAPER, RED, _compact, _face_block, pill,
)
from upande_scp.serverscripts.reports.report_sender import report_sender
from upande_scp.serverscripts.scouting import cumulative_per_ha as C
from upande_scp.serverscripts.scouting import tree_hot_spots as T

APP_PATH = "/scp_app"
KIND_WORD = {R.PEST: "Pest", R.DISEASE: "Disease"}


def last_week_monday(today=None):
    today = R.as_date(today or frappe.utils.nowdate())
    return today - timedelta(days=today.weekday() + 7)


def block_crops() -> list:
    return [c for c in (crop_catalog.catalog().get("crops") or []) if C.is_block_crop(c)]


def farms_for(crop) -> list:
    """The crop's farms that have blocks set up, sorted."""
    return [f for f in sorted(crop_scope.farms_for_crop(crop) or set()) if W._blocks_for_farm(f)]


def collect(crop, farm, monday) -> dict:
    """Everything the email says, for one farm and ISO week."""
    sunday = monday + timedelta(days=6)
    blocks = W._blocks_for_farm(farm)
    info = C.block_info(blocks)
    figs = C.round_figures(crop, blocks, monday, sunday)
    scouted = C._scouted_blocks(blocks, monday, sunday)
    area_of = {b: (info.get(b) or {}).get("area_ha") for b in blocks}
    rows, unset = [], 0
    for b in blocks:
        mine = []
        for f in figs.get(b, []):
            if f["per_ha"] is None:
                continue
            if not f["threshold_per_ha"]:
                unset += 1
                continue
            mine.append({**f, "over": f["per_ha"] >= f["threshold_per_ha"]})
        if mine:
            mine.sort(key=lambda f: (not f["over"], -f["per_ha"], f["observation"]))
            rows.append({"block": b, "area_ha": area_of[b], "figures": mine})
    rows.sort(key=lambda r: (-sum(f["over"] for f in r["figures"]), r["block"]))
    alerts = frappe.get_all(
        C.DOCTYPE,
        filters={"farm": farm, "crop": crop, "round_start": monday},
        fields=["warehouse", "observation", "per_ha", "threshold_per_ha", "crossed_on"],
        order_by="crossed_on, warehouse",
        limit_page_length=0,
    )
    scouted_area = sum(area_of.get(b) or 0 for b in scouted)
    try:
        spots = T.spots_for_week(crop, monday, blocks)
    except Exception:
        frappe.log_error(frappe.get_traceback(), f"block weekly email hot spots: {farm}")
        spots = []
    return {
        "hot_spots": spots,
        "crop": crop, "farm": farm, "monday": monday, "sunday": sunday,
        "blocks_total": len(blocks), "blocks_scouted": len(scouted),
        "area_scouted": round(scouted_area, 2),
        "no_area": [b for b in blocks if not area_of[b]],
        "rows": rows,
        "over": sum(f["over"] for r in rows for f in r["figures"]),
        "unset": unset,
        "alerts": alerts,
        "summary": C.farm_summary(blocks, figs, scouted, area_of),
    }


def week_label(data) -> str:
    y, w, _ = data["monday"].isocalendar()
    return f"Week {w}, {y}"


def subject(data, test=False) -> str:
    s = (
        f"{data['farm']} {data['crop']}: week {data['monday'].isocalendar()[1]} per hectare report, "
        f"{data['over']} over threshold"
    )
    return f"[Test] {s}" if test else s


def filename(data) -> str:
    y, w, _ = data["monday"].isocalendar()
    return f"{data['farm']}_{data['crop']}_blocks_{y}-W{w:02d}.xlsx".replace(" ", "_")


def _td(text, align="left", color=INK, weight="400", pad="7px 0", top=True) -> str:
    border = f"border-top:1px solid {LINE};" if top else ""
    return (f'<td align="{align}" style="padding:{pad};{border}color:{color};font-size:12px;'
            f'font-weight:{weight};">{text}</td>')


def _block_card(row) -> str:
    esc = frappe.utils.escape_html
    lines = []
    for i, f in enumerate(row["figures"]):
        tag = pill("Over", RED, "#ffffff", size="10px", pad="2px 8px") if f["over"] else pill(
            "Under", PAPER, MUTED, border=LINE, size="10px")
        lines.append(
            "<tr>"
            + _td(f'{esc(f["observation"])} <span style="color:{FAINT};font-size:10.5px;">{KIND_WORD.get(f["kind"], "")}</span>', top=i > 0)
            + _td(R.fmt_count(f["cumulative"]), "right", top=i > 0)
            + _td(R.fmt_per_ha(f["per_ha"]), "right", RED if f["over"] else INK, "600", top=i > 0)
            + _td(R.fmt_per_ha(f["threshold_per_ha"]), "right", MUTED, top=i > 0)
            + _td(tag, "right", pad="7px 0 7px 8px", top=i > 0)
            + "</tr>"
        )
    head = "".join(
        f'<td align="{a}" style="color:{FAINT};font-size:10.5px;padding-bottom:4px;">{t}</td>'
        for t, a in (("Pest or disease", "left"), ("Count", "right"), ("Per ha", "right"), ("Threshold", "right"), ("", "right"))
    )
    return (
        f'<tr><td style="padding:12px 26px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'border="0" style="background:{CARD};border-radius:14px;"><tr><td style="padding:14px 18px 10px;">'
        f'<div style="color:{INK};font-size:13px;font-weight:600;">{esc(row["block"])}'
        f'<span style="color:{FAINT};font-size:11px;font-weight:400;"> &nbsp;{R.fmt_per_ha(row["area_ha"])} ha</span></div>'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:6px;table-layout:fixed;">'
        f'<colgroup><col><col width="52"><col width="58"><col width="72"><col width="60"></colgroup>'
        f"<tr>{head}</tr>{''.join(lines)}</table></td></tr></table></td></tr>"
    )


MAX_SPOT_LINES = 40


def _spots_card(spots) -> str:
    """Per-tree hot spots of the week: a line per block (how many, worst band)
    and, under it, where each one is. Capped, so the email stays small."""
    esc = frappe.utils.escape_html
    by_block: dict = {}
    for s in spots:
        by_block.setdefault(s["warehouse"], []).append(s)
    lines, shown = [], 0
    for block, items in sorted(by_block.items(), key=lambda kv: (-sum(i["band"] == "high" for i in kv[1]), kv[0])):
        high = sum(i["band"] == "high" for i in items)
        tag = pill(f"{high} High", RED, "#ffffff", size="10px", pad="2px 8px") if high else ""
        lines.append(
            f'<tr><td style="padding:9px 0 2px;border-top:1px solid {LINE};color:{INK};font-size:12px;font-weight:600;">'
            f'{esc(block)} <span style="color:{FAINT};font-weight:400;font-size:11px;">'
            f'{len(items)} hot spot{"s" if len(items) != 1 else ""}</span></td>'
            f'<td align="right" style="padding:9px 0 2px;border-top:1px solid {LINE};">{tag}</td></tr>'
        )
        for i in items:
            if shown >= MAX_SPOT_LINES:
                break
            shown += 1
            lines.append(
                f'<tr><td colspan="2" style="padding:0 0 3px;color:{MUTED};font-size:11.5px;">'
                f'{esc(i["observation"])}: {i["size"]} trees, {esc(CL.label(i, "row"))}, '
                f'{i["band"]} band, worst tree {T.fmt(i["peak"])}</td></tr>'
            )
    more = (f'<tr><td colspan="2" style="padding:6px 0 0;color:{FAINT};font-size:11px;">'
            f'and {len(spots) - shown} more, in the app</td></tr>') if shown < len(spots) else ""
    return (
        f'<tr><td style="padding:12px 26px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
        f'style="background:{CARD};border-radius:14px;"><tr><td style="padding:14px 18px 12px;">'
        f'<div style="color:{INK};font-size:13px;font-weight:600;">Hot spots by tree ({len(spots)})</div>'
        f'<div style="color:{MUTED};font-size:11px;padding:2px 0 4px;">Three or more neighbouring trees over the pest\'s per-tree '
        f'Moderate band this week: where inside each block the pest sits.</div>'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">{"".join(lines)}{more}</table>'
        f'</td></tr></table></td></tr>'
        if spots else
        f'<tr><td style="padding:12px 26px 0;color:{MUTED};font-size:12px;">No hot spot by tree this week (none with a per-tree band set, or no three neighbouring trees over it).</td></tr>'
    )


def _stat(value, label) -> str:
    return (f'<td width="25%" style="padding:0 4px;"><div style="background:{CARD};border-radius:12px;padding:12px 10px;">'
            f'<div style="color:{INK};font-size:20px;font-weight:600;letter-spacing:-0.5px;">{value}</div>'
            f'<div style="color:{MUTED};font-size:10.5px;padding-top:2px;">{label}</div></div></td>')


def link(data) -> str:
    slug = "-".join(data["crop"].strip().lower().split())
    return f"{frappe.utils.get_url()}{APP_PATH}#/{slug}/reports"


def render(data, test=False) -> str:
    esc = frappe.utils.escape_html
    d = data
    test_note = (
        f'<tr><td style="padding:14px 26px 0;">{pill("Test email: not the scheduled report", CARD, INK, border=INK, size="11px")}</td></tr>'
        if test else ""
    )
    alerts = "".join(
        f'<tr>{_td(esc(a["warehouse"]))}{_td(esc(a["observation"]))}'
        f'{_td(R.fmt_per_ha(a["per_ha"]) + " / " + R.fmt_per_ha(a["threshold_per_ha"]), "right")}'
        f'{_td(a["crossed_on"].strftime("%a %d %b") if a.get("crossed_on") else "", "right")}</tr>'
        for a in d["alerts"]
    )
    alerts_card = (
        f'<tr><td style="padding:12px 26px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
        f'style="background:{CARD};border-radius:14px;"><tr><td style="padding:14px 18px 10px;">'
        f'<div style="color:{INK};font-size:13px;font-weight:600;padding-bottom:6px;">Alerts already sent this week ({len(d["alerts"])})</div>'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">'
        f'<tr><td style="color:{FAINT};font-size:10.5px;">Block</td><td style="color:{FAINT};font-size:10.5px;">Observation</td>'
        f'<td align="right" style="color:{FAINT};font-size:10.5px;">Per ha / threshold</td>'
        f'<td align="right" style="color:{FAINT};font-size:10.5px;">Crossed</td></tr>{alerts}</table></td></tr></table></td></tr>'
        if d["alerts"] else
        f'<tr><td style="padding:12px 26px 0;color:{MUTED};font-size:12px;">No threshold alert was sent this week.</td></tr>'
    )
    summary = "".join(
        f'<tr>{_td(esc(s["observation"]))}{_td(R.fmt_per_ha(s["per_ha"]), "right", INK, "600")}'
        f'{_td(R.fmt_per_ha(s["threshold_per_ha"]) if s.get("threshold_per_ha") else "not set", "right", MUTED)}'
        f'{_td(str(s.get("blocks_over") or 0), "right")}</tr>'
        for s in d["summary"][:8]
    )
    summary_card = (
        f'<tr><td style="padding:12px 26px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
        f'style="background:{CARD};border-radius:14px;"><tr><td style="padding:14px 18px 10px;">'
        f'<div style="color:{INK};font-size:13px;font-weight:600;padding-bottom:6px;">Farm-wide, per hectare scouted</div>'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">'
        f'<tr><td style="color:{FAINT};font-size:10.5px;">Observation</td><td align="right" style="color:{FAINT};font-size:10.5px;">Per ha</td>'
        f'<td align="right" style="color:{FAINT};font-size:10.5px;">Threshold</td><td align="right" style="color:{FAINT};font-size:10.5px;">Blocks over</td></tr>'
        f'{summary}</table></td></tr></table></td></tr>' if summary else ""
    )
    over_rows = [r for r in d["rows"] if any(f["over"] for f in r["figures"])]
    calm_rows = [r for r in d["rows"] if r not in over_rows]
    calm = "".join(
        f'<tr>{_td(esc(r["block"]))}{_td(esc(r["figures"][0]["observation"]))}'
        f'{_td(R.fmt_per_ha(r["figures"][0]["per_ha"]) + " / " + R.fmt_per_ha(r["figures"][0]["threshold_per_ha"]), "right", MUTED)}</tr>'
        for r in calm_rows
    )
    calm_card = (
        f'<tr><td style="padding:12px 26px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
        f'style="background:{CARD};border-radius:14px;"><tr><td style="padding:14px 18px 10px;">'
        f'<div style="color:{INK};font-size:13px;font-weight:600;">Under threshold ({len(calm_rows)} blocks)</div>'
        f'<div style="color:{MUTED};font-size:11px;padding:2px 0 6px;">Each block\'s highest figure; the rest are in the workbook.</div>'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">'
        f'<tr><td style="color:{FAINT};font-size:10.5px;">Block</td><td style="color:{FAINT};font-size:10.5px;">Observation</td>'
        f'<td align="right" style="color:{FAINT};font-size:10.5px;">Per ha / threshold</td></tr>{calm}</table></td></tr></table></td></tr>'
        if calm_rows else ""
    )
    blocks = ("".join(_block_card(r) for r in over_rows) + calm_card) or (
        f'<tr><td style="padding:14px 26px 0;color:{MUTED};font-size:12px;">Nothing with a threshold set was recorded this week.</td></tr>'
    )
    no_area = (
        f'<tr><td style="padding:14px 26px 0;"><div style="color:{INK};font-size:12px;font-weight:600;">No area set ({len(d["no_area"])})</div>'
        f'<div style="color:{MUTED};font-size:11.5px;padding-top:2px;">No per-hectare figure can be given for: '
        f'{", ".join(esc(b) for b in d["no_area"][:30])}{" and more" if len(d["no_area"]) > 30 else ""}. '
        f'Set the block area on the warehouse.</div></td></tr>' if d["no_area"] else ""
    )
    unset = (
        f'<tr><td style="padding:10px 26px 0;color:{MUTED};font-size:11.5px;">{d["unset"]} further observation'
        f'{"s" if d["unset"] != 1 else ""} had no per-hectare threshold set and are in the attached workbook only.</td></tr>'
        if d["unset"] else ""
    )
    return _compact(f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>{_face_block()}</style></head>
<body style="margin:0;padding:0;background:#e8e6e0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#e8e6e0;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:100%;background:{PAPER};border-radius:16px;overflow:hidden;font-family:{FONT};">
  <tr><td style="background:{INK};padding:22px 26px;">
    <div style="color:#ffffff;font-size:19px;font-weight:600;letter-spacing:-0.3px;">Weekly report: cumulative per hectare</div>
    <div style="color:#b8b2a7;font-size:11.5px;padding-top:3px;">{esc(d['farm'])} &nbsp;·&nbsp; {esc(d['crop'])} &nbsp;·&nbsp; {week_label(d)}, {d['monday']:%d %b} to {d['sunday']:%d %b}</div>
  </td></tr>
  {test_note}
  <tr><td style="padding:18px 22px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    {_stat(f"{d['blocks_scouted']}/{d['blocks_total']}", "blocks scouted")}
    {_stat(R.fmt_per_ha(d['area_scouted']), "hectares scouted")}
    {_stat(d['over'], "over threshold")}
    {_stat(len(d['alerts']), "alerts sent")}
  </tr></table></td></tr>
  {summary_card}
  {_spots_card(d.get("hot_spots") or [])}
  <tr><td style="padding:16px 26px 0;"><div style="color:{INK};font-size:14px;font-weight:600;">By block</div>
    <div style="color:{MUTED};font-size:11.5px;padding-top:2px;">Blocks with a pest or disease over its threshold first; the week's cumulative count over the block's hectares.</div></td></tr>
  {blocks}
  {unset}
  {no_area}
  {alerts_card}
  <tr><td style="padding:18px 26px 0;">
    <a href="{esc(link(d))}" style="display:inline-block;background:{INK};color:{PAPER};font-size:12px;font-weight:600;text-decoration:none;padding:9px 16px;border-radius:999px;">Open the block report in SCP</a>
  </td></tr>
  <tr><td style="padding:20px 26px 26px;"><div style="border-top:1px solid {LINE};padding-top:12px;color:{MUTED};font-size:11px;line-height:1.6;">
    The block workbook for the week is attached. Counts are cumulative over the ISO week (Monday to Sunday)
    divided by the block's area; farm-wide figures use the area of the blocks scouted. Sent every Monday for the week just ended.
  </div></td></tr>
</table></td></tr></table></body></html>
""")


def send_farm(crop, farm, monday, *, only_to=None) -> dict:
    """One farm's report. ``only_to`` sends a test to that address alone."""
    if not only_to and not C.alerts_enabled(crop):
        return {"sent": False, "reason": "cumulative alerts are paused"}
    recipients = [only_to] if only_to else C.recipients_for_farm(farm)
    if not recipients:
        return {"sent": False, "reason": "no recipients"}
    data = collect(crop, farm, monday)
    attachments = []
    try:
        y, w, _ = monday.isocalendar()
        attachments = [{"fname": filename(data), "fcontent": W.build_workbook_bytes(crop, farm, y, w)}]
    except Exception:
        frappe.log_error(frappe.get_traceback(), f"block weekly email workbook: {farm}")
    try:
        frappe.sendmail(
            recipients=recipients, subject=subject(data, test=bool(only_to)),
            message=render(data, test=bool(only_to)), attachments=attachments,
            sender=report_sender(frappe.db.get_value("Farm", farm, "company")),
        )
    except Exception:
        frappe.log_error(frappe.get_traceback(), f"block weekly email: {farm}")
        return {"sent": False, "reason": "send failed"}
    return {"sent": True, "recipients": recipients, "attachment": bool(attachments)}


def send_weekly_block_report(today=None) -> list:
    """Scheduler entry (Mondays): last ISO week, every block crop, one email per farm."""
    monday = last_week_monday(today)
    out = []
    for crop in block_crops():
        if not C.alerts_enabled(crop):
            continue
        for farm in farms_for(crop):
            try:
                out.append({"crop": crop, "farm": farm, **send_farm(crop, farm, monday)})
            except Exception:
                frappe.log_error(frappe.get_traceback(), f"block weekly email: {farm}")
    frappe.db.commit()
    return out


def _may_trigger():
    roles = set(frappe.get_roles(frappe.session.user))
    if not roles & {"SCP General Manager", "System Manager", "Administrator"}:
        frappe.throw("Not permitted.", frappe.PermissionError)


def _sample(crop, farm=None):
    C._assert_crop(crop)
    farms = farms_for(crop)
    farm = farm or (farms[0] if farms else None)
    if not farm or farm not in farms:
        frappe.throw(f"No farm with blocks set up was found for {crop}.")
    return collect(crop, farm, last_week_monday())


@frappe.whitelist()
def preview_weekly_block_email(crop="Avocado", farm=None) -> str:
    """The weekly email's HTML for last ISO week, without sending."""
    _may_trigger()
    return render(_sample(crop, farm), test=True)


@frappe.whitelist()
def send_test_weekly_block_email(crop="Avocado", farm=None) -> dict:
    """Send the weekly report (with its workbook) to the signed-in user only."""
    _may_trigger()
    data = _sample(crop, farm)
    email = frappe.db.get_value("User", frappe.session.user, "email") or frappe.session.user
    if "@" not in (email or ""):
        frappe.throw("Your user has no email address to send the test to.")
    return {**send_farm(crop, data["farm"], data["monday"], only_to=email), "to": email}
