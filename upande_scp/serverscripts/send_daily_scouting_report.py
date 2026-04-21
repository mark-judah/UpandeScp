"""
send_daily_scouting_report.py
==============================
Daily Scouting & Crop Protection summary.

Exposes:
- build_html(target_date=None)             : pure HTML builder (email + PDF)
- send_daily_scouting_report()             : scheduler entry point
- trigger_daily_email()   [whitelisted]    : "Send now" button handler
- download_daily_pdf()    [whitelisted]    : PDF download handler

Hook in hooks.py:
    scheduler_events = {"cron": {"0 14 * * *": [
        "upande_scp.serverscripts.send_daily_scouting_report.send_daily_scouting_report"
    ]}}
"""

import frappe
from frappe.utils.pdf import get_pdf


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _safe_int(val):
    try:
        return int(val)
    except Exception:
        return 0


def _get_full_name(owner):
    try:
        fn = frappe.db.get_value("User", owner, "full_name")
        return fn or owner
    except Exception:
        return owner


CHILD_TABLES = [
    ("Pests Scouting Entry",           "Pest Observations"),
    ("Diseases Scouting Entry",        "Disease Observations"),
    ("Weeds Scouting Entry",           "Weed Observations"),
    ("Incidents Scouting Entry",       "Incident Observations"),
    ("Predators Scouting Entry",       "Predator Observations"),
    ("Trap Scouting Entry",            "Trap Observations"),
    ("Crop Husbandry Practices Entry", "Crop Husbandry Practices"),
]
OBS_LABELS = [label for (_, label) in CHILD_TABLES]

OBS_DESCRIPTIONS = {
    "Pest Observations":        "Insects/bugs found on plants (e.g. spider mites, thrips, aphids)",
    "Disease Observations":     "Fungal/bacterial/viral infections spotted (e.g. botrytis, powdery mildew)",
    "Weed Observations":        "Weeds found growing in or around greenhouse beds",
    "Incident Observations":    "Unusual events not in other categories (e.g. broken irrigation, physical damage)",
    "Predator Observations":    "Beneficial insects found that naturally eat pests (e.g. ladybirds, predatory mites)",
    "Trap Observations":        "Counts from sticky/pheromone traps placed to monitor pest populations",
    "Crop Husbandry Practices": "Physical plant condition notes (e.g. dry leaves, open buds)",
}


# ---------------------------------------------------------------------------
# Data collection
# ---------------------------------------------------------------------------

