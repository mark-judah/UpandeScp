"""The 18:00 chemical-planning digest, in the redesigned dress.

Same data as ``send_chemical_progress_email`` — the AFP work orders scheduled for
a day and how far each got — rendered as pills, with the seventh step a check
inside a circle rather than the word "Done".

The one structural change is ``collapse_finished``: a plan that finished says so
in a single line, because nobody reads seven green pills to learn that nothing
went wrong. Only the plans still open carry the full step track and its clock.
That is also what keeps a busy day inside Gmail's 102 KB clip limit — see
``measure_progress_email`` for the numbers on any given date.

Nothing here sends. ``send_chemical_progress_email`` still owns the send path.
"""
from __future__ import annotations

from datetime import datetime

import frappe
from frappe.utils import get_datetime

from upande_scp.serverscripts.reports.send_chemical_progress_email import (
    EAT,
    _group_by_farm,
    _wos_scheduled_on,
)
from upande_scp.serverscripts.spray_plan_creator.lifecycle import get_lifecycle

# ── type ─────────────────────────────────────────────────────────────────────
# Gmail strips @font-face, and so does Outlook, so most readers never see
# Poppins however it is served. Apple Mail does load it, hence the face block —
# but the stack below it is what the email is actually designed in: geometric
# where the machine has one (Avenir on a Mac, Century Gothic on Office), the
# platform UI face otherwise (Segoe on Windows, Roboto in Gmail for Android).
FONT = ("Poppins,'Avenir Next',Avenir,'Century Gothic','Segoe UI',Roboto,"
        "'Helvetica Neue',Arial,sans-serif")


def _face_block() -> str:
    base = f"{frappe.utils.get_url()}/assets/upande_scp/fonts/poppins-"
    return "".join(
        f"@font-face{{font-family:Poppins;src:url('{base}{w}.woff2') format('woff2');"
        f"font-weight:{w};font-display:swap;}}"
        for w in (400, 500, 600, 700)
    )


# ── palette ──────────────────────────────────────────────────────────────────
INK, PAPER, CARD = "#161514", "#f4f3ef", "#ffffff"
MUTED, FAINT, LINE = "#6f6a61", "#9a958c", "#e4e1d9"
ROSE, GOLD, GREEN, RED, SLATE = "#a33a5b", "#a87d0d", "#4f7a3a", "#9c3024", "#6f6a61"

STEPS = [
    ("created", "Created"),
    ("approved", "Approved"),
    ("chemical_issued", "Issued"),
    ("labels_printed", "Printed"),
    ("labels_scanned", "Scanned"),
    ("spraying_started", "Sprayed"),
    ("completed", ""),          # the seventh step is the mark, not a word
]

# plan state → (label, pill colour). None colour means an outlined pill.
STATE_PILL = {
    "done": ("", GREEN),
    "spraying": ("Spraying", SLATE),
    "issued": ("Issued", GOLD),
    "printed": ("Printed", GOLD),
    "stopped": ("Stopped", ROSE),
    "missed": ("Missed window", RED),
    "waiting": ("Not started", None),
}


# ── small pieces ─────────────────────────────────────────────────────────────


# Outlook's Word engine squares off border-radius. A VML oval draws a true circle
# there, but costs ~1 KB per card — and every other pill in this design is square
# in Outlook anyway, so the circle alone being round buys little. Off by default;
# the bytes go further keeping a busy day inside Gmail's 102 KB clip limit.
VML_FOR_OUTLOOK = False


def badge(fill, edge, glyph, mark="&#10003;", size=19, font=12):
    """A check inside a circle."""
    if not VML_FOR_OUTLOOK:
        return (f'<span style="display:inline-block;width:{size}px;height:{size}px;'
                f'line-height:{size}px;text-align:center;background:{fill};'
                f'border:1.5px solid {edge};color:{glyph};font-size:{font}px;'
                f'border-radius:999px;">{mark}</span>')
    return (f'<!--[if mso]><v:oval style="width:{size + 3}px;height:{size + 3}px;'
            f'v-text-anchor:middle;" fillcolor="{fill}" strokecolor="{edge}" '
            f'strokeweight="1.25pt"><v:textbox inset="0,0,0,0"><center '
            f'style="color:{glyph};font-size:{font + 1}px;font-family:Arial,sans-serif;">'
            f'{mark}</center></v:textbox></v:oval><![endif]-->'
            f'<!--[if !mso]><!--><span style="display:inline-block;width:{size}px;'
            f'height:{size}px;line-height:{size}px;text-align:center;background:{fill};'
            f'border:1.5px solid {edge};color:{glyph};font-size:{font}px;font-weight:600;'
            f'border-radius:999px;">{mark}</span><!--<![endif]-->')


