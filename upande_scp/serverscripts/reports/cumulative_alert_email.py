"""The block cumulative-threshold alert email (avocado and other block crops).

Dressed like the daily chemical-planning progress email
(``progress_email_v2``): ink header on paper, one white card, pills, a gold
gradient meter, no emoji. One email says one thing: this block's cumulative
count of this pest, over the scouting round, per hectare, has passed its
threshold — and shows the days that built it.
"""
from __future__ import annotations

import frappe

from upande_scp.serverscripts.common import cumulative_rules as R
from upande_scp.serverscripts.reports.progress_email_v2 import (
    CARD, FAINT, FONT, GOLD, INK, LINE, MUTED, PAPER, RED,
    _compact, _face_block, pill,
)

APP_PATH = "/scp_app"
KIND_WORD = {R.PEST: "Pest", R.DISEASE: "Disease"}
GOLD_GRADIENT = "linear-gradient(90deg,#d4a72c,#a87d0d)"


def _slug(crop) -> str:
    return "-".join((crop or "avocado").strip().lower().split()) or "avocado"


def link(fig) -> str:
    return f"{frappe.utils.get_url()}{APP_PATH}#/{_slug(fig.get('crop'))}/observations"


def subject(fig, test=False) -> str:
    s = (
        f"{fig['block']}: {fig['observation']} passed {R.fmt_per_ha(fig['threshold_per_ha'])} per ha "
        f"({R.fmt_per_ha(fig['per_ha'])} per ha this round)"
    )
    return f"[Test] {s}" if test else s


def _meter(per_ha, threshold) -> str:
    """Gold up to the threshold, red past it, grey for the rest — three cells."""
    scale = max(float(per_ha), float(threshold)) * 1.2 or 1.0
    base = min(float(per_ha), float(threshold))
    over = max(float(per_ha) - float(threshold), 0.0)
    pct = lambda v: max(round(v * 100 / scale, 1), 0)  # noqa: E731
    cell = lambda w, bg, extra="": (  # noqa: E731
        f'<td width="{w}%" bgcolor="{bg[0]}" height="12" style="height:12px;font-size:0;line-height:12px;'
        f'background:{bg[1]};{extra}">&nbsp;</td>' if w > 0 else ""
    )
    rest = max(100 - pct(base) - pct(over), 0)
    return (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
        + cell(pct(base), (GOLD, GOLD_GRADIENT), "border-radius:999px 0 0 999px;")
        + cell(pct(over), (RED, RED))
        + cell(rest, ("#dedbd3", "#dedbd3"), "border-radius:0 999px 999px 0;")
        + "</tr></table>"
    )


def _day_rows(fig) -> str:
    area = fig.get("area_ha")
    out = []
    for s in fig["daily"]:
        crossed = fig.get("crossed_on") == s["date"]
        mark = pill("Passed", INK, PAPER, size="10px", pad="2px 8px") if crossed else ""
        out.append(
            f'<tr><td style="padding:7px 0;border-top:1px solid {LINE};color:{INK};font-size:12px;">'
            f'{s["date"]:%a %d %b}</td>'
            f'<td align="right" style="padding:7px 0;border-top:1px solid {LINE};color:{INK};font-size:12px;">'
            f'{R.fmt_count(s["count"])}</td>'
            f'<td align="right" style="padding:7px 0;border-top:1px solid {LINE};color:{INK};font-size:12px;">'
            f'{R.fmt_count(s["running"])}</td>'
            f'<td align="right" style="padding:7px 0;border-top:1px solid {LINE};color:{INK};font-size:12px;'
            f'font-weight:600;">{R.fmt_per_ha(R.per_ha(s["running"], area))}</td>'
            f'<td align="right" style="padding:7px 0 7px 8px;border-top:1px solid {LINE};">{mark}</td></tr>'
        )
    return "".join(out)