def _collect(target_date):
    """Run all SQL queries for the given day. Returns a dict used by build_html."""
    scout_entry_count = 0
    scout_entries_by_user = {}
    try:
        rows = frappe.db.sql(
            "SELECT owner, COUNT(*) AS total FROM `tabScouting Entry` "
            "WHERE owner != 'Administrator' AND (DATE(creation)=%s OR date_of_capture=%s) "
            "GROUP BY owner",
            (target_date, target_date),
            as_dict=True,
        )
        for row in rows:
            fname = _get_full_name(row["owner"])
            cnt = _safe_int(row["total"])
            scout_entries_by_user[fname] = scout_entries_by_user.get(fname, 0) + cnt
            scout_entry_count += cnt
    except Exception as e:
        frappe.log_error("daily scouting: entry count error: " + str(e))

    child_counts_total = {}
    child_counts_by_user = {}
    for (child_tab, label) in CHILD_TABLES:
        try:
            res = frappe.db.sql(
                "SELECT COUNT(ct.name) FROM `tab" + child_tab + "` ct "
                "JOIN `tabScouting Entry` se ON se.name=ct.parent "
                "WHERE se.owner!='Administrator' AND (DATE(se.creation)=%s OR se.date_of_capture=%s)",
                (target_date, target_date),
            )
            child_counts_total[label] = _safe_int(res[0][0]) if res else 0
        except Exception as e:
            frappe.log_error("daily scouting: obs total " + child_tab + ": " + str(e))
            child_counts_total[label] = 0

        try:
            rows = frappe.db.sql(
                "SELECT se.owner, COUNT(ct.name) AS total FROM `tab" + child_tab + "` ct "
                "JOIN `tabScouting Entry` se ON se.name=ct.parent "
                "WHERE se.owner!='Administrator' AND (DATE(se.creation)=%s OR se.date_of_capture=%s) "
                "GROUP BY se.owner",
                (target_date, target_date),
                as_dict=True,
            )
            for row in rows:
                fname = _get_full_name(row["owner"])
                if fname not in child_counts_by_user:
                    child_counts_by_user[fname] = {lbl: 0 for lbl in OBS_LABELS}
                child_counts_by_user[fname][label] = _safe_int(row["total"])
        except Exception as e:
            frappe.log_error("daily scouting: obs by user " + child_tab + ": " + str(e))

    obs_grand_total = sum(child_counts_total.values())

    # Spray plans (Work Order, custom_type='Application Floor Plan')
    spray_plans_by_user = {}
    spray_plans_by_state = {"Draft": 0, "Approved": 0, "Other": 0}
    try:
        rows = frappe.db.sql(
            "SELECT owner, workflow_state, COUNT(*) AS total FROM `tabWork Order` "
            "WHERE custom_type='Application Floor Plan' AND DATE(creation)=%s "
            "GROUP BY owner, workflow_state",
            (target_date,),
            as_dict=True,
        )
        for row in rows:
            fname = _get_full_name(row["owner"])
            cnt = _safe_int(row["total"])
            spray_plans_by_user[fname] = spray_plans_by_user.get(fname, 0) + cnt
            state = row["workflow_state"] or "Other"
            if state in spray_plans_by_state:
                spray_plans_by_state[state] += cnt
            else:
                spray_plans_by_state["Other"] += cnt
    except Exception as e:
        frappe.log_error("daily scouting: spray plan count: " + str(e))

    spray_plan_details = []
    try:
        spray_plan_details = frappe.db.sql(
            "SELECT name, owner, workflow_state, custom_greenhouse, custom_scope, "
            "custom_scope_details, custom_targets, custom_spray_team, custom_kit, "
            "custom_water_volume, custom_area "
            "FROM `tabWork Order` WHERE custom_type='Application Floor Plan' "
            "AND DATE(creation)=%s ORDER BY creation ASC",
            (target_date,),
            as_dict=True,
        )
    except Exception as e:
        frappe.log_error("daily scouting: spray plan details: " + str(e))

    return {
        "scout_entry_count": scout_entry_count,
        "scout_entries_by_user": scout_entries_by_user,
        "child_counts_total": child_counts_total,
        "child_counts_by_user": child_counts_by_user,
        "obs_grand_total": obs_grand_total,
        "spray_plans_by_user": spray_plans_by_user,
        "spray_plans_by_state": spray_plans_by_state,
        "spray_plan_details": spray_plan_details,
    }


# ---------------------------------------------------------------------------
# HTML builder
# ---------------------------------------------------------------------------

# Shared styles
THL    = 'style="background-color:#0D2B5E;color:#fff;padding:9px 12px;font-size:12px;font-weight:600;text-transform:uppercase;border:1px solid #0D2B5E;text-align:left;"'
THC    = 'style="background-color:#0D2B5E;color:#fff;padding:9px 12px;font-size:12px;font-weight:600;text-transform:uppercase;border:1px solid #0D2B5E;text-align:center;"'
TDL    = 'style="padding:8px 12px;border-bottom:1px solid #e8e8e8;font-size:13px;color:#222;text-align:left;"'
TDC    = 'style="padding:8px 12px;border-bottom:1px solid #e8e8e8;font-size:13px;color:#222;text-align:center;"'
TDBOLD = 'style="padding:8px 12px;border-bottom:1px solid #e8e8e8;font-size:13px;color:#222;text-align:center;font-weight:700;"'
TFL    = 'style="background-color:#0D2B5E;color:#fff;padding:9px 12px;font-size:13px;font-weight:700;text-align:left;"'
TFC    = 'style="background-color:#0D2B5E;color:#fff;padding:9px 12px;font-size:13px;font-weight:700;text-align:center;"'
TABLE  = 'style="width:100%;border-collapse:collapse;font-size:13px;margin:0 0 20px 0;"'
HDR    = 'style="font-size:15px;font-weight:700;color:#0D2B5E;margin:24px 0 8px 0;padding-bottom:5px;border-bottom:2px solid #0D2B5E;"'
SUBHDR = 'style="font-size:13px;font-weight:600;color:#0D2B5E;margin:16px 0 6px 0;padding-left:4px;border-left:3px solid #0D2B5E;"'


