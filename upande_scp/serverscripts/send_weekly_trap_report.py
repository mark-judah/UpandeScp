"""
send_weekly_trap_report.py
===========================
Weekly Trap Scouting Report (full-year aggregates + last-2-weeks deep dive).

Exposes:
- build_html()                           : pure HTML builder (email + PDF)
- send_weekly_trap_report()              : scheduler entry point
- trigger_weekly_email()  [whitelisted]  : "Send now" button handler
- download_weekly_pdf()   [whitelisted]  : PDF download handler

Hook in hooks.py:
    scheduler_events = {"cron": {"0 5 * * 1": [
        "upande_scp.serverscripts.send_weekly_trap_report.send_weekly_trap_report"
    ]}}
"""

import frappe
from frappe.utils.pdf import get_pdf


HIGH_COUNT_THRESHOLD = 10
TARGET_PESTS = ["FCM", "Spodoptera", "Helicoverpa", "Duponchella"]

# Styles
THL    = 'style="background-color:#0D2B5E;color:#fff;padding:9px 12px;font-size:12px;font-weight:600;text-transform:uppercase;border:1px solid #0D2B5E;text-align:left;"'
THC    = 'style="background-color:#0D2B5E;color:#fff;padding:9px 12px;font-size:12px;font-weight:600;text-transform:uppercase;border:1px solid #0D2B5E;text-align:center;"'
THR    = 'style="background-color:#0D2B5E;color:#fff;padding:9px 12px;font-size:12px;font-weight:600;text-transform:uppercase;border:1px solid #0D2B5E;text-align:right;"'
TDL    = 'style="padding:8px 12px;border-bottom:1px solid #e8e8e8;font-size:13px;color:#222;text-align:left;"'
TDC    = 'style="padding:8px 12px;border-bottom:1px solid #e8e8e8;font-size:13px;color:#222;text-align:center;"'
TDR    = 'style="padding:8px 12px;border-bottom:1px solid #e8e8e8;font-size:13px;color:#222;text-align:right;"'
TDBOLD = 'style="padding:8px 12px;border-bottom:1px solid #e8e8e8;font-size:13px;color:#222;text-align:center;font-weight:700;"'
TFL    = 'style="background-color:#0D2B5E;color:#fff;padding:9px 12px;font-size:13px;font-weight:700;text-align:left;"'
TFC    = 'style="background-color:#0D2B5E;color:#fff;padding:9px 12px;font-size:13px;font-weight:700;text-align:center;"'
TABLE  = 'style="width:100%;border-collapse:collapse;font-size:13px;margin:0 0 20px 0;"'
HDR    = 'style="font-size:15px;font-weight:700;color:#0D2B5E;margin:24px 0 8px 0;padding-bottom:5px;border-bottom:2px solid #0D2B5E;"'
SUBHDR = 'style="font-size:13px;font-weight:600;color:#0D2B5E;margin:16px 0 6px 0;padding-left:4px;border-left:3px solid #0D2B5E;"'
MONO   = 'style="font-family:monospace;font-size:12px;"'


def _safe_int(val):
    try:
        return int(val)
    except Exception:
        return 0


def _format_with_sign(num):
    return ("+" + str(num)) if num >= 0 else str(num)


def _format_percent(pct):
    pct_str = str(round(pct * 10) / 10.0)
    if "." in pct_str:
        parts = pct_str.split(".")
        pct_str = parts[0] + "." + (parts[1][:1] if len(parts[1]) > 1 else parts[1] + "0")
    else:
        pct_str = pct_str + ".0"
    return pct_str + "%"


