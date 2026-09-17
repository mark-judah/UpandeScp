"""Render email-roses-daily.html — the 18:00 chemical-planning digest, in full.

The mockup carries the whole day (31 plans across 6 farms), not a sample, so the
length of the real email is visible before it is wired. Every field here has a
counterpart in ``send_chemical_progress_email`` / ``get_lifecycle``:

    gh, wo          Work Order.custom_greenhouse, .name
    sched           Work Order.custom_scheduled_application_time
    reach           how far ``get_lifecycle().steps`` got before the first
                    non-done step
    times, actors   step["timestamp"] and step["actor"], per step
    missed          get_lifecycle()["missed"]
    note            the postponement reason
"""
from datetime import date, datetime, timedelta

OUT = "email-roses-daily.html"
TODAY = date(2026, 9, 14)          # a Monday
ICON = "../icons/rose-light-96.png"

# ── palette ──────────────────────────────────────────────────────────────────
INK, PAPER, CARD = "#161514", "#f4f3ef", "#ffffff"
MUTED, FAINT, LINE = "#6f6a61", "#9a958c", "#e4e1d9"
ROSE, GOLD, GREEN, RED, SLATE = "#a33a5b", "#a87d0d", "#4f7a3a", "#9c3024", "#6f6a61"

STEPS = ["Created", "Approved", "Issued", "Printed", "Scanned", "Sprayed", "Done"]

# state → (reach, pill colour, pill label)
STATES = {
    "done":      (7, GREEN, "Done"),
    "spraying":  (6, SLATE, "Spraying"),
    "issued":    (3, GOLD, "Issued"),
    "postponed": (3, ROSE, "Postponed"),
    "waiting":   (2, None, "Not started"),
}

# minutes from the scheduled time at which each step lands (created/approved are
# on earlier days and carry their own clock time).
OFFSETS = {"Issued": -18, "Printed": -10, "Scanned": -4, "Sprayed": 5, "Done": 91}

STORE = "Brian Chumba"