def render(fig, test=False) -> str:
    esc = frappe.utils.escape_html
    per_ha, thr, area = fig["per_ha"], fig["threshold_per_ha"], fig["area_ha"]
    start, end = fig["round_start"], fig["round_end"]
    kind = KIND_WORD.get(fig["kind"], "Pest")
    counts = " + ".join(R.fmt_count(s["count"]) for s in fig["daily"])
    scouts = ", ".join(esc(s) for s in fig["scouts"]) or "not recorded"
    farm = f' &nbsp;·&nbsp; {esc(fig["farm"])}' if fig.get("farm") else ""
    test_note = (
        f'<tr><td style="padding:14px 26px 0;">{pill("Test email: not an alert", CARD, INK, border=INK, size="11px")}'
        + ('<span style="color:#6f6a61;font-size:11px;padding-left:8px;">threshold shown is illustrative: none is set for this pest yet</span>'
           if fig.get("illustrative_threshold") else "")
        + "</td></tr>"
        if test else ""
    )
    return _compact(f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>{_face_block()}</style></head>
<body style="margin:0;padding:0;background:#e8e6e0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#e8e6e0;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:100%;background:{PAPER};border-radius:16px;overflow:hidden;font-family:{FONT};">

  <tr><td style="background:{INK};padding:22px 26px;">
    <div style="color:#ffffff;font-size:19px;font-weight:600;letter-spacing:-0.3px;">Cumulative threshold passed</div>
    <div style="color:#b8b2a7;font-size:11.5px;padding-top:3px;">{esc(fig['block'])}{farm} &nbsp;·&nbsp; round {start:%d %b} to {end:%d %b}</div>
  </td></tr>
  {test_note}
  <tr><td style="padding:22px 26px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{CARD};border-radius:14px;">
      <tr><td style="padding:20px 20px 18px;">
        <div style="color:{MUTED};font-size:11.5px;">{kind}</div>
        <div style="color:{INK};font-size:20px;font-weight:600;letter-spacing:-0.4px;padding-top:2px;">{esc(fig['observation'])}</div>
        <div style="color:{INK};font-size:38px;font-weight:600;letter-spacing:-1.2px;line-height:1.05;padding-top:14px;">{R.fmt_per_ha(per_ha)}<span style="color:{FAINT};font-size:18px;font-weight:500;letter-spacing:-0.3px;"> per ha this round</span></div>
        <div style="color:{MUTED};font-size:12px;padding:4px 0 14px;">Threshold {R.fmt_per_ha(thr)} per ha &nbsp;·&nbsp; {R.fmt_count(fig['cumulative'])} counted over {R.fmt_per_ha(area)} ha</div>
        {_meter(per_ha, thr)}
      </td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:16px 26px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{CARD};border-radius:14px;">
      <tr><td style="padding:16px 20px 12px;">
        <div style="color:{INK};font-size:13px;font-weight:600;padding-bottom:6px;">Day by day</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="color:{FAINT};font-size:10.5px;padding-bottom:4px;">Scouting day</td>
            <td align="right" style="color:{FAINT};font-size:10.5px;padding-bottom:4px;">Recorded</td>
            <td align="right" style="color:{FAINT};font-size:10.5px;padding-bottom:4px;">Running total</td>
            <td align="right" style="color:{FAINT};font-size:10.5px;padding-bottom:4px;">Per ha</td><td></td>
          </tr>
          {_day_rows(fig)}
        </table>
        <div style="color:{MUTED};font-size:11.5px;padding-top:10px;">{counts} = {R.fmt_count(fig['cumulative'])} over {R.fmt_per_ha(area)} ha</div>
      </td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:16px 26px 0;">
    <div style="color:{MUTED};font-size:11.5px;">Scouted by</div>
    <div style="color:{INK};font-size:13px;padding-top:2px;">{scouts}</div>
  </td></tr>

  <tr><td style="padding:18px 26px 0;">
    <a href="{esc(link(fig))}" style="display:inline-block;background:{INK};color:{PAPER};font-size:12px;font-weight:600;text-decoration:none;padding:9px 16px;border-radius:999px;">Open {esc(fig['block'])} in SCP</a>
  </td></tr>

  <tr><td style="padding:20px 26px 26px;">
    <div style="border-top:1px solid {LINE};padding-top:12px;color:{MUTED};font-size:11px;line-height:1.6;">
      An orchard block is too large to cover in a day, so it is judged on its whole scouting round:
      the cumulative count of the pest, divided by the block's area. This email is sent once per
      block, pest and round, the first time the figure passes the threshold.
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>
""")