def build_html(target_date=None):
    """Build the full HTML body for the daily report. Used by both email and PDF."""
    today = frappe.utils.getdate(target_date) if target_date else frappe.utils.getdate()
    target = frappe.utils.formatdate(today, "yyyy-MM-dd")
    subject_date = frappe.utils.formatdate(today, "dd-MMM-yyyy")
    pretty_date = frappe.utils.formatdate(today, "dd MMMM yyyy")
    current_time = str(frappe.utils.now()).split(".")[0]

    d = _collect(target)

    # --- SECTION 1: Daily Summary ---
    section1 = (
        '<div ' + HDR + '>Daily Summary</div>'
        '<table ' + TABLE + '>'
        '<tr><th ' + THL + '>Metric</th><th ' + THC + '>TODAY</th></tr>'
        '<tr><td ' + TDL + '>Scouting Entries Submitted</td><td ' + TDC + '>' + str(d["scout_entry_count"]) + '</td></tr>'
        '<tr><td ' + TDL + '>Total Field Observations Recorded</td><td ' + TDC + '>' + str(d["obs_grand_total"]) + '</td></tr>'
        '<tr><td ' + TDL + '>Spray Plans Created (Draft)</td><td ' + TDC + '>' + str(d["spray_plans_by_state"]["Draft"]) + '</td></tr>'
        '<tr><td ' + TDL + '>Spray Plans Created (Approved)</td><td ' + TDC + '>' + str(d["spray_plans_by_state"]["Approved"]) + '</td></tr>'
        '</table>'
    )

    # --- SECTION 2: Observation Breakdown ---
    s2 = [
        '<div ' + HDR + '>Scouting - Observation Breakdown by Type</div>',
        '<table ' + TABLE + '>',
        '<tr><th ' + THL + '>Observation Type</th><th ' + THC + '>What It Means</th><th ' + THC + '>Rows Recorded Today</th></tr>',
    ]
    for (_, label) in CHILD_TABLES:
        c = d["child_counts_total"].get(label, 0)
        desc = OBS_DESCRIPTIONS.get(label, "")
        if label == "Crop Husbandry Practices":
            s2.append(
                '<tr><td style="padding:8px 12px;border-bottom:1px solid #e8e8e8;border-top:2px solid #c8d8f0;font-size:13px;color:#0D2B5E;text-align:left;font-style:italic;">'
                + label + '</td><td style="padding:8px 12px;border-bottom:1px solid #e8e8e8;border-top:2px solid #c8d8f0;font-size:12px;color:#555;text-align:left;font-style:italic;">'
                + desc + '</td><td ' + TDC + '>' + str(c) + '</td></tr>'
            )
        else:
            s2.append(
                '<tr><td ' + TDL + '>' + label + '</td><td style="padding:8px 12px;border-bottom:1px solid #e8e8e8;font-size:12px;color:#555;text-align:left;">'
                + desc + '</td><td ' + TDC + '>' + str(c) + '</td></tr>'
            )
    s2.append('<tr><td ' + TFL + '>TOTAL OBSERVATIONS</td><td ' + TFC + '></td><td ' + TFC + '>' + str(d["obs_grand_total"]) + '</td></tr>')
    s2.append('</table>')
    section2 = "".join(s2)

    # --- SECTION 3: Activity by User ---
    all_users = sorted(set(list(d["scout_entries_by_user"].keys()) + list(d["child_counts_by_user"].keys())))
    short_labels = ["Pest", "Disease", "Weed", "Incident", "Predator", "Trap", "CHP"]

    s3 = [
        '<div ' + HDR + '>Scouting - Daily Activity by User</div>',
        '<table ' + TABLE + '>',
        '<tr><th ' + THL + '>User</th><th ' + THC + '>Entries</th>',
    ]
    for lbl in short_labels:
        s3.append('<th ' + THC + '>' + lbl + '</th>')
    s3.append('<th ' + THC + '>Total Obs</th></tr>')

    if not all_users:
        s3.append('<tr><td ' + TDL + ' colspan="' + str(len(short_labels) + 3) + '" style="text-align:center;color:#777;font-style:italic;">No scouting activity today.</td></tr>')
    else:
        col_totals_entries = 0
        col_totals_obs = {lbl: 0 for lbl in OBS_LABELS}
        grand_obs_total = 0
        for fname in all_users:
            entries = d["scout_entries_by_user"].get(fname, 0)
            col_totals_entries += entries
            row_obs_total = 0
            s3.append('<tr><td ' + TDL + '><b>' + fname + '</b></td><td ' + TDC + '>' + str(entries) + '</td>')
            for lbl in OBS_LABELS:
                c = d["child_counts_by_user"].get(fname, {}).get(lbl, 0)
                col_totals_obs[lbl] += c
                row_obs_total += c
                s3.append('<td ' + TDC + '>' + str(c) + '</td>')
            grand_obs_total += row_obs_total
            s3.append('<td ' + TDBOLD + '>' + str(row_obs_total) + '</td></tr>')
        s3.append('<tr><td ' + TFL + '>TOTAL</td><td ' + TFC + '>' + str(col_totals_entries) + '</td>')
        for lbl in OBS_LABELS:
            s3.append('<td ' + TFC + '>' + str(col_totals_obs[lbl]) + '</td>')
        s3.append('<td ' + TFC + '>' + str(grand_obs_total) + '</td></tr>')
    s3.append('</table>')
    s3.append(
        '<p style="font-size:11px;color:#999;margin:0 0 16px 0;">Column key: '
        'Pest = Pest Observations &nbsp;|&nbsp; Disease = Disease Observations &nbsp;|&nbsp; '
        'Weed = Weed Observations &nbsp;|&nbsp; Incident = Incident Observations &nbsp;|&nbsp; '
        'Predator = Predator Observations &nbsp;|&nbsp; Trap = Trap Observations &nbsp;|&nbsp; '
        'CHP = Crop Husbandry Practices</p>'
    )
    section3 = "".join(s3)

    # --- SECTION 4: Spray Plans ---
    s4 = ['<div ' + HDR + '>Crop Protection - Spray Plans Created Today</div>']
    if not d["spray_plan_details"]:
        s4.append('<p style="color:#777;font-size:13px;font-style:italic;">No spray plans created today.</p>')
    else:
        s4.append('<div ' + SUBHDR + '>By User</div>')
        s4.append('<table ' + TABLE + '>')
        s4.append('<tr><th ' + THL + '>User</th><th ' + THC + '>Spray Plans</th></tr>')
        sp_grand = 0
        for fname in sorted(d["spray_plans_by_user"].keys()):
            v = d["spray_plans_by_user"][fname]
            sp_grand += v
            s4.append('<tr><td ' + TDL + '><b>' + fname + '</b></td><td ' + TDBOLD + '>' + str(v) + '</td></tr>')
        s4.append('<tr><td ' + TFL + '>TOTAL</td><td ' + TFC + '>' + str(sp_grand) + '</td></tr>')
        s4.append('</table>')

        s4.append('<div ' + SUBHDR + '>Plan Details</div>')
        s4.append('<table ' + TABLE + '>')
        s4.append(
            '<tr>'
            '<th ' + THC + '>Ref</th>'
            '<th ' + THL + '>Greenhouse</th>'
            '<th ' + THL + '>Scope</th>'
            '<th ' + THL + '>Targets (Pests/Diseases)</th>'
            '<th ' + THL + '>Kit</th>'
            '<th ' + THC + '>Water Vol (L)</th>'
            '<th ' + THC + '>Area (Ha)</th>'
            '<th ' + THL + '>Spray Team</th>'
            '<th ' + THC + '>Status</th>'
            '</tr>'
        )
        for plan in d["spray_plan_details"]:
            targets = (plan.get("custom_targets") or "").replace("\n", ", ")
            scope = plan.get("custom_scope") or ""
            scope_det = plan.get("custom_scope_details") or ""
            scope_str = scope + ((" (" + scope_det + ")") if scope_det else "")
            state = plan.get("workflow_state") or "Draft"
            state_color = "#27ae60" if state == "Approved" else "#e67e22"
            s4.append(
                '<tr>'
                '<td ' + TDC + '>' + (plan.get("name") or "") + '</td>'
                '<td ' + TDL + '>' + (plan.get("custom_greenhouse") or "") + '</td>'
                '<td ' + TDL + '>' + scope_str + '</td>'
                '<td ' + TDL + '>' + targets + '</td>'
                '<td ' + TDC + '>' + (plan.get("custom_kit") or "") + '</td>'
                '<td ' + TDC + '>' + str(plan.get("custom_water_volume") or 0) + '</td>'
                '<td ' + TDC + '>' + str(plan.get("custom_area") or 0) + '</td>'
                '<td ' + TDL + '>' + (plan.get("custom_spray_team") or "") + '</td>'
                '<td style="padding:8px 12px;border-bottom:1px solid #e8e8e8;font-size:13px;text-align:center;font-weight:600;color:' + state_color + ';">' + state + '</td>'
                '</tr>'
            )
        s4.append('</table>')
    section4 = "".join(s4)

    # Assemble
    toc = (
        '<table style="width:100%;border-collapse:collapse;margin:0 0 24px 0;">'
        '<tr><td style="background-color:#f4f6fb;border-left:4px solid #0D2B5E;padding:14px 20px;border-radius:4px;">'
        '<div style="font-size:13px;font-weight:700;color:#0D2B5E;margin-bottom:8px;">Report Sections</div>'
        '<div style="font-size:12px;color:#1A3A6B;margin-bottom:3px;">1. Daily Summary</div>'
        '<div style="font-size:12px;color:#1A3A6B;margin-bottom:3px;">2. Scouting - Observation Breakdown by Type</div>'
        '<div style="font-size:12px;color:#1A3A6B;margin-bottom:3px;">3. Scouting - Daily Activity by User</div>'
        '<div style="font-size:12px;color:#1A3A6B;margin-bottom:3px;">4. Crop Protection - Spray Plans</div>'
        '</td></tr></table>'
    )

    return (
        '<div style="max-width:960px;margin:0 auto;padding:20px;background:#ffffff;font-family:Arial,sans-serif;">'
        '<table style="width:100%;border-collapse:collapse;margin:0 0 20px 0;">'
        '<tr><td style="background-color:#0D2B5E;padding:22px 28px;border-radius:6px;">'
        '<div style="font-size:20px;font-weight:700;color:#ffffff;margin-bottom:4px;">Scouting &amp; Crop Protection - Daily Summary</div>'
        '<div style="font-size:13px;color:#c8d8f0;">' + pretty_date + '</div>'
        '</td></tr></table>'
        '<p style="font-size:14px;color:#333;margin:0 0 20px 0;">Hi Team,<br><br>'
        'Please find below the daily scouting and crop protection summary for <strong>' + subject_date + '</strong>.<br>'
        'This report covers field scouting observations recorded by scouts and spray plans created by the crop protection team.</p>'
        + toc
        + section1
        + section2
        + section3
        + section4
        + '<table style="width:100%;border-collapse:collapse;margin:30px 0 0 0;">'
        '<tr><td style="border-top:1px solid #e0e0e0;padding-top:16px;font-size:12px;color:#999;">'
        'Report generated on ' + current_time + '<br>Regards,<br>Upande'
        '</td></tr></table>'
        '</div>'
    )