# farm, greenhouse, work order, scheduled, state, sprayer, jitter, missed, note
PLANS = [
    ("Karen", "Karen GH 09 - KR", "05838", "06:00", "done", "Festus Muasya", 0, 0, None),
    ("Karen", "Karen GH 05 - KR", "05839", "06:00", "spraying", "Joseph Wasike", 3, 0, None),
    ("Karen", "Karen GH 03 - KR", "05840", "06:00", "postponed", None, -2, 0,
     "Moved to Wednesday 16 Sep — rain from 05:20, spray window closed"),

    ("Chepsito", "Chepsito GH 17 - KR", "05801", "05:30", "issued", None, 0, 0, None),
    ("Chepsito", "Chepsito GH 06 - KR", "05806", "05:30", "issued", None, 4, 1, None),
    ("Chepsito", "Chepsito GH 11 - KR", "05807", "05:30", "done", "Peter Kiptoo", -3, 0, None),
    ("Chepsito", "Chepsito GH 12 - KR", "05808", "06:00", "done", "Peter Kiptoo", 2, 0, None),
    ("Chepsito", "Chepsito GH 04 - KR", "05809", "06:00", "done", "Mercy Chepkoech", 6, 0, None),
    ("Chepsito", "Chepsito GH 02 - KR", "05810", "06:30", "spraying", "Mercy Chepkoech", -1, 0, None),

    ("Kapkolia", "Kapkolia GH 01 - KR", "05812", "05:30", "done", "Daniel Rotich", 1, 0, None),
    ("Kapkolia", "Kapkolia GH 02 - KR", "05813", "05:30", "done", "Daniel Rotich", 5, 0, None),
    ("Kapkolia", "Kapkolia GH 07 - KR", "05814", "06:00", "done", "Sammy Kiplagat", -4, 0, None),
    ("Kapkolia", "Kapkolia GH 08 - KR", "05815", "06:00", "postponed", None, 0, 0,
     "Moved to Tuesday 15 Sep — sprayer off sick, no relief operator"),
    ("Kapkolia", "Kapkolia GH 09 - KR", "05816", "06:30", "waiting", None, 0, 0, None),

    ("Kaptumbo", "Kaptumbo GH 03 - KR", "05820", "05:30", "done", "Grace Wanjiru", 2, 0, None),
    ("Kaptumbo", "Kaptumbo GH 05 - KR", "05821", "05:30", "done", "Grace Wanjiru", -2, 0, None),
    ("Kaptumbo", "Kaptumbo GH 06 - KR", "05822", "06:00", "done", "Julius Ruto", 7, 0, None),
    ("Kaptumbo", "Kaptumbo GH 10 - KR", "05823", "06:00", "done", "Julius Ruto", 0, 0, None),
    ("Kaptumbo", "Kaptumbo GH 14 - KR", "05824", "06:30", "spraying", "Julius Ruto", 4, 0, None),
    ("Kaptumbo", "Kaptumbo GH 15 - KR", "05825", "07:00", "issued", None, 0, 1, None),

    ("Simotwo", "Simotwo GH 02 - KR", "05828", "05:30", "done", "Abednego Mutuku", -1, 0, None),
    ("Simotwo", "Simotwo GH 04 - KR", "05829", "05:30", "done", "Abednego Mutuku", 3, 0, None),
    ("Simotwo", "Simotwo GH 08 - KR", "05830", "06:00", "done", "Abednego Mutuku", 8, 0, None),
    ("Simotwo", "Simotwo GH 09 - KR", "05831", "06:00", "waiting", None, 0, 0, None),
    ("Simotwo", "Simotwo GH 12 - KR", "05832", "06:30", "postponed", None, 0, 0,
     "Moved to Thursday 17 Sep — re-entry interval from Saturday's spray not cleared"),

    ("Torongo", "Torongo GH 05 - KR", "05844", "05:30", "done", "Joseph Wasike", 0, 0, None),
    ("Torongo", "Torongo GH 06 - KR", "05845", "05:30", "done", "Joseph Wasike", 4, 0, None),
    ("Torongo", "Torongo GH 09 - KR", "05846", "06:00", "done", "Festus Muasya", -3, 0, None),
    ("Torongo", "Torongo GH 11 - KR", "05847", "06:00", "done", "Festus Muasya", 1, 0, None),
    ("Torongo", "Torongo GH 13 - KR", "05848", "06:30", "done", "Peter Kiptoo", 6, 0, None),
    ("Torongo", "Torongo GH 16 - KR", "05849", "07:00", "spraying", "Peter Kiptoo", 2, 0, None),
]

APPROVER = {"Karen": "Julius Ruto", "Chepsito": "Julius Ruto", "Kapkolia": "Daniel Rotich",
            "Kaptumbo": "Grace Wanjiru", "Simotwo": "Abednego Mutuku", "Torongo": "Joseph Wasike"}
CREATOR = {"Karen": "Mercy Chepkoech", "Chepsito": "Mercy Chepkoech", "Kapkolia": "Sammy Kiplagat",
           "Kaptumbo": "Sammy Kiplagat", "Simotwo": "Mercy Chepkoech", "Torongo": "Sammy Kiplagat"}


# ── per-plan derivation ──────────────────────────────────────────────────────


def clock(sched: str, minutes: int) -> datetime:
    h, m = sched.split(":")
    return datetime(TODAY.year, TODAY.month, TODAY.day, int(h), int(m)) + timedelta(minutes=minutes)