def _week_range_strings():
    today = frappe.utils.getdate()
    weekday = today.weekday()
    last_week_start = frappe.utils.add_days(today, -7 - weekday)
    last_week_end = frappe.utils.add_days(last_week_start, 6)
    two_weeks_ago_start = frappe.utils.add_days(last_week_start, -7)
    two_weeks_ago_end = frappe.utils.add_days(last_week_start, -1)

    week_range = (
        frappe.utils.formatdate(last_week_start, "dd MMM") + " - "
        + frappe.utils.formatdate(last_week_end, "dd MMM yyyy")
    )
    prev_week_range = (
        frappe.utils.formatdate(two_weeks_ago_start, "dd MMM") + " - "
        + frappe.utils.formatdate(two_weeks_ago_end, "dd MMM yyyy")
    )

    return {
        "today": today,
        "current_year": today.year,
        "last_week_start": last_week_start,
        "last_week_end": last_week_end,
        "two_weeks_ago_start": two_weeks_ago_start,
        "two_weeks_ago_end": two_weeks_ago_end,
        "week_range": week_range,
        "prev_week_range": prev_week_range,
    }


def _collect(wk):
    """Run all SQL queries. Returns a dict of aggregated data."""
    current_year = wk["current_year"]
    last_week_start = wk["last_week_start"]
    last_week_end = wk["last_week_end"]
    two_weeks_ago_start = wk["two_weeks_ago_start"]
    two_weeks_ago_end = wk["two_weeks_ago_end"]

    weekly_summary = frappe.db.sql(
        """
        SELECT
            WEEK(se.date_of_capture, 1) AS week_number,
            MIN(se.date_of_capture) AS week_start,
            MAX(se.date_of_capture) AS week_end,
            COUNT(DISTINCT tse.parent) AS scouting_entries,
            COUNT(*) AS total_observations,
            SUM(tse.count) AS total_caught
        FROM `tabTrap Scouting Entry` tse
        JOIN `tabScouting Entry` se ON se.name = tse.parent
        WHERE YEAR(se.date_of_capture) = %s
        GROUP BY WEEK(se.date_of_capture, 1)
        ORDER BY week_number
        """,
        (current_year,),
        as_dict=True,
    )

    pests = frappe.db.sql(
        """
        SELECT DISTINCT pest FROM `tabTrap Scouting Entry`
        WHERE pest IS NOT NULL AND pest != '' ORDER BY pest
        """,
        as_dict=True,
    )
    pest_list = [p.pest for p in pests]

    weekly_pest = frappe.db.sql(
        """
        SELECT
            WEEK(se.date_of_capture, 1) AS week_number,
            MIN(se.date_of_capture) AS week_start,
            tse.pest,
            COUNT(*) AS observations,
            SUM(tse.count) AS total_caught,
            MAX(tse.count) AS max_catch,
            COUNT(DISTINCT tse.parent) AS scouting_entries
        FROM `tabTrap Scouting Entry` tse
        JOIN `tabScouting Entry` se ON se.name = tse.parent
        WHERE YEAR(se.date_of_capture) = %s
          AND tse.pest IS NOT NULL AND tse.pest != ''
        GROUP BY WEEK(se.date_of_capture, 1), tse.pest
        ORDER BY week_number, total_caught DESC
        """,
        (current_year,),
        as_dict=True,
    )

    from_weekly = {}
    for row in weekly_pest:
        w = row.week_number
        if w not in from_weekly:
            from_weekly[w] = {"week_start": row.week_start, "pests": {}}
        from_weekly[w]["pests"][row.pest] = {
            "observations": row.observations,
            "total_caught": _safe_int(row.total_caught),
            "max_catch": _safe_int(row.max_catch),
            "scouting_entries": row.scouting_entries,
        }
    all_weeks = sorted(from_weekly.keys())

    high_counts = frappe.db.sql(
        """
        SELECT
            tse.name, tse.parent AS scouting_entry, tse.trap, tse.pest, tse.count,
            tse.location, se.date_of_capture, se.time_of_capture, se.scouts_name,
            se.greenhouse, se.zone,
            WEEK(se.date_of_capture, 1) AS week_number,
            emp.employee_name
        FROM `tabTrap Scouting Entry` tse
        JOIN `tabScouting Entry` se ON se.name = tse.parent
        LEFT JOIN `tabEmployee` emp ON emp.name = se.scouts_name
        WHERE YEAR(se.date_of_capture) = %s
          AND tse.count >= %s
          AND tse.pest IS NOT NULL AND tse.pest != ''
        ORDER BY tse.count DESC
        """,
        (current_year, HIGH_COUNT_THRESHOLD),
        as_dict=True,
    )

    def _pest_entries(pest_filter, start, end):
        return frappe.db.sql(
            """
            SELECT
                tse.parent AS scouting_entry, tse.trap, tse.pest, tse.count,
                se.date_of_capture, se.time_of_capture, se.scouts_name,
                se.greenhouse, se.zone,
                WEEK(se.date_of_capture, 1) AS week_number,
                emp.employee_name
            FROM `tabTrap Scouting Entry` tse
            JOIN `tabScouting Entry` se ON se.name = tse.parent
            LEFT JOIN `tabEmployee` emp ON emp.name = se.scouts_name
            WHERE se.date_of_capture BETWEEN %s AND %s
              AND tse.pest = %s
              AND tse.count > 0
            ORDER BY se.date_of_capture, tse.count DESC
            """,
            (start, end, pest_filter),
            as_dict=True,
        )

    pest_breakdown = {}
    prev_pest_breakdown = {}
    for p in TARGET_PESTS:
        lw = _pest_entries(p, last_week_start, last_week_end)
        if lw:
            pest_breakdown[p] = {"entries": lw, "total": sum(_safe_int(r.count) for r in lw)}
        pw = _pest_entries(p, two_weeks_ago_start, two_weeks_ago_end)
        if pw:
            prev_pest_breakdown[p] = {"entries": pw, "total": sum(_safe_int(r.count) for r in pw)}

    last_week_number = None
    for row in weekly_summary:
        if row.week_start and last_week_start <= row.week_start <= last_week_end:
            last_week_number = row.week_number
            break

    return {
        "weekly_summary": weekly_summary,
        "pest_list": pest_list,
        "from_weekly": from_weekly,
        "all_weeks": all_weeks,
        "high_counts": high_counts,
        "pest_breakdown": pest_breakdown,
        "prev_pest_breakdown": prev_pest_breakdown,
        "last_week_number": last_week_number,
    }