def pill(text, bg, fg, border=None, weight=None, size=None, pad="4px 9px"):
    edge = f"border:1.5px solid {border};padding:3px 9px;" if border else f"padding:{pad};"
    font = (f"font-size:{size};" if size else "") + (f"font-weight:{weight};" if weight else "")
    return (f'<span style="display:inline-block;background:{bg};color:{fg};{font}'
            f'{edge}border-radius:999px;">{text}</span>')


def step_pill(name, status):
    if status == "done":
        return pill(name, INK, PAPER)
    if status == "current":
        return pill(name, CARD, INK, border=INK)
    if status == "warning":
        return pill(name, CARD, RED, border=RED)
    return (f'<span style="display:inline-block;background:{PAPER};color:{FAINT};'
            f'padding:4px 9px;border-radius:999px;border:1px solid {LINE};">{name}</span>')


def check(status):
    fill, edge, glyph = {
        "done": (INK, INK, PAPER),
        "current": (CARD, INK, INK),
        "warning": (CARD, RED, RED),
    }.get(status, (PAPER, LINE, "#c8c4bb"))
    return badge(fill, edge, glyph, mark="&#10003;" if status == "done" else "&nbsp;")


# ── time ─────────────────────────────────────────────────────────────────────


def _dt(ts):
    if not ts:
        return None
    try:
        return get_datetime(ts)
    except Exception:
        return None


def _clock(ts, target) -> str:
    """HH:MM on the day itself, weekday-prefixed for anything earlier."""
    d = _dt(ts)
    if not d:
        return "&mdash;"
    return d.strftime("%H:%M") if d.date() == target else d.strftime("%a %H:%M")