def build(plan: dict) -> dict:
    """Fill in a step-by-step clock and the actor who moved each step."""
    reach, colour, label = STATES[plan["state"]]
    farm, sched, jit = plan["farm"], plan["sched"], plan["jitter"]

    created = datetime(TODAY.year, TODAY.month, TODAY.day - 2, 14, 2) + timedelta(minutes=jit * 7)
    approved = datetime(TODAY.year, TODAY.month, TODAY.day - 1, 16, 40) + timedelta(minutes=jit * 5)

    # jitter opens the spray/finish gap as well as shifting the start, so no two
    # plans report the same issue-to-done span.
    drift = {"Sprayed": jit, "Done": jit * 4}
    when = {"Created": created, "Approved": approved}
    for step, off in OFFSETS.items():
        when[step] = clock(sched, off + jit + drift.get(step, 0))

    who = {
        "Created": CREATOR[farm],
        "Approved": APPROVER[farm],
        "Issued": STORE,
        "Printed": STORE,
        "Scanned": plan["sprayer"] or APPROVER[farm],
        "Sprayed": plan["sprayer"],
        "Done": plan["sprayer"],
    }
    if plan["state"] == "postponed":
        who["Postponed"] = APPROVER[farm]

    return {**plan, "reach": reach, "colour": colour, "label": label, "when": when, "who": who}


def stamp(dt: datetime) -> str:
    """HH:MM for today, weekday-prefixed for anything earlier."""
    if dt.date() == TODAY:
        return dt.strftime("%H:%M")
    return dt.strftime("%a %H:%M")


