"""
send_fcm_weekly_excel_report.py
================================
Generate and email the KEPHIS FCM Weekly Monitoring Excel report.
Mirrors the format of the official CHEPSITO (KE0300809046) template.

Sheets generated
----------------
1. FCM Daily monitoring   – per-trap FCM counts (indoor / outdoor) by week
2. Weekly summary         – all moth species totals by week
3. Scouting Summary       – plant-level pests per GH per week
4. Intake QC Report       – same structure as Scouting Summary
5. Variety List           – static GH-variety assignments
6. FCM Risk profiling     – static risk scores per variety

Hook in hooks.py:
    scheduler_events = {
        "weekly": [
            "upande_scp.serverscripts.send_fcm_weekly_excel_report.send_fcm_weekly_excel_report"
        ]
    }
"""

import io
import re
from datetime import date, timedelta

import frappe


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def send_fcm_weekly_excel_report():
    """Generate and email the KEPHIS FCM weekly Excel report (runs every Monday)."""
    try:
        import openpyxl
        from openpyxl.styles import PatternFill, Font, Alignment, Border, Side
        from openpyxl.utils import get_column_letter
    except ImportError:
        frappe.log_error("openpyxl not installed – run: pip install openpyxl", "FCM Weekly Report")
        return

    today = date.today()
    current_year = today.year
    weekday = today.weekday()          # 0 = Monday

    # Last week: previous Monday → Sunday
    last_week_mon = today - timedelta(days=weekday + 7)
    last_week_sun = last_week_mon + timedelta(days=6)
    last_week_num = int(last_week_mon.isocalendar()[1])
    current_week_num = int(today.isocalendar()[1])

    week_range_str = (
        last_week_mon.strftime("%d %b") + " - " + last_week_sun.strftime("%d %b %Y")
    )

    # -----------------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------------

    def parse_trap_num(trap_number):
        try:
            return int(str(trap_number).strip())
        except Exception:
            return 0

    def gh_from_trap(trap_number):
        """Derive greenhouse number from trap number (e.g. 1307 → 13)."""
        n = parse_trap_num(trap_number)
        return n // 100 if n >= 100 else 0

    def gh_from_warehouse(gh_name):
        """Extract GH number from 'Chepsito GH 12 - KR' → 12."""
        if not gh_name:
            return 0
        m = re.search(r"GH\s+(\d+)", str(gh_name))
        return int(m.group(1)) if m else 0

    def safe_int(v):
        try:
            return int(float(v or 0))
        except Exception:
            return 0

    def iso_week_range(year, week_num):
        mon = date.fromisocalendar(year, week_num, 1)
        sun = date.fromisocalendar(year, week_num, 7)
        return mon, sun

    def human_date(d):
        """Format date as '5th Jan 2026'."""
        day = d.day
        sfx = "th" if 11 <= (day % 100) <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(day % 10, "th")
        return f"{day}{sfx} {d.strftime('%b %Y')}"

    def map_stage(stage):
        s = (stage or "").lower()
        if "egg" in s:
            return "eggs"
        if "larva" in s or "nymph" in s or "instar" in s:
            return "larvae"
        if "damage" in s:
            return "damages"
        return "other"

    # -----------------------------------------------------------------------
    # SQL queries
    # -----------------------------------------------------------------------

    # All FCM-type traps ordered by trap number
    fcm_traps = frappe.db.sql(
        """
        SELECT name, greenhouse, trap_number, location
        FROM   `tabTrap`
        WHERE  type = 'FCM'
        ORDER  BY CAST(trap_number AS UNSIGNED)
        """,
        as_dict=True,
    )

    # FCM observations per (week, trap, location)
    fcm_raw = frappe.db.sql(
        """
        SELECT
            tse.trap,
            COALESCE(tse.location, t.location, 'Indoor')  AS location,
            SUM(tse.count)                                 AS cnt,
            WEEK(se.date_of_capture, 1)                   AS wk
        FROM  `tabTrap Scouting Entry` tse
        JOIN  `tabScouting Entry` se ON se.name = tse.parent
        LEFT JOIN `tabTrap` t ON t.name = tse.trap
        WHERE YEAR(se.date_of_capture) = %s
          AND tse.pest = 'FCM'
        GROUP BY tse.trap, location, WEEK(se.date_of_capture, 1)
        """,
        (current_year,),
        as_dict=True,
    )

    # All trap pest totals per week (weekly summary)
    trap_pest_wk = frappe.db.sql(
        """
        SELECT
            tse.pest,
            SUM(tse.count)              AS cnt,
            WEEK(se.date_of_capture, 1) AS wk
        FROM  `tabTrap Scouting Entry` tse
        JOIN  `tabScouting Entry` se ON se.name = tse.parent
        WHERE YEAR(se.date_of_capture) = %s
          AND tse.count > 0
          AND tse.pest IS NOT NULL AND tse.pest != ''
        GROUP BY tse.pest, WEEK(se.date_of_capture, 1)
        """,
        (current_year,),
        as_dict=True,
    )

    # Plant-level pests per GH per week (scouting summary)
    plant_pests = frappe.db.sql(
        """
        SELECT
            pse.pest,
            pse.stage,
            SUM(pse.count)              AS cnt,
            se.greenhouse,
            WEEK(se.date_of_capture, 1) AS wk
        FROM  `tabPests Scouting Entry` pse
        JOIN  `tabScouting Entry` se ON se.name = pse.parent
        WHERE YEAR(se.date_of_capture) = %s
          AND pse.count > 0
        GROUP BY pse.pest, pse.stage, se.greenhouse, WEEK(se.date_of_capture, 1)
        """,
        (current_year,),
        as_dict=True,
    )

    # FCM cumulative larvae/eggs per GH per week (column H in Sheet 1)
    fcm_larvae_raw = frappe.db.sql(
        """
        SELECT
            SUM(pse.count)              AS cnt,
            se.greenhouse,
            WEEK(se.date_of_capture, 1) AS wk
        FROM  `tabPests Scouting Entry` pse
        JOIN  `tabScouting Entry` se ON se.name = pse.parent
        WHERE YEAR(se.date_of_capture) = %s
          AND pse.pest = 'FCM'
          AND LOWER(pse.stage) REGEXP 'egg|larva|larvae|nymph'
        GROUP BY se.greenhouse, WEEK(se.date_of_capture, 1)
        """,
        (current_year,),
        as_dict=True,
    )

    # -----------------------------------------------------------------------
    # Build lookup maps
    # -----------------------------------------------------------------------

    # {(wk, trap_name, 'Indoor'|'Outdoor'): count}
    fcm_trap_map = {}
    for r in fcm_raw:
        loc = "Outdoor" if "out" in (r.location or "").lower() else "Indoor"
        key = (r.wk, r.trap, loc)
        fcm_trap_map[key] = fcm_trap_map.get(key, 0) + safe_int(r.cnt)

    # {(wk, pest): count}
    trap_pest_map = {}
    for r in trap_pest_wk:
        pest = (r.pest or "").strip()
        trap_pest_map[(r.wk, pest)] = trap_pest_map.get((r.wk, pest), 0) + safe_int(r.cnt)

    # {(wk, gh_num): larvae_count}
    fcm_larvae_map = {}
    for r in fcm_larvae_raw:
        gh = gh_from_warehouse(r.greenhouse)
        key = (r.wk, gh)
        fcm_larvae_map[key] = fcm_larvae_map.get(key, 0) + safe_int(r.cnt)

    # {(wk, gh_num, pest_cat, stage_cat): count}   pest_cat ∈ {FCM, Helicoverpa, Others}
    scouting_map = {}
    for r in plant_pests:
        gh = gh_from_warehouse(r.greenhouse)
        pest = (r.pest or "").strip()
        p_cat = pest if pest in ("FCM", "Helicoverpa") else "Others"
        s_cat = map_stage(r.stage)
        key = (r.wk, gh, p_cat, s_cat)
        scouting_map[key] = scouting_map.get(key, 0) + safe_int(r.cnt)

    # Collect all weeks that have any data, capped at current week
    all_wk_nums = set()
    for r in fcm_raw:
        all_wk_nums.add(r.wk)
    for r in trap_pest_wk:
        all_wk_nums.add(r.wk)
    for r in plant_pests:
        all_wk_nums.add(r.wk)

    all_weeks = sorted(w for w in all_wk_nums if 1 <= w <= current_week_num)

    if not all_weeks:
        _send_no_data_email(current_year, week_range_str)
        return

    # Sorted trap list
    sorted_traps = sorted(fcm_traps, key=lambda t: parse_trap_num(t.get("trap_number") or "0"))
    GHS = list(range(1, 20))  # GH 01 – GH 19

    # -----------------------------------------------------------------------
    # Style factories
    # -----------------------------------------------------------------------

    def mk_font(bold=False, color="000000", size=11):
        return Font(name="Calibri", bold=bold, color=color, size=size)

    def mk_fill(hex_c):
        return PatternFill("solid", fgColor=hex_c)

    def mk_border():
        s = Side(style="thin")
        return Border(left=s, right=s, top=s, bottom=s)

    DARK_BLUE = "0D2B5E"
    LIGHT_BLUE = "DDE6F5"
    GREEN_HL = "C6EFCE"
    DARK_GREEN = "538135"
    MID_BLUE = "1F5C99"

    dark_fill  = mk_fill(DARK_BLUE)
    light_fill = mk_fill(LIGHT_BLUE)
    green_fill = mk_fill(GREEN_HL)

    hdr_fnt  = mk_font(bold=True, color="FFFFFF")
    bold_fnt = mk_font(bold=True)
    data_fnt = mk_font()

    thin_brd   = mk_border()
    c_align    = Alignment(horizontal="center", vertical="center", wrap_text=True)
    l_align    = Alignment(horizontal="left",   vertical="center")
    r_align    = Alignment(horizontal="right",  vertical="center")

    # -----------------------------------------------------------------------
    # Create workbook
    # -----------------------------------------------------------------------
    wb = openpyxl.Workbook()
    wb.remove(wb.active)

    # ===================================================================
    # SHEET 1 – FCM Daily monitoring
    # ===================================================================
    ws1 = wb.create_sheet("FCM Daily monitoring")
    for i, w in enumerate([20, 30, 12, 24, 24, 28, 20, 34, 20], 1):
        ws1.column_dimensions[get_column_letter(i)].width = w

    # Title block
    ws1["A1"] = "Production Site Name"; ws1["A1"].font = bold_fnt
    ws1["E1"] = "Year";                 ws1["E1"].font = bold_fnt
    ws1["F1"] = current_year
    ws1["A2"] = "CHEPSITO";            ws1["A2"].font = mk_font(bold=True, size=14)
    ws1["A3"] = "Share the FCM data via email rosafcmdata@kephis.org"
    ws1["A4"] = "Instructions: "
    ws1["A5"] = "(a) The number of traps depends on the size of the farm at a density of 4 traps per Ha."
    ws1["A6"] = "(b) Traps to be placed strategically outside greenhouse at an interval of 50 m"
    ws1["A7"] = "(c) Data to be collected daily and cumulative counts reported to KEPHIS every Monday"
    ws1["A8"] = "(d) Ensure instructions are followed when placing/servicing FCM pheromone lures and delta traps"
    ws1["A9"] = "Fill all the other sheets accordingly"

    ws1.merge_cells("C11:I11")
    ws1["C11"] = "FCM COUNTS"
    ws1["C11"].font = hdr_fnt
    ws1["C11"].fill = dark_fill
    ws1["C11"].alignment = c_align

    _h1 = [
        "Week of the year",
        "Greenhouse No./Identity and size (Ha)",
        "Trap No.",
        "Source (supplier) of pheromone lure",
        "Pheromone placement date",
        "Date of count",
        "No. of FCM adults inside greenhouse",
        "Cummulative No. of eggs/larvae observed in the greenhouse",
        "No. of FCM adults outside greenhouse",
    ]
    ws1.row_dimensions[12].height = 44
    for col, hdr in enumerate(_h1, 1):
        c = ws1.cell(row=12, column=col, value=hdr)
        c.font = hdr_fnt; c.fill = dark_fill; c.border = thin_brd; c.alignment = c_align

    cur1 = 13
    for week_num in all_weeks:
        try:
            wk_mon, wk_sun = iso_week_range(current_year, week_num)
        except Exception:
            continue

        is_last = (week_num == last_week_num)
        w_fill  = green_fill if is_last else None

        wk_label = f"Week {week_num:02d}"
        from_str = f"FROM: {human_date(wk_mon)}"
        to_str   = f"TO: {human_date(wk_sun)}"

        row_in_wk = 0
        last_gh   = None
        wk_start  = cur1

        for trap in sorted_traps:
            trap_name  = trap.get("name") or ""
            trap_num_s = str(trap.get("trap_number") or "")
            trap_gh    = gh_from_trap(trap_num_s)
            trap_loc   = (trap.get("location") or "Indoor").strip()

            indoor_cnt  = fcm_trap_map.get((week_num, trap_name, "Indoor"),  0)
            outdoor_cnt = fcm_trap_map.get((week_num, trap_name, "Outdoor"), 0)

            # Assign counts to correct column based on trap's registered location
            if trap_loc == "Outdoor":
                col_g_val = None
                col_i_val = indoor_cnt + outdoor_cnt
            else:
                col_g_val = indoor_cnt + outdoor_cnt
                col_i_val = None

            # Cumulative larvae: only on first trap of each GH group
            is_first_gh = (trap_gh != last_gh)
            col_h_val   = fcm_larvae_map.get((week_num, trap_gh), 0) if is_first_gh else None

            # Column A labels (week / from / to on first 3 rows of week)
            col_a = wk_label if row_in_wk == 0 else (from_str if row_in_wk == 1 else (to_str if row_in_wk == 2 else None))
            # Column B: house label on first trap of each GH
            col_b = f"House {trap_gh:02d}" if is_first_gh else None
            # Column F: date range on first two rows
            col_f = from_str if row_in_wk == 0 else (to_str if row_in_wk == 1 else None)

            vals = [col_a, col_b, trap_num_s, "KOPPERT", wk_mon, col_f, col_g_val, col_h_val, col_i_val]
            for col, val in enumerate(vals, 1):
                c = ws1.cell(row=cur1, column=col, value=val)
                c.font  = data_fnt
                c.border = thin_brd
                if w_fill:
                    c.fill = w_fill
                c.alignment = r_align if col in (7, 8, 9) else l_align

            last_gh = trap_gh
            cur1 += 1
            row_in_wk += 1

        # Week total row
        wk_end = cur1 - 1
        for col in range(1, 10):
            c = ws1.cell(row=cur1, column=col)
            c.font  = mk_font(bold=True, color="FFFFFF")
            c.fill  = dark_fill
            c.border = thin_brd
            c.alignment = r_align
        ws1.cell(row=cur1, column=1).value = "WEEK TOTAL"
        ws1.cell(row=cur1, column=1).alignment = l_align
        ws1.cell(row=cur1, column=7).value = f"=SUM(G{wk_start}:G{wk_end})"
        ws1.cell(row=cur1, column=8).value = f"=SUM(H{wk_start}:H{wk_end})"
        ws1.cell(row=cur1, column=9).value = f"=SUM(I{wk_start}:I{wk_end})"
        cur1 += 2  # blank separator row between weeks

    # ===================================================================
    # SHEET 2 – Weekly summary
    # ===================================================================
    ws2 = wb.create_sheet("Weekly summary")
    for i, w in enumerate([14, 12, 18, 20, 20, 22, 22, 22, 22, 14, 10, 10, 14], 1):
        ws2.column_dimensions[get_column_letter(i)].width = w

    ws2["A1"] = "Production Site Name"; ws2["A1"].font = bold_fnt
    ws2["E1"] = "Year";                 ws2["E1"].font = bold_fnt
    ws2["F1"] = current_year
    ws2["A2"] = "CHEPSITO";            ws2["A2"].font = mk_font(bold=True, size=14)

    ws2.merge_cells("A3:M3")
    ws2["A3"] = f"LIGHT AND PHEROMONE TRAPS INSECT/MOTH TOTAL COUNTS SUMMARY/ANALYSIS {current_year}"
    ws2["A3"].font = mk_font(bold=True, size=12)
    ws2["A3"].alignment = c_align

    _h2 = [
        "Month of count", "Week of the year",
        "FCM adults\n(light)", "FCM adults\n(pheromone)", "New Cases of\nFCM Adults",
        "Helicoverpa adults\n(light trap)", "Spodoptera adults\n(light trap)",
        "Helicoverpa adults\n(Lure Trap)", "Spodoptera adults\n(Lure Trap)",
        "Others (light)",
        "Temperature (°C)", None, "Rainfall (mm)",
    ]
    ws2.row_dimensions[4].height = 48
    ws2.row_dimensions[5].height = 16
    for col, hdr in enumerate(_h2, 1):
        if hdr is None:
            continue
        c = ws2.cell(row=4, column=col, value=hdr)
        c.font = hdr_fnt; c.fill = dark_fill; c.border = thin_brd; c.alignment = c_align

    ws2.merge_cells("K4:L4")
    for sub, col in [("Min.", 11), ("Max.", 12)]:
        c = ws2.cell(row=5, column=col, value=sub)
        c.font = hdr_fnt; c.fill = dark_fill; c.border = thin_brd; c.alignment = c_align

    cur2 = 6
    last_month = None
    for week_num in all_weeks:
        try:
            wk_mon, _ = iso_week_range(current_year, week_num)
        except Exception:
            continue

        is_last = (week_num == last_week_num)
        w_fill2  = green_fill if is_last else None

        month     = wk_mon.strftime("%B").upper()
        month_val = month if month != last_month else None
        last_month = month

        fcm_p   = trap_pest_map.get((week_num, "FCM"), 0)         or None
        hel_l   = trap_pest_map.get((week_num, "Helicoverpa"), 0) or None
        spo_l   = trap_pest_map.get((week_num, "Spodoptera"), 0)  or None
        dup     = trap_pest_map.get((week_num, "Duponchella"), 0)
        unid    = trap_pest_map.get((week_num, "Unidentified Moth"), 0)
        others  = (dup + unid) or None

        row_data2 = [
            month_val, f"WK {week_num:02d}",
            None, fcm_p, None,
            None, None,
            hel_l, spo_l, others,
            None, None, None,
        ]
        for col, val in enumerate(row_data2, 1):
            c = ws2.cell(row=cur2, column=col, value=val)
            c.font  = data_fnt; c.border = thin_brd
            if w_fill2:
                c.fill = w_fill2
            c.alignment = r_align if col not in (1, 2) else l_align
        cur2 += 1

    # ===================================================================
    # SHEETS 3 & 4 – Scouting Summary / Intake QC Report
    # ===================================================================
    for sheet_name in ("Scouting Summary", "Intake QC Report"):
        ws = wb.create_sheet(sheet_name)
        for i, w in enumerate([22, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 32], 1):
            ws.column_dimensions[get_column_letter(i)].width = w

        ws["A1"] = "Production Site Name"; ws["A1"].font = bold_fnt
        ws["E1"] = "Year";                 ws["E1"].font = bold_fnt
        ws["F1"] = current_year
        ws["A2"] = "CHEPSITO";            ws["A2"].font = mk_font(bold=True, size=14)

        # Pest group headers (row 3)
        for rng, label, hex_c in [("C3:E3", "FCM", DARK_BLUE), ("F3:H3", "Helicoverpa", MID_BLUE), ("I3:K3", "Others", DARK_GREEN)]:
            ws.merge_cells(rng)
            cell_ref = rng.split(":")[0]
            ws[cell_ref] = label
            ws[cell_ref].font    = hdr_fnt
            ws[cell_ref].fill    = mk_fill(hex_c)
            ws[cell_ref].alignment = c_align

        # Column headers (row 4)
        _h3 = [
            "Period", "GH No.",
            "Eggs", "Larvae", "Damages",
            "Eggs", "Larvae", "Damages",
            "Eggs", "Larvae", "Damages",
            "Remarks (Corrective action)",
        ]
        ws.row_dimensions[3].height = 20
        ws.row_dimensions[4].height = 20
        for col, hdr in enumerate(_h3, 1):
            c = ws.cell(row=4, column=col, value=hdr)
            c.font = hdr_fnt; c.fill = dark_fill; c.border = thin_brd; c.alignment = c_align

        cur3 = 5
        for week_num in all_weeks:
            try:
                wk_mon, wk_sun = iso_week_range(current_year, week_num)
            except Exception:
                continue

            is_last = (week_num == last_week_num)
            w_fill3  = green_fill if is_last else None

            from_s = f"FROM: {human_date(wk_mon)}"
            to_s   = f"TO: {human_date(wk_sun)}"
            wk_lbl = f"Week {week_num:02d}"

            for idx, gh in enumerate(GHS):
                period = wk_lbl if idx == 0 else (from_s if idx == 1 else (to_s if idx == 2 else None))

                row_d = [
                    period, gh,
                    scouting_map.get((week_num, gh, "FCM",        "eggs"),    0),
                    scouting_map.get((week_num, gh, "FCM",        "larvae"),  0),
                    scouting_map.get((week_num, gh, "FCM",        "damages"), 0),
                    scouting_map.get((week_num, gh, "Helicoverpa","eggs"),    0),
                    scouting_map.get((week_num, gh, "Helicoverpa","larvae"),  0),
                    scouting_map.get((week_num, gh, "Helicoverpa","damages"), 0),
                    scouting_map.get((week_num, gh, "Others",     "eggs"),    0),
                    scouting_map.get((week_num, gh, "Others",     "larvae"),  0),
                    scouting_map.get((week_num, gh, "Others",     "damages"), 0),
                    None,
                ]
                for col, val in enumerate(row_d, 1):
                    c = ws.cell(row=cur3, column=col, value=val)
                    c.font  = data_fnt; c.border = thin_brd
                    if w_fill3:
                        c.fill = w_fill3
                    c.alignment = r_align if 3 <= col <= 11 else l_align
                cur3 += 1

    # ===================================================================
    # SHEET 5 – Variety List  (static)
    # ===================================================================
    ws5 = wb.create_sheet("Variety List")
    ws5["A1"] = "Production Site Name"; ws5["A1"].font = bold_fnt
    ws5["A3"] = "Greenhouse #";         ws5["A3"].font = bold_fnt
    ws5["B3"] = "Varieties per greenhouse"; ws5["B3"].font = bold_fnt

    _varieties = [
        (1, "ATHENA"), (1, "SNOW STORM"),
        (2, "MADAM RED"), (3, "MADAM RED"),
        (4, "ATHENA"), (5, "SMOOTHIE"),
        (6, "TAPDANCE"), (7, "MADAM RED"),
        (8, "TROPICAL AMAZONE"), (9, "ATHENA"),
        (10, "ATHENA"), (11, "TROPICAL AMAZONE"),
        (12, "AQUA"), (13, "ATHENA"),
        (14, "MOONWALK"), (15, "MOONWALK"),
        (16, "ATHENA"), (17, "FURIOSA"),
        (18, "AQUA"), (18, "COPACABANA"), (18, "MADAM RED"),
        (19, "MOONWALK"),
    ]
    _prev_gh = None
    for r5, (gh, variety) in enumerate(_varieties, 4):
        ws5.cell(row=r5, column=1, value=gh if gh != _prev_gh else None)
        ws5.cell(row=r5, column=2, value=variety)
        _prev_gh = gh

    # ===================================================================
    # SHEET 6 – FCM Risk profiling  (static)
    # ===================================================================
    ws6 = wb.create_sheet("FCM Risk profiling")
    ws6["A1"] = "Production Site Name"; ws6["A1"].font = bold_fnt
    ws6["C1"] = "CHEPSITO"
    ws6["D1"] = "Month/Year";           ws6["D1"].font = bold_fnt
    ws6["E1"] = today.strftime("%B").upper()

    ws6.merge_cells("B3:E3")
    ws6["B3"] = "FCM RISK PROFILE PER VARIETY"
    ws6["B3"].font = bold_fnt

    _rh = ["NO.", "VARIETY", "LEVEL OF SUSCEPTIBILITY (SCORES)", "CATEGORY", "CORRECTIVE ACTION"]
    for col, hdr in enumerate(_rh, 1):
        c = ws6.cell(row=4, column=col, value=hdr)
        c.font = hdr_fnt; c.fill = dark_fill; c.border = thin_brd; c.alignment = c_align

    _risk = [
        (15, "MOONWALK", 10, "HIGH RISK"),
        (5,  "SMOOTHIE", 8,  "HIGH RISK"),
        (9,  "ATHENA",   8,  "HIGH RISK"),
        (3,  "MADAM RED", 3, "LOW RISK"),
        (19, "MOONWALK", 3,  "LOW RISK"),
        (1,  "ATHENA, SNOWSTORM", 2, "LOW RISK"),
        (6,  "TAP DANCE", 2,  "LOW RISK"),
        (8,  "TROPICAL AMAZONE", 2, "LOW RISK"),
        (10, "ATHENA",   2,  "LOW RISK"),
        (11, "TROPICAL AMAZONE", 2, "LOW RISK"),
        (2,  "MADAM RED", 1, "LOW RISK"),
        (4,  "ATHENA",   1,  "LOW RISK"),
        (7,  "UPPER CLASS", 1,"LOW RISK"),
        (12, "AQUA",     1,  "LOW RISK"),
        (13, "ATHENA",   1,  "LOW RISK"),
        (14, "MOONWALK", 1,  "LOW RISK"),
        (16, "ATHENA",   1,  "LOW RISK"),
        (17, "FURIOSA",  1,  "LOW RISK"),
        (18, "COPACABANA, AQUA, MADAM RED", 1, "LOW RISK"),
    ]
    for i, (gh, variety, score, category) in enumerate(_risk, 5):
        ws6.cell(row=i, column=1, value=gh)
        ws6.cell(row=i, column=2, value=variety)
        ws6.cell(row=i, column=3, value=score)
        ws6.cell(row=i, column=4, value=category)

    note_row = len(_risk) + 6
    ws6.cell(row=note_row,     column=2, value="1 - Low susceptible variety")
    ws6.cell(row=note_row + 1, column=2, value="2 - Medium susceptible variety")
    ws6.cell(row=note_row + 2, column=2, value="3 - Highly susceptible variety")

    # ===================================================================
    # Save workbook → bytes buffer
    # ===================================================================
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    excel_bytes = buf.read()

    # ===================================================================
    # Email
    # ===================================================================
    recipients = [
        "stephenechikoi@gmail.com",
        "echikoistephene@gmail.com",
        "vlabat@karenroses.com",
        "rbundotich@karenroses.com",
    ]
    try:
        s = frappe.get_single("Trap Report Settings")
        # Prefer the FCM-specific field; fall back to the shared weekly field
        raw = (s.fcm_excel_report_recipients or "").strip() or (s.weekly_report_recipients or "").strip()
        if raw:
            recipients = [r.strip() for r in raw.split(",") if r.strip()]
    except Exception:
        pass

    fname = f"CHEPSITO_FCM_Weekly_Report_{current_year}_W{last_week_num:02d}.xlsx"

    html_body = f"""
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#333;max-width:640px;">
      <div style="background:#0D2B5E;padding:22px 28px;margin-bottom:20px;border-radius:4px;">
        <div style="font-size:20px;font-weight:700;color:#fff;">FCM Weekly Monitoring Report</div>
        <div style="font-size:13px;color:#c8d8f0;margin-top:4px;">
          KEPHIS Site: CHEPSITO (KE0300809046) &mdash; {week_range_str} &mdash; {current_year}
        </div>
      </div>
      <p>Hi Team,</p>
      <p>Please find attached the <strong>KEPHIS FCM Weekly Monitoring Report</strong>
         for <strong>{week_range_str}</strong>.</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin:12px 0;">
        <tr style="background:#0D2B5E;color:#fff;">
          <th style="padding:8px 12px;text-align:left;">Sheet</th>
          <th style="padding:8px 12px;text-align:left;">Contents</th>
        </tr>
        <tr style="background:#f4f6fb;">
          <td style="padding:7px 12px;border-bottom:1px solid #dde;">FCM Daily monitoring</td>
          <td style="padding:7px 12px;border-bottom:1px solid #dde;">Per-trap FCM counts (indoor &amp; outdoor) by week</td>
        </tr>
        <tr>
          <td style="padding:7px 12px;border-bottom:1px solid #dde;">Weekly summary</td>
          <td style="padding:7px 12px;border-bottom:1px solid #dde;">FCM, Helicoverpa, Spodoptera, Duponchella &amp; Unidentified Moths by week</td>
        </tr>
        <tr style="background:#f4f6fb;">
          <td style="padding:7px 12px;border-bottom:1px solid #dde;">Scouting Summary</td>
          <td style="padding:7px 12px;border-bottom:1px solid #dde;">Plant-level pest observations (eggs / larvae / damages) per GH</td>
        </tr>
        <tr>
          <td style="padding:7px 12px;border-bottom:1px solid #dde;">Intake QC Report</td>
          <td style="padding:7px 12px;border-bottom:1px solid #dde;">Same data for QC reference</td>
        </tr>
        <tr style="background:#f4f6fb;">
          <td style="padding:7px 12px;border-bottom:1px solid #dde;">Variety List</td>
          <td style="padding:7px 12px;border-bottom:1px solid #dde;">Greenhouse &rarr; variety assignments</td>
        </tr>
        <tr>
          <td style="padding:7px 12px;">FCM Risk profiling</td>
          <td style="padding:7px 12px;">Risk scores per variety</td>
        </tr>
      </table>
      <p style="font-size:13px;color:#555;">
        <strong>Last week&rsquo;s rows are highlighted in green</strong> throughout all data sheets.
      </p>
      <p>Regards,<br>Upande Crop-Protection System</p>
      <hr style="border:none;border-top:1px solid #ddd;margin:20px 0;">
      <p style="font-size:11px;color:#999;">
        Report generated: {frappe.utils.now()}<br>
        KEPHIS Site ID: KE0300809046 &mdash; CHEPSITO<br>
        Data covers all scouting entries for {current_year}.
      </p>
    </div>
    """

    frappe.sendmail(
        recipients=recipients,
        subject=f"FCM Weekly Monitoring Report — {week_range_str} ({current_year})",
        message=html_body,
        attachments=[{"fname": fname, "fcontent": excel_bytes}],
    )

    frappe.logger().info(
        f"FCM Weekly Excel Report sent for {week_range_str} → {recipients}"
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _send_no_data_email(current_year, week_range_str):
    """Send a brief notice when no trap data exists for the year."""
    recipients = ["stephenechikoi@gmail.com"]
    try:
        report_settings = frappe.get_single("Trap Report Settings")
        if report_settings and hasattr(report_settings, "weekly_report_recipients"):
            if report_settings.weekly_report_recipients:
                recipients = [
                    r.strip()
                    for r in report_settings.weekly_report_recipients.split(",")
                    if r.strip()
                ]
    except Exception:
        pass

    frappe.sendmail(
        recipients=recipients,
        subject=f"FCM Weekly Report — No Data ({week_range_str})",
        message=(
            f"<p>Hi Team,</p>"
            f"<p>No trap scouting data found for {current_year}. "
            f"The FCM weekly Excel report was not generated.</p>"
            f"<p>Regards,<br>Upande System</p>"
        ),
    )