def _span(a, b) -> str:
    a, b = _dt(a), _dt(b)
    if not a or not b or b < a:
        return ""
    mins = int((b - a).total_seconds() // 60)
    return f"{mins // 60}h {mins % 60:02d}m"


def _ago(ts, target) -> str:
    d = _dt(ts)
    if not d:
        return ""
    end = datetime(target.year, target.month, target.day, 18, 0)
    mins = int((end - d).total_seconds() // 60)
    if mins < 0:
        return ""
    if mins < 60:
        return f"{mins}m ago"
    if mins < 60 * 24:
        h, m = divmod(mins, 60)
        return f"{h}h {m:02d}m ago" if m else f"{h}h ago"
    return f"{mins // (60 * 24)}d ago"


# ── one plan ─────────────────────────────────────────────────────────────────


def _plan(wo: dict, target) -> dict:
    lc = get_lifecycle(wo["name"])
    steps = {s["key"]: s for s in lc.get("steps", [])}
    order = [k for k, _ in STEPS]
    reach = 0
    for k in order:
        if steps.get(k, {}).get("status") == "done":
            reach += 1
        else:
            break

    if steps.get("completed", {}).get("status") == "done":
        state = "done"
    elif lc.get("stopped"):
        state = "stopped"
    elif lc.get("missed"):
        state = "missed"
    elif steps.get("spraying_started", {}).get("status") == "done":
        state = "spraying"
    elif steps.get("labels_printed", {}).get("status") == "done":
        state = "printed"
    elif steps.get("chemical_issued", {}).get("status") == "done":
        state = "issued"
    else:
        state = "waiting"

    sched = wo.get("custom_scheduled_application_time")
    return {
        "wo": wo["name"],
        "gh": wo.get("custom_greenhouse") or wo["name"],
        "sched": str(sched)[11:16] if sched else "&mdash;",
        "steps": steps,
        "order": order,
        "reach": reach,
        "state": state,
        "missed": bool(lc.get("missed")),
        "target": target,
    }


def _tail(p) -> str:
    """The last hand on the plan — where it stopped, and who left it there."""
    steps, order, reach, target = p["steps"], p["order"], p["reach"], p["target"]
    if p["state"] == "done":
        c, i = steps["completed"], steps["chemical_issued"]
        span = _span(i.get("timestamp"), c.get("timestamp"))
        when, who = c.get("timestamp"), c.get("actor")
        out = f'Completed {_clock(when, target)}' if when else "Completed"
        if who:
            out += f" by {who}"
        return out + (f' &nbsp;·&nbsp; {span} from issue to done' if span else "")
    if reach == 0:
        return "Not started"
    last = steps[order[reach - 1]]
    nxt = STEPS[reach][1] or "completion"
    # migrated plans can carry a step with no workflow comment behind it, so the
    # actor and the clock are simply unknown. Say less rather than print dashes.
    who, ts = last.get("actor"), last.get("timestamp")
    head = f'Stopped after {STEPS[reach - 1][1]}'
    if who and ts:
        head += f' — {who}, {_clock(ts, target)}'
    elif who:
        head += f' — {who}'
    elif ts:
        head += f' — {_clock(ts, target)}'
    ago = _ago(ts, target) if ts else ""
    return head + (f' &nbsp;·&nbsp; {ago}, waiting on {nxt}' if ago
                   else f' &nbsp;·&nbsp; waiting on {nxt}')


def _one_line(p, first) -> str:
    """A plan with nothing to read in its track, in one line.

    Two plans qualify: one that finished (seven green pills add nothing to
    "it went fine") and one nobody has touched (seven empty pills say the same
    as one empty circle). Everything in between keeps its full track.
    """
    if p["state"] == "done":
        c = p["steps"]["completed"]
        mark = badge(GREEN, GREEN, "#fff")
        span = _span(p["steps"]["chemical_issued"].get("timestamp"), c.get("timestamp"))
        when, who = c.get("timestamp"), c.get("actor")
        sub = "Completed"
        if when:
            sub = f"Completed {_clock(when, p['target'])}"
        if who:
            sub += f" by {who}"
        sub += f" &nbsp;·&nbsp; {span}" if span else ""
    else:
        a = p["steps"].get("approved", {})
        edge = RED if p["missed"] else LINE
        mark = badge(PAPER, edge, edge if p["missed"] else FAINT, mark="&nbsp;")
        sub = (f"Approved {_clock(a.get('timestamp'), p['target'])} by {a.get('actor')}"
               if a.get("actor") else "Not started")
        label = STATE_PILL[p["state"]][0]
        sub += f" &nbsp;·&nbsp; {label.lower()}" if label else ""
    return f"""
  <tr><td style="padding:{'10px' if first else '6px'} 26px 0;">
    <table role="presentation" class="plan" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{CARD};border-radius:12px;">
      <tr>
        <td width="34" style="padding:11px 0 11px 16px;">{mark}</td>
        <td style="padding:11px 8px;color:{INK};font-size:13px;font-weight:600;">{p['gh']}
          <span style="color:{FAINT};font-size:11px;font-weight:400;">&nbsp;{p['wo']}</span>
          <div style="color:{MUTED};font-size:10.5px;font-weight:400;padding-top:3px;">{sub}</div>
        </td>
        <td align="right" style="padding:11px 16px 11px 0;color:{FAINT};font-size:11px;white-space:nowrap;">{p['sched']}</td>
      </tr>
    </table>
  </td></tr>
"""


def _open_card(p, first) -> str:
    """A plan still open: the whole track, so the stall is visible."""
    cells, times = [], []
    for i, (key, name) in enumerate(STEPS):
        status = p["steps"].get(key, {}).get("status", "pending")
        last = i == len(STEPS) - 1
        pad = "0 4px 0 0" if i == 0 else ("0 0 0 6px" if last else "0 4px")
        cells.append(f'<td style="padding:{pad};">{check(status) if last else step_pill(name, status)}</td>')
        t = _clock(p["steps"].get(key, {}).get("timestamp"), p["target"]) if status == "done" else "&mdash;"
        colour = "" if status == "done" else 'style="color:#c8c4bb"'
        times.append(f'<td align="center" {colour}>{t}</td>')

    label, colour = STATE_PILL[p["state"]]
    if p["state"] == "done":
        head = badge(GREEN, GREEN, "#fff")
    elif colour:
        head = pill(label, colour, "#ffffff", size="10px", pad="4px 10px")
    else:
        head = (f'<span style="display:inline-block;background:{PAPER};color:{MUTED};'
                f'font-size:10px;font-weight:600;padding:4px 10px;border-radius:999px;'
                f'border:1px solid {LINE};">{label}</span>')

    return f"""
  <tr><td style="padding:{'10px' if first else '8px'} 26px 0;">
    <table role="presentation" class="plan" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{CARD};border-radius:12px;">
      <tr><td style="padding:14px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="color:{INK};font-size:13px;font-weight:600;">{p['gh']}
            <span style="color:{FAINT};font-size:11px;font-weight:400;">&nbsp;{p['wo']}</span></td>
          <td align="right" style="white-space:nowrap;">{head}<span style="color:{FAINT};font-size:11px;">&nbsp;&nbsp;{p['sched']}</span></td>
        </tr></table>
        <table cellpadding="0" cellspacing="0" border="0" style="margin-top:11px;">
          <tr style="font-size:9.5px;font-weight:600;">{''.join(cells)}</tr>
          <tr style="color:{MUTED};font-size:8.5px;font-weight:500;white-space:nowrap;padding-top:5px;">{''.join(times)}</tr>
        </table>
        <div style="color:{MUTED};font-size:10.5px;padding-top:9px;">{_tail(p)}</div>
      </td></tr>
    </table>
  </td></tr>
"""


# ── the whole email ──────────────────────────────────────────────────────────


def _quiet(p) -> bool:
    """A plan whose track holds nothing worth reading: finished, or never moved
    past approval."""
    return p["state"] == "done" or p["reach"] <= 2


def _body(plans: dict, collapse: bool, brief: set) -> list:
    """Farm sections. ``brief`` names work orders forced to one line by the
    byte budget even though they would otherwise carry a full track."""
    out = []
    for farm in sorted(plans):
        ps = plans[farm]
        if not ps:
            continue
        out.append(f"""
  <tr class="farm"><td style="padding:22px 26px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="color:{INK};font-size:14px;font-weight:600;letter-spacing:-0.2px;">{farm}</td>
      <td align="right"><span style="display:inline-block;background:#eceae4;color:#4a463f;font-size:10.5px;font-weight:600;padding:4px 11px;border-radius:999px;">{len(ps)} plan{'s' if len(ps) != 1 else ''} today</span></td>
    </tr></table>
  </td></tr>
""")
        # plans needing a decision tonight first, the settled ones after
        ordered = [p for p in ps if not _quiet(p)] + [p for p in ps if _quiet(p)]
        for i, p in enumerate(ordered):
            if collapse and (_quiet(p) or p["wo"] in brief):
                out.append(_one_line(p, i == 0))
            else:
                out.append(_open_card(p, i == 0))
    return out


def _compact(html: str) -> str:
    """Drop the whitespace between tags. Worth ~4%, and every byte counts against
    Gmail's 102 KB clip limit on a busy day."""
    import re
    return re.sub(r"\s{2,}", " ", re.sub(r">\s+<", "><", html)).strip()


# Gmail truncates a message over 102,400 bytes and hides the rest behind
# "View entire message". Budget below it, so a long day degrades on our terms
# rather than being cut mid-farm by the mail client.
GMAIL_CLIP = 102_400
BUDGET = 96_000

# what a plan is worth in full: act on a missed window first, then work in
# flight, then work merely waiting. Least urgent loses its track first.
URGENCY = {"missed": 4, "spraying": 3, "printed": 2, "issued": 2, "stopped": 1}


def render(farm_to_wos: dict, target, collapse_finished: bool = True,
           for_pdf: bool = False) -> str:
    plans = {f: [_plan(w, target) for w in wos] for f, wos in farm_to_wos.items()}
    flat = [p for ps in plans.values() for p in ps]
    total = len(flat) or 1
    counts = {k: sum(1 for p in flat if p["state"] == k) for k in STATE_PILL}
    missed = sum(1 for p in flat if p["missed"])

    def bar(n, colour, radius=""):
        return (f'<td width="{round(n * 100 / total)}%" bgcolor="{colour}" height="14" '
                f'style="height:14px;font-size:0;line-height:14px;{radius}">&nbsp;</td>')

    open_count = total - counts["done"]
    track = (bar(counts["done"], GREEN, "border-radius:999px 0 0 999px;")
             + bar(counts["spraying"], SLATE)
             + bar(counts["issued"] + counts["printed"], GOLD)
             + bar(counts["stopped"] + counts["missed"], ROSE)
             + bar(counts["waiting"], "#dedbd3", "border-radius:0 999px 999px 0;"))

    chips = "".join(
        f'<td style="padding:0 6px 6px 0;">{pill(t, c, "#ffffff", size="11px", pad="6px 12px")}</td>'
        for t, c in [
            (f'&#10003; {counts["done"]}', GREEN),
            (f'Spraying {counts["spraying"]}', SLATE),
            (f'Issued {counts["issued"] + counts["printed"]}', GOLD),
            (f'Stopped {counts["stopped"]}', ROSE),
        ] if not t.endswith(" 0")
    ) + (f'<td style="padding:0 0 6px 0;"><span style="display:inline-block;background:{PAPER};'
         f'color:{MUTED};font-size:11px;font-weight:600;padding:6px 12px;border-radius:999px;'
         f'border:1px solid #dedbd3;">Not started {counts["waiting"]}</span></td>')

    def assemble(brief: set) -> str:
        return "".join(_body(plans, collapse_finished, brief))

    # every plan that would carry a full track, least urgent first
    candidates = sorted(
        (p for ps in plans.values() for p in ps
         if collapse_finished and not (p["state"] == "done" or p["reach"] <= 2)),
        key=lambda p: (URGENCY.get(p["state"], 0), p["reach"]),
    )
    brief: set = set()
    body_html = assemble(brief)
    while len(body_html.encode()) > BUDGET and candidates:
        brief.add(candidates.pop(0)["wo"])
        body_html = assemble(brief)
    shortened = len(brief)

    body = [body_html]
    date_str = target.strftime("%A, %d %B %Y")
    return _compact(f"""<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch>
</o:OfficeDocumentSettings></xml><![endif]-->
<style>{"" if for_pdf else _face_block()}
  @media print {{ .plan {{ page-break-inside:avoid; }} .farm {{ page-break-after:avoid; }} }}
</style>
</head>
<body style="margin:0;padding:0;background:#e8e6e0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#e8e6e0;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:100%;background:{PAPER};border-radius:16px;overflow:hidden;font-family:{FONT};">

  <tr><td style="background:{INK};padding:22px 26px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td><div style="color:#ffffff;font-size:19px;font-weight:600;letter-spacing:-0.3px;">Chemical planning progress</div>
        <div style="color:#b8b2a7;font-size:11.5px;padding-top:3px;">{date_str} &nbsp;·&nbsp; sent 18:00</div></td>
    </tr></table>
  </td></tr>

  <tr><td style="padding:22px 26px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{CARD};border-radius:14px;">
      <tr><td style="padding:20px 20px 18px;">
        <div style="color:{MUTED};font-size:11.5px;">Finished today</div>
        <div style="color:{INK};font-size:38px;font-weight:600;letter-spacing:-1.2px;line-height:1.05;padding-top:4px;">{counts['done']}<span style="color:{FAINT};font-size:20px;font-weight:500;letter-spacing:-0.4px;"> of {len(flat)} plans</span></div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px;"><tr>{track}</tr></table>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;"><tr>{chips}</tr></table>
        <div style="color:{MUTED};font-size:11px;padding-top:6px;">{open_count} still open{f' &nbsp;·&nbsp; {missed} missed their spray window' if missed else ''}.</div>
      </td></tr>
    </table>
  </td></tr>
{''.join(body)}
  <tr><td style="padding:20px 26px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid {LINE};">
      <tr><td style="padding-top:14px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="padding:0 5px 0 0;">{badge(GREEN, GREEN, "#ffffff")}</td>
          <td style="padding:0 10px 0 5px;color:{MUTED};font-size:10.5px;">finished — one line, nothing went wrong</td>
          <td style="padding:0 5px;">{step_pill('recorded', 'done')}</td>
          <td style="padding:0 5px;">{step_pill('in progress', 'current')}</td>
          <td style="padding:0 5px;">{step_pill('pending', 'pending')}</td>
        </tr></table>
        <div style="color:{MUTED};font-size:10.5px;padding-top:10px;">
          Plans still open carry their full step track and the clock time each step was
          recorded. The line beneath names the last person to move it.
          {f'<br>{shortened} plans are listed in brief to keep this email inside your mail app&#39;s size limit — open the dashboard for their full track.' if shortened else ''}
        </div>
      </td></tr></table>
  </td></tr>

  <tr><td style="padding:16px 26px 26px;">
    <div style="color:{MUTED};font-size:11px;line-height:1.6;">
      Today's application floor plans, sent daily at 18:00 to farm managers, the
      general manager and the crop protection team.
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>
""")


def build_pdf(farm_to_wos: dict, target) -> bytes | None:
    """The whole day as a PDF — every plan with its full track, nothing collapsed.

    wkhtmltopdf ignores @font-face, so Poppins has to be installed on the server
    as a system font (``upande_scp/public/fonts/*.ttf`` → ``~/.fonts`` +
    ``fc-cache -f``); fontconfig then resolves ``font-family:Poppins`` and the
    weights embed in the file. Without that install the PDF still renders, in the
    fallback face — so a missing font degrades the look, never the send.
    """
    from frappe.utils.pdf import get_pdf

    html = render(farm_to_wos, target, collapse_finished=False, for_pdf=True)
    try:
        return get_pdf(html, options={
            "page-size": "A4",
            "margin-top": "10mm", "margin-bottom": "10mm",
            "margin-left": "0mm", "margin-right": "0mm",
        })
    except Exception:
        frappe.log_error(frappe.get_traceback(), "chemical progress email: PDF render")
        return None


@frappe.whitelist()
def preview_progress_email_v2(target_date: str | None = None, collapse: int = 1) -> str:
    """Render without sending. ``collapse=0`` keeps every plan's full track."""
    if not (set(frappe.get_roles(frappe.session.user))
            & {"SCP General Manager", "System Manager", "Administrator",
               "SCP Spray Plan Approver", "SCP Spray Plan Creator"}):
        frappe.throw("Not permitted.", frappe.PermissionError)
    target = frappe.utils.getdate(target_date) if target_date else datetime.now(EAT).date()
    return render(_group_by_farm(_wos_scheduled_on(target)), target, bool(int(collapse)))


@frappe.whitelist()
def preview_pdf(target_date: str | None = None, out: str | None = None) -> dict:
    """Render the attachment to a file and report what came out — the fonts it
    embedded included, since that is the thing that silently degrades."""
    import re

    target = frappe.utils.getdate(target_date) if target_date else datetime.now(EAT).date()
    pdf = build_pdf(_group_by_farm(_wos_scheduled_on(target)), target)
    if not pdf:
        return {"ok": False, "reason": "PDF render failed — see the error log"}
    path = out or frappe.get_site_path("public", "files", f"chemical-progress-{target}.pdf")
    with open(path, "wb") as fh:
        fh.write(pdf)
    fonts = sorted({m.decode() for m in re.findall(rb"/BaseFont\s*/([A-Za-z0-9+\-]+)", pdf)})
    return {
        "ok": True,
        "path": path,
        "bytes": len(pdf),
        "pages": pdf.count(b"/Type /Page") - pdf.count(b"/Type /Pages"),
        "fonts": fonts,
        "poppins": any("Poppins" in f for f in fonts),
    }


@frappe.whitelist()
def measure_progress_email(target_date: str | None = None) -> dict:
    """Byte sizes for a date, against Gmail's 102 KB clip limit."""
    target = frappe.utils.getdate(target_date) if target_date else datetime.now(EAT).date()
    farm_to_wos = _group_by_farm(_wos_scheduled_on(target))
    n = sum(len(v) for v in farm_to_wos.values())
    out = {"date": str(target), "plans": n, "farms": len(farm_to_wos), "limit": 102400}
    for label, collapse in (("collapsed", True), ("full", False)):
        html = render(farm_to_wos, target, collapse)
        b = len(html.encode())
        out[label] = {
            "bytes": b,
            "clipped": b > GMAIL_CLIP,
            "margin": GMAIL_CLIP - b,
            "full_tracks": html.count(">Created<"),
            "one_line": n - html.count(">Created<"),
            "shortened_for_budget": "listed in brief" in html,
        }
    return out