def build_html():
    """Full HTML body of the weekly trap report."""
    wk = _week_range_strings()
    current_year = wk["current_year"]
    week_range = wk["week_range"]
    prev_week_range = wk["prev_week_range"]
    current_time = str(frappe.utils.now()).split(".")[0]

    d = _collect(wk)
    weekly_summary = d["weekly_summary"]
    pest_list = d["pest_list"]
    from_weekly = d["from_weekly"]
    all_weeks = d["all_weeks"]
    high_counts = d["high_counts"]
    pest_breakdown = d["pest_breakdown"]
    prev_pest_breakdown = d["prev_pest_breakdown"]
    last_week_number = d["last_week_number"]

    has_data = len(weekly_summary) > 0
    if not has_data:
        return (
            '<div style="max-width:960px;margin:0 auto;padding:20px;background:#ffffff;font-family:Arial,sans-serif;">'
            '<table style="width:100%;border-collapse:collapse;margin:0 0 20px 0;">'
            '<tr><td style="background-color:#0D2B5E;padding:22px 28px;border-radius:6px;">'
            '<div style="font-size:20px;font-weight:700;color:#ffffff;margin-bottom:4px;">Trap Scouting - Weekly Report</div>'
            '<div style="font-size:13px;color:#c8d8f0;">' + str(current_year) + '</div>'
            '</td></tr></table>'
            '<p style="font-size:14px;color:#333;">Hi Team,<br><br>'
            'No trap scouting data has been recorded for ' + str(current_year) + ' yet.</p>'
            '</div>'
        )

    # --- SECTION 1: Weekly Summary ---
    s1 = [
        '<div ' + HDR + '>Weekly Trap Summary (' + str(current_year) + ')</div>',
        '<table ' + TABLE + '>',
        '<tr><th ' + THL + '>Week</th><th ' + THL + '>Week Start</th><th ' + THL + '>Week End</th>'
        '<th ' + THC + '>Scouting Entries</th><th ' + THC + '>Observations</th><th ' + THC + '>Total Caught</th></tr>',
    ]
    for row in weekly_summary:
        wk_num = str(row.week_number).zfill(2)
        wk_start = frappe.utils.formatdate(row.week_start, "dd MMM yyyy")
        wk_end = frappe.utils.formatdate(row.week_end, "dd MMM yyyy")
        hl = ' style="background-color:#e8f4e8;"' if row.week_number == last_week_number else ""
        s1.append(
            '<tr' + hl + '>'
            '<td ' + TDL + '><b>W' + wk_num + '</b></td>'
            '<td ' + TDL + '>' + wk_start + '</td>'
            '<td ' + TDL + '>' + wk_end + '</td>'
            '<td ' + TDC + '>' + str(row.scouting_entries) + '</td>'
            '<td ' + TDC + '>' + str(row.total_observations) + '</td>'
            '<td ' + TDBOLD + '>' + str(_safe_int(row.total_caught)) + '</td>'
            '</tr>'
        )
    total_entries = sum(r.scouting_entries for r in weekly_summary)
    total_obs = sum(r.total_observations for r in weekly_summary)
    total_caught = sum(_safe_int(r.total_caught) for r in weekly_summary)
    s1.append(
        '<tr><td ' + TFL + ' colspan="3">TOTAL</td>'
        '<td ' + TFC + '>' + str(total_entries) + '</td>'
        '<td ' + TFC + '>' + str(total_obs) + '</td>'
        '<td ' + TFC + '>' + str(total_caught) + '</td></tr>'
    )
    s1.append('</table>')
    section1 = "".join(s1)

    # --- SECTION 2: Weekly Catch Details by Pest ---
    s2 = [
        '<div ' + HDR + '>Weekly Catch Details by Pest</div>',
        '<table ' + TABLE + '>',
        '<tr><th ' + THL + '>Week</th><th ' + THL + '>Week Start</th><th ' + THL + '>Pest</th>'
        '<th ' + THC + '>Observations</th><th ' + THC + '>Total Caught</th>'
        '<th ' + THC + '>Max Catch</th><th ' + THC + '>Entries</th></tr>',
    ]
    for w in all_weeks:
        wd = from_weekly[w]
        wk_num = str(w).zfill(2)
        wk_start = frappe.utils.formatdate(wd["week_start"], "dd MMM yyyy")
        first = True
        sorted_pests_list = sorted(wd["pests"].items(), key=lambda x: x[1]["total_caught"], reverse=True)
        hl = ' style="background-color:#e8f4e8;"' if w == last_week_number else ""
        for pest, pd in sorted_pests_list:
            s2.append(
                '<tr' + (hl if first else "") + '>'
                '<td ' + TDL + '>' + (('<b>W' + wk_num + '</b>') if first else "") + '</td>'
                '<td ' + TDL + '>' + (wk_start if first else "") + '</td>'
                '<td ' + TDL + '>' + pest + '</td>'
                '<td ' + TDC + '>' + str(pd["observations"]) + '</td>'
                '<td ' + TDBOLD + '>' + str(pd["total_caught"]) + '</td>'
                '<td ' + TDC + '>' + str(pd["max_catch"]) + '</td>'
                '<td ' + TDC + '>' + str(pd["scouting_entries"]) + '</td>'
                '</tr>'
            )
            first = False
    s2.append('</table>')
    section2 = "".join(s2)

    # --- SECTION 3: Pivot Table ---
    s3 = [
        '<div ' + HDR + '>Pivot Table: Weekly Catch per Pest (' + str(current_year) + ')</div>',
        '<div style="overflow-x:auto;">',
        '<table ' + TABLE + '>',
        '<tr><th ' + THL + '>Pest</th>',
    ]
    for w in all_weeks:
        s3.append('<th ' + THC + '>W' + str(w).zfill(2) + '</th>')
    s3.append('<th ' + THC + '>TOTAL</th></tr>')

    pest_totals = {}
    grand_total_all = 0
    for pest in pest_list:
        grand = 0
        s3.append('<tr><td ' + TDL + '><b>' + pest + '</b></td>')
        for w in all_weeks:
            caught = from_weekly.get(w, {}).get("pests", {}).get(pest, {}).get("total_caught", 0)
            grand += caught
            bg = "background-color:#fff3cd;" if caught > 50 else ""
            if w == last_week_number:
                bg = "background-color:#d4edda;"
            s3.append(
                '<td style="padding:8px 12px;border-bottom:1px solid #e8e8e8;font-size:13px;color:#222;text-align:center;' + bg + '">'
                + str(caught) + '</td>'
            )
        pest_totals[pest] = grand
        grand_total_all += grand
        s3.append('<td ' + TDBOLD + '>' + str(grand) + '</td></tr>')

    s3.append('<tr><td ' + TFL + '>TOTAL</td>')
    for w in all_weeks:
        wk_total = sum(from_weekly.get(w, {}).get("pests", {}).get(p, {}).get("total_caught", 0) for p in pest_list)
        bg = "background-color:#d4edda;" if w == last_week_number else ""
        s3.append(
            '<td style="padding:9px 12px;background-color:#0D2B5E;color:#fff;font-size:13px;font-weight:700;text-align:center;' + bg + '">'
            + str(wk_total) + '</td>'
        )
    s3.append('<td ' + TFC + '>' + str(grand_total_all) + '</td></tr>')
    s3.append('</table></div>')
    section3 = "".join(s3)

    # --- SECTION 4: Week-on-Week Trend ---
    s4 = [
        '<div ' + HDR + '>Week-on-Week Trend per Pest</div>',
        '<table ' + TABLE + '>',
        '<tr><th ' + THL + '>Pest</th><th ' + THL + '>Week</th>'
        '<th ' + THR + '>Caught</th><th ' + THR + '>vs Prev Week</th><th ' + THC + '>Trend</th></tr>',
    ]
    for pest in pest_list:
        prev = None
        first_for_pest = True
        for w in all_weeks:
            caught = from_weekly.get(w, {}).get("pests", {}).get(pest, {}).get("total_caught", 0)
            if prev is None:
                change_str = "-"
                trend = ""
                trend_color = "#999"
            else:
                diff = caught - prev
                change_str = _format_with_sign(diff)
                if diff > 0:
                    trend, trend_color = "UP", "#e74c3c"
                elif diff < 0:
                    trend, trend_color = "DOWN", "#27ae60"
                else:
                    trend, trend_color = "FLAT", "#f39c12"
            pest_display = pest if first_for_pest else ""
            hl = ' style="background-color:#e8f4e8;"' if w == last_week_number else ""
            s4.append(
                '<tr' + hl + '>'
                '<td ' + TDL + '><b>' + pest_display + '</b></td>'
                '<td ' + TDL + '>W' + str(w).zfill(2) + '</td>'
                '<td ' + TDR + '>' + str(caught) + '</td>'
                '<td ' + TDR + '>' + change_str + '</td>'
                '<td style="padding:8px 12px;border-bottom:1px solid #e8e8e8;font-size:13px;text-align:center;font-weight:600;color:' + trend_color + ';">'
                + trend + '</td>'
                '</tr>'
            )
            first_for_pest = False
            prev = caught
    s4.append('</table>')
    section4 = "".join(s4)

    # --- SECTION 5: Top Pests ---
    sorted_pests = sorted(pest_totals.items(), key=lambda x: x[1], reverse=True)
    s5 = [
        '<div ' + HDR + '>Top Pests - Year to Date (' + str(current_year) + ')</div>',
        '<table ' + TABLE + '>',
        '<tr><th ' + THL + '>Rank</th><th ' + THL + '>Pest</th>'
        '<th ' + THR + '>Total Caught</th><th ' + THC + '>% of Total</th></tr>',
    ]
    rank = 1
    for pest, total in sorted_pests[:10]:
        if total > 0:
            pct = (float(total) / float(grand_total_all) * 100) if grand_total_all > 0 else 0
            bar_width = int(pct * 2)
            bar_html = '<span style="display:inline-block;width:' + str(bar_width) + 'px;height:8px;background-color:#0D2B5E;border-radius:4px;margin-left:8px;"></span>'
            s5.append(
                '<tr>'
                '<td ' + TDC + '>' + str(rank) + '</td>'
                '<td ' + TDL + '><b>' + pest + '</b></td>'
                '<td ' + TDR + '>' + str(total) + '</td>'
                '<td style="padding:8px 12px;border-bottom:1px solid #e8e8e8;font-size:13px;text-align:left;">'
                + _format_percent(pct) + bar_html + '</td>'
                '</tr>'
            )
            rank += 1
    s5.append('</table>')
    section5 = "".join(s5)

    # --- SECTION 6: High Count Entries ---
    s6 = ['<div ' + HDR + '>High Count Trap Entries (Count &ge; ' + str(HIGH_COUNT_THRESHOLD) + ')</div>']
    if not high_counts:
        s6.append('<p style="font-size:13px;color:#666;margin:0 0 20px 0;">No high count entries recorded this year.</p>')
    else:
        s6.append(
            '<table ' + TABLE + '>'
            '<tr><th ' + THL + '>Week</th><th ' + THL + '>Date</th><th ' + THL + '>Time</th>'
            '<th ' + THL + '>Scout</th><th ' + THL + '>Greenhouse</th><th ' + THL + '>Trap</th>'
            '<th ' + THL + '>Pest</th><th ' + THR + '>Count</th><th ' + THL + '>Entry</th></tr>'
        )
        for row in high_counts:
            scout = row.employee_name or row.scouts_name or ""
            gh = (row.greenhouse or "")[:20]
            trap = (row.trap or "")[:20]
            pest = (row.pest or "")[:20]
            hl = ' style="background-color:#e8f4e8;"' if row.week_number == last_week_number else ""
            s6.append(
                '<tr' + hl + '>'
                '<td ' + TDL + '>W' + str(row.week_number).zfill(2) + '</td>'
                '<td ' + TDL + '>' + str(row.date_of_capture) + '</td>'
                '<td ' + TDL + '>' + str(row.time_of_capture) + '</td>'
                '<td ' + TDL + '>' + scout + '</td>'
                '<td ' + TDL + '>' + gh + '</td>'
                '<td ' + TDL + '>' + trap + '</td>'
                '<td ' + TDL + '>' + pest + '</td>'
                '<td ' + TDR + '><b>' + str(_safe_int(row.count)) + '</b></td>'
                '<td ' + TDL + '><span ' + MONO + '>' + row.scouting_entry + '</span></td>'
                '</tr>'
            )
        s6.append('</table>')
    section6 = "".join(s6)

    # --- SECTION 7: Trap Entries by Pest - Last 2 Weeks ---
    s7 = ['<div ' + HDR + '>Trap Entries by Pest - Last 2 Weeks</div>']

    s7.append(
        '<div style="font-size:14px;font-weight:700;color:#0D2B5E;margin:16px 0 8px 0;padding:8px 14px;'
        'background:#e8f4e8;border-left:4px solid #27ae60;border-radius:3px;">'
        'Last Week: ' + week_range + '</div>'
    )
    has_last = False
    for p in TARGET_PESTS:
        if p not in pest_breakdown:
            continue
        has_last = True
        data = pest_breakdown[p]
        entries = data["entries"]
        total = data["total"]
        s7.append(
            '<div ' + SUBHDR + '>' + p + ' - ' + str(len(entries)) + ' entries - Total Caught: ' + str(total) + '</div>'
            '<table ' + TABLE + '>'
            '<tr><th ' + THL + '>Date</th><th ' + THL + '>Time</th><th ' + THL + '>Scout</th>'
            '<th ' + THL + '>Trap</th><th ' + THR + '>Count</th><th ' + THL + '>Entry</th></tr>'
        )
        for row in entries:
            scout = (row.employee_name or row.scouts_name or "")[:28]
            trap = (row.trap or "")[:20]
            s7.append(
                '<tr>'
                '<td ' + TDL + '>' + str(row.date_of_capture) + '</td>'
                '<td ' + TDL + '>' + str(row.time_of_capture) + '</td>'
                '<td ' + TDL + '>' + scout + '</td>'
                '<td ' + TDL + '>' + trap + '</td>'
                '<td ' + TDR + '>' + str(_safe_int(row.count)) + '</td>'
                '<td ' + TDL + '><span ' + MONO + '>' + row.scouting_entry + '</span></td>'
                '</tr>'
            )
        s7.append(
            '<tr style="background-color:#0D2B5E10;">'
            '<td ' + TDL + '></td><td ' + TDL + '></td><td ' + TDL + '></td>'
            '<td ' + TDL + '><b>TOTAL</b></td>'
            '<td ' + TDR + '><b>' + str(total) + '</b></td>'
            '<td ' + TDL + '></td>'
            '</tr></table><br>'
        )
    if not has_last:
        s7.append('<p style="font-size:13px;color:#666;margin:0 0 20px 0;">No trap entries recorded for last week.</p>')

    s7.append(
        '<div style="font-size:14px;font-weight:700;color:#0D2B5E;margin:24px 0 8px 0;padding:8px 14px;'
        'background:#f0f4ff;border-left:4px solid #0D2B5E;border-radius:3px;">'
        'Previous Week: ' + prev_week_range + '</div>'
    )
    has_prev = False
    for p in TARGET_PESTS:
        if p not in prev_pest_breakdown:
            continue
        has_prev = True
        data = prev_pest_breakdown[p]
        entries = data["entries"]
        total = data["total"]
        s7.append(
            '<div ' + SUBHDR + '>' + p + ' - ' + str(len(entries)) + ' entries - Total Caught: ' + str(total) + '</div>'
            '<table ' + TABLE + '>'
            '<tr><th ' + THL + '>Date</th><th ' + THL + '>Time</th><th ' + THL + '>Scout</th>'
            '<th ' + THL + '>Trap</th><th ' + THR + '>Count</th><th ' + THL + '>Entry</th></tr>'
        )
        for row in entries:
            scout = (row.employee_name or row.scouts_name or "")[:28]
            trap = (row.trap or "")[:20]
            s7.append(
                '<tr>'
                '<td ' + TDL + '>' + str(row.date_of_capture) + '</td>'
                '<td ' + TDL + '>' + str(row.time_of_capture) + '</td>'
                '<td ' + TDL + '>' + scout + '</td>'
                '<td ' + TDL + '>' + trap + '</td>'
                '<td ' + TDR + '>' + str(_safe_int(row.count)) + '</td>'
                '<td ' + TDL + '><span ' + MONO + '>' + row.scouting_entry + '</span></td>'
                '</tr>'
            )
        s7.append(
            '<tr style="background-color:#0D2B5E10;">'
            '<td ' + TDL + '></td><td ' + TDL + '></td><td ' + TDL + '></td>'
            '<td ' + TDL + '><b>TOTAL</b></td>'
            '<td ' + TDR + '><b>' + str(total) + '</b></td>'
            '<td ' + TDL + '></td>'
            '</tr></table><br>'
        )
    if not has_prev:
        s7.append('<p style="font-size:13px;color:#666;margin:0 0 20px 0;">No trap entries recorded for the previous week.</p>')

    section7 = "".join(s7)

    toc = (
        '<table style="width:100%;border-collapse:collapse;margin:0 0 24px 0;">'
        '<tr><td style="background-color:#f4f6fb;border-left:4px solid #0D2B5E;padding:14px 20px;border-radius:4px;">'
        '<div style="font-size:13px;font-weight:700;color:#0D2B5E;margin-bottom:8px;">Report Sections</div>'
        '<div style="font-size:12px;color:#1A3A6B;margin-bottom:3px;">1. Weekly Trap Summary (Full Year)</div>'
        '<div style="font-size:12px;color:#1A3A6B;margin-bottom:3px;">2. Weekly Catch Details by Pest</div>'
        '<div style="font-size:12px;color:#1A3A6B;margin-bottom:3px;">3. Pivot Table: Weekly Catch per Pest</div>'
        '<div style="font-size:12px;color:#1A3A6B;margin-bottom:3px;">4. Week-on-Week Trend per Pest</div>'
        '<div style="font-size:12px;color:#1A3A6B;margin-bottom:3px;">5. Top Pests - Year to Date</div>'
        '<div style="font-size:12px;color:#1A3A6B;margin-bottom:3px;">6. High Count Trap Entries</div>'
        '<div style="font-size:12px;color:#1A3A6B;margin-bottom:3px;">7. Trap Entries by Pest - Last 2 Weeks</div>'
        '</td></tr></table>'
    )

    return (
        '<div style="max-width:1200px;margin:0 auto;padding:20px;background:#ffffff;font-family:Arial,sans-serif;">'
        '<table style="width:100%;border-collapse:collapse;margin:0 0 20px 0;">'
        '<tr><td style="background-color:#0D2B5E;padding:22px 28px;border-radius:6px;">'
        '<div style="font-size:20px;font-weight:700;color:#ffffff;margin-bottom:4px;">Trap Scouting - Weekly Report</div>'
        '<div style="font-size:13px;color:#c8d8f0;">' + week_range + '</div>'
        '</td></tr></table>'
        '<p style="font-size:14px;color:#333;margin:0 0 20px 0;">Hi Team,<br><br>'
        'Please find below the weekly trap scouting summary for <strong>' + week_range + '</strong>.<br>'
        'This report covers all trap observations recorded during scouting activities. '
        'Last week\'s data is highlighted in green throughout.</p>'
        + toc + section1 + section2 + section3 + section4 + section5 + section6 + section7
        + '<table style="width:100%;border-collapse:collapse;margin:30px 0 0 0;">'
        '<tr><td style="border-top:1px solid #e0e0e0;padding-top:16px;font-size:12px;color:#999;">'
        'Report generated on ' + current_time + '<br>'
        'Data includes all trap scouting entries for ' + str(current_year) + '.<br><br>'
        'Regards,<br>Upande'
        '</td></tr></table>'
        '</div>'
    )


def _recipients():
    """Weekly trap report recipients (Trap Report Settings retired)."""
    return [
        "stephenechikoi@gmail.com",
        "echikoistephene@gmail.com",
        "vlabat@karenroses.com",
        "rbundotich@karenroses.com",
    ]


def _subject():
    wk = _week_range_strings()
    return "Trap Scouting: Weekly Report (" + wk["week_range"] + ")"


def _filename_base():
    wk = _week_range_strings()
    return "weekly_trap_report_" + wk["week_range"].replace(" ", "_").replace(",", "")


def send_weekly_trap_report():
    """Scheduler entry point — builds and sends the weekly trap email."""
    frappe.sendmail(recipients=_recipients(), subject=_subject(), message=build_html())


@frappe.whitelist()
def trigger_weekly_email():
    send_weekly_trap_report()
    return {"ok": True, "recipients": _recipients()}


@frappe.whitelist()
def download_weekly_pdf():
    html = build_html()
    pdf_bytes = get_pdf(html)
    frappe.local.response.filename = _filename_base() + ".pdf"
    frappe.local.response.filecontent = pdf_bytes
    frappe.local.response.type = "download"