def ago(dt: datetime) -> str:
    mins = int((datetime(TODAY.year, TODAY.month, TODAY.day, 18, 0) - dt).total_seconds() // 60)
    if mins < 60:
        return f"{mins}m ago"
    if mins < 60 * 24:
        h, m = divmod(mins, 60)
        return f"{h}h {m:02d}m ago" if m else f"{h}h ago"
    return f"{mins // (60 * 24)}d ago"


# ── HTML pieces ──────────────────────────────────────────────────────────────


def pill(text, bg, fg, border=None, weight="600", size="9.5px", pad="4px 9px"):
    edge = f"border:1.5px solid {border};padding:{pad.replace('4px', '3px', 1)};" if border else f"padding:{pad};"
    return (f'<span style="display:inline-block;background:{bg};color:{fg};font-size:{size};'
            f'font-weight:{weight};{edge}border-radius:999px;">{text}</span>')


# state -> (fill, border, glyph colour) for the seventh step, which is a mark
# rather than a word. Geometry is identical across states so the track never shifts.
CHECK = {
    "done":    (INK, INK, PAPER),
    "current": (CARD, INK, INK),
    "missed":  (CARD, RED, RED),
    "pending": (PAPER, LINE, "#c8c4bb"),
}


def badge(fill, edge, glyph, mark="&#10003;", size=19, font=12):
    """A check inside a circle, drawn as a VML oval for Outlook's Word engine
    (which squares off border-radius) and as a rounded span everywhere else."""
    return (f'<!--[if mso]><v:oval style="width:{size + 3}px;height:{size + 3}px;'
            f'v-text-anchor:middle;" fillcolor="{fill}" strokecolor="{edge}" '
            f'strokeweight="1.25pt"><v:textbox inset="0,0,0,0"><center '
            f'style="color:{glyph};font-size:{font + 1}px;font-family:Arial,sans-serif;">'
            f'{mark}</center></v:textbox></v:oval><![endif]-->'
            f'<!--[if !mso]><!--><span style="display:inline-block;width:{size}px;'
            f'height:{size}px;line-height:{size}px;text-align:center;background:{fill};'
            f'border:1.5px solid {edge};color:{glyph};font-size:{font}px;font-weight:600;'
            f'border-radius:999px;">{mark}</span><!--<![endif]-->')


def check(state):
    """The seventh step is a mark, not a word — and only a finished step earns it."""
    fill, edge, glyph = CHECK[state]
    return badge(fill, edge, glyph, mark="&#10003;" if state == "done" else "&nbsp;")


def step_pill(name, state):
    if state == "done":
        return pill(name, INK, PAPER)
    if state == "current":
        return pill(name, CARD, INK, border=INK)
    if state == "missed":
        return pill(name, CARD, RED, border=RED)
    return pill(name, PAPER, FAINT, weight="500") if False else (
        f'<span style="display:inline-block;background:{PAPER};color:{FAINT};font-size:9.5px;'
        f'font-weight:500;padding:4px 9px;border-radius:999px;border:1px solid {LINE};">{name}</span>')


def card(p, first):
    """One plan: header, the seven steps, the clock under them, the last hand on it."""
    reach, when, who = p["reach"], p["when"], p["who"]
    cells, times = [], []
    for i, name in enumerate(STEPS):
        if i < reach:
            state = "done"
        elif i == reach and p["state"] == "postponed":
            state = "pending"
        elif i == reach and p["missed"]:
            state = "missed"
        elif i == reach:
            state = "current"
        else:
            state = "pending"
        last_step = i == len(STEPS) - 1
        pad = "0 4px 0 0" if i == 0 else ("0 0 0 6px" if last_step else "0 4px")
        mark = check(state) if last_step else step_pill(name, state)
        cells.append(f'<td style="padding:{pad};">{mark}</td>')
        t = stamp(when[name]) if i < reach else "—"
        colour = MUTED if i < reach else "#c8c4bb"
        times.append(
            f'<td align="center" style="padding:5px 4px 0;color:{colour};'
            f'font-size:8.5px;font-weight:500;white-space:nowrap;">{t}</td>')

    # status pill, top right
    if p["state"] == "done":
        head = badge(GREEN, GREEN, "#ffffff")
    elif p["missed"]:
        head = pill("Missed window", RED, "#ffffff", size="10px", pad="4px 10px")
    elif p["colour"]:
        head = pill(p["label"], p["colour"], "#ffffff", size="10px", pad="4px 10px")
    else:
        head = (f'<span style="display:inline-block;background:{PAPER};color:{MUTED};font-size:10px;'
                f'font-weight:600;padding:4px 10px;border-radius:999px;border:1px solid {LINE};">'
                f'{p["label"]}</span>')

    # the last hand on the plan — where it stopped, and who left it there
    last = STEPS[reach - 1]
    if p["state"] == "done":
        span = int((when["Done"] - when["Issued"]).total_seconds() // 60)
        tail = (f'Completed {stamp(when["Done"])} by {who["Done"]} '
                f'&nbsp;·&nbsp; {span // 60}h {span % 60:02d}m from issue to done')
    elif p["state"] == "postponed":
        tail = (f'Stopped after {last} — {who[last]}, {stamp(when[last])} '
                f'&nbsp;·&nbsp; postponed by {who["Postponed"]}')
    else:
        tail = (f'Stopped after {last} — {who[last]}, {stamp(when[last])} '
                f'&nbsp;·&nbsp; {ago(when[last])}, waiting on '
                f'{"completion" if STEPS[reach] == "Done" else STEPS[reach]}')

    note = ""
    if p["note"]:
        note = (f'<div style="background:#f9eef1;border-radius:999px;display:inline-block;'
                f'padding:6px 13px;margin-top:11px;color:#8a2d4b;font-size:10.5px;font-weight:500;">'
                f'{p["note"]}</div>')

    return f"""
  <tr><td style="padding:{'10px' if first else '8px'} 26px 0;">
    <table role="presentation" class="plan" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{CARD};border-radius:12px;">
      <tr><td style="padding:14px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="color:{INK};font-size:13px;font-weight:600;">{p['gh']}
            <span style="color:{FAINT};font-size:11px;font-weight:400;">&nbsp;MFG-WO-2026-{p['wo']}</span>
          </td>
          <td align="right" style="white-space:nowrap;">
            {head}<span style="color:{FAINT};font-size:11px;">&nbsp;&nbsp;{p['sched']}</span>
          </td>
        </tr></table>

        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:11px;">
          <tr>{''.join(cells)}</tr>
          <tr>{''.join(times)}</tr>
        </table>
        {note}
        <div style="color:{MUTED};font-size:10.5px;padding-top:9px;">{tail}</div>
      </td></tr>
    </table>
  </td></tr>
"""


def farm_head(farm, n):
    return f"""
  <tr class="farm"><td style="padding:22px 26px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="color:{INK};font-size:14px;font-weight:600;letter-spacing:-0.2px;">{farm}</td>
        <td align="right"><span style="display:inline-block;background:#eceae4;color:#4a463f;font-size:10.5px;font-weight:600;padding:4px 11px;border-radius:999px;">{n} plan{'s' if n != 1 else ''} today</span></td>
      </tr>
    </table>
  </td></tr>
"""


# ── assemble ─────────────────────────────────────────────────────────────────

keys = ("farm", "gh", "wo", "sched", "state", "sprayer", "jitter", "missed", "note")
plans = [build(dict(zip(keys, row))) for row in PLANS]

order = ["Karen", "Chepsito", "Kapkolia", "Kaptumbo", "Simotwo", "Torongo"]
by_farm = {f: [p for p in plans if p["farm"] == f] for f in order}

total = len(plans)
counts = {s: sum(1 for p in plans if p["state"] == s) for s in STATES}
missed = sum(1 for p in plans if p["missed"])
date_str = TODAY.strftime("%A, %d %B %Y")

body = "".join(
    farm_head(f, len(by_farm[f])) + "".join(card(p, i == 0) for i, p in enumerate(by_farm[f]))
    for f in order
)


def bar(width, colour, radius=""):
    return (f'<td width="{width}%" bgcolor="{colour}" height="14" '
            f'style="height:14px;font-size:0;line-height:14px;{radius}">&nbsp;</td>')


def pct(n):
    return round(n * 100 / total)


summary_bar = (
    bar(pct(counts["done"]), GREEN, "border-radius:999px 0 0 999px;")
    + bar(pct(counts["spraying"]), SLATE)
    + bar(pct(counts["issued"]), GOLD)
    + bar(pct(counts["postponed"]), ROSE)
    + bar(pct(counts["waiting"]), "#dedbd3", "border-radius:0 999px 999px 0;")
)

summary_pills = "".join(
    f'<td style="padding:0 6px 6px 0;">{pill(text, bg, "#ffffff", size="11px", pad="6px 12px")}</td>'
    for text, bg in [
        (f'&#10003; {counts["done"]}', GREEN),
        (f'Spraying {counts["spraying"]}', SLATE),
        (f'Issued {counts["issued"]}', GOLD),
        (f'Postponed {counts["postponed"]}', ROSE),
    ]
) + (
    f'<td style="padding:0 0 6px 0;"><span style="display:inline-block;background:{PAPER};'
    f'color:{MUTED};font-size:11px;font-weight:600;padding:6px 12px;border-radius:999px;'
    f'border:1px solid #dedbd3;">Not started {counts["waiting"]}</span></td>'
)

html = f"""<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch>
</o:OfficeDocumentSettings></xml><![endif]-->
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chemical planning progress · Roses · {TODAY.strftime('%A %d %B')}</title>
<style>
  @font-face{{font-family:Poppins;src:url('fonts/poppins-400.woff2') format('woff2');font-weight:400;font-display:swap;}}
  @font-face{{font-family:Poppins;src:url('fonts/poppins-500.woff2') format('woff2');font-weight:500;font-display:swap;}}
  @font-face{{font-family:Poppins;src:url('fonts/poppins-600.woff2') format('woff2');font-weight:600;font-display:swap;}}
  @font-face{{font-family:Poppins;src:url('fonts/poppins-700.woff2') format('woff2');font-weight:700;font-display:swap;}}
  @media print {{
    .plan {{ page-break-inside:avoid; break-inside:avoid; }}
    .farm {{ page-break-after:avoid; break-after:avoid; }}
  }}
</style>
</head>
<body style="margin:0;padding:0;background:#e8e6e0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#e8e6e0;">
<tr><td align="center" style="padding:24px 12px;">

<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:100%;background:{PAPER};border-radius:16px;overflow:hidden;font-family:Poppins,'Segoe UI',system-ui,-apple-system,sans-serif;">

  <tr><td style="background:{INK};padding:0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td height="4" style="height:4px;line-height:4px;font-size:0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td width="25%" bgcolor="#a87d0d" style="font-size:0;line-height:4px;">&nbsp;</td>
          <td width="25%" bgcolor="#bf951a" style="font-size:0;line-height:4px;">&nbsp;</td>
          <td width="25%" bgcolor="#d6ab28" style="font-size:0;line-height:4px;">&nbsp;</td>
          <td width="25%" bgcolor="#edc23c" style="font-size:0;line-height:4px;">&nbsp;</td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:22px 26px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="color:{PAPER};font-size:18px;font-weight:600;letter-spacing:-0.3px;">
            Chemical planning progress
            <div style="color:#8f8a80;font-size:12px;font-weight:400;padding-top:4px;">
              {date_str} · sent 18:00
            </div>
          </td>
          <td align="right" valign="top" width="46">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td width="46" height="46" align="center" valign="middle" bgcolor="{ROSE}" style="width:46px;height:46px;border-radius:999px;">
                <img src="{ICON}" width="28" height="28" alt="Roses" style="display:block;border:0;">
              </td>
            </tr></table>
          </td>
        </tr></table>
      </td></tr>
    </table>
  </td></tr>

  <!-- The day in one line, then every plan below it. -->
  <tr><td style="padding:22px 26px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{CARD};border-radius:14px;">
      <tr><td style="padding:20px 20px 18px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td valign="bottom">
            <div style="color:{MUTED};font-size:11.5px;">Finished today</div>
            <div style="color:{INK};font-size:38px;font-weight:600;letter-spacing:-1.2px;line-height:1.05;padding-top:4px;">{counts['done']}<span style="color:{FAINT};font-size:20px;font-weight:500;letter-spacing:-0.4px;"> of {total} plans</span></div>
          </td>
          <td align="right" valign="bottom">
            <span style="display:inline-block;background:#f6efd7;color:#8a6608;font-size:11.5px;font-weight:600;padding:7px 14px;border-radius:999px;">{len(order)} farms scheduled</span>
          </td>
        </tr></table>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px;">
          <tr>{summary_bar}</tr>
        </table>

        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;">
          <tr>{summary_pills}</tr>
        </table>

        <div style="color:{MUTED};font-size:11px;padding-top:6px;">{missed} plans reached the floor but missed their spray window.</div>
      </td></tr>
    </table>
  </td></tr>
{body}
  <!-- Legend, kept because the pills carry the whole story. -->
  <tr><td style="padding:20px 26px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid {LINE};">
      <tr><td style="padding-top:14px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="padding:0 5px 0 0;">{check('done')}</td>
          <td style="padding:0 10px 0 5px;color:{MUTED};font-size:10.5px;">finished</td>
          <td style="padding:0 5px;">{step_pill('recorded', 'done')}</td>
          <td style="padding:0 5px;">{step_pill('in progress', 'current')}</td>
          <td style="padding:0 5px;">{step_pill('pending', 'pending')}</td>
          <td style="padding:0 5px;">{step_pill('missed', 'missed')}</td>
          <td style="padding:0 0 0 5px;">{pill('postponed', ROSE, '#ffffff')}</td>
        </tr></table>
        <div style="color:{MUTED};font-size:10.5px;padding-top:10px;">
          The time under each step is when it was recorded. The line beneath every
          plan names the last person to move it and how long it has sat there.
        </div>
      </td></tr></table>
  </td></tr>

  <tr><td style="padding:16px 26px 26px;">
    <div style="color:{MUTED};font-size:11px;line-height:1.6;">
      Today's application floor plans, sent daily at 18:00 to farm managers, the
      general manager and the crop protection team.
      <a href="#" style="color:{INK};text-decoration:underline;">Open the dashboard</a>
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>
"""

with open(OUT, "w") as fh:
    fh.write(html)
print(f"{OUT}: {total} plans, {len(order)} farms, {counts}, missed={missed}")