# ---------------------------------------------------------------------------
# Recipients
# ---------------------------------------------------------------------------

def _recipients():
    default = ["stephene@upande.com"]
    try:
        s = frappe.get_single("Trap Report Settings")
        raw = getattr(s, "daily_report_recipients", None) or ""
        raw = raw.strip()
        if raw:
            return [r.strip() for r in raw.split(",") if r.strip()]
    except Exception:
        pass
    return default


# ---------------------------------------------------------------------------
# Public callables
# ---------------------------------------------------------------------------

def send_daily_scouting_report():
    """Scheduler entry point — builds and sends the daily email."""
    today = frappe.utils.getdate()
    subject_date = frappe.utils.formatdate(today, "dd-MMM-yyyy")
    html = build_html()
    frappe.sendmail(
        recipients=_recipients(),
        subject="Scouting & Crop Protection: Daily Summary (" + subject_date + ")",
        message=html,
    )


@frappe.whitelist()
def trigger_daily_email():
    send_daily_scouting_report()
    return {"ok": True, "recipients": _recipients()}


@frappe.whitelist()
def download_daily_pdf():
    today = frappe.utils.getdate()
    date_str = frappe.utils.formatdate(today, "yyyy-MM-dd")
    html = build_html()
    pdf_bytes = get_pdf(html)
    frappe.local.response.filename = "daily_scouting_" + date_str + ".pdf"
    frappe.local.response.filecontent = pdf_bytes
    frappe.local.response.type = "download"
