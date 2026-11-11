"""Weekly spray records email: what was sprayed where, by active ingredient.

Once a week, for the week just ended (Monday to Sunday), one email per farm goes
to the farm's managers and the company GM (``recipients_for_farm``): per location
(greenhouse or block), active ingredient and product, how many applications, the
quantity and the last date. A workbook with the detail is attached.

What counts as sprayed, and where the quantity comes from:

* A submitted Spray Application Logsheet is the record of an application; its
  ``pesticides`` rows give the quantity (``pesticide_quantity``).
* A completed Application Floor Plan Work Order with NO logsheet is also an
  application; its chemical rows give the quantity (``required_qty``).
* A plan that has a logsheet is counted once, from the logsheet.

A product with several active ingredients is listed under each one with its full
quantity (noted, so a farm total over ingredients is not read as additive). A
product with none recorded is listed under "Active ingredient not recorded" and
named in a note so someone can fill it in on the Spray Product.

Light styling: ink on white and one table style, like the coverage email.
"""
from __future__ import annotations

import io
from collections import OrderedDict
from datetime import timedelta

import frappe

from upande_scp.serverscripts.reports.report_sender import report_sender
from upande_scp.serverscripts.scouting import cumulative_per_ha as C

DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
SETTINGS = "Scouting and Crop Protection Settings"
NOT_RECORDED = "Active ingredient not recorded"
AFP = "Application Floor Plan"
MAX_ROWS = 120  # rows per farm in the email body; the workbook carries the rest

INK = "#111111"
MUTED = "#6b6b6b"
RULE = "#e5e5e5"
BAD = "#b42318"

TABLE = f'cellpadding="5" style="width:100%;border-collapse:collapse;margin:0 0 8px 0;font-size:12px;color:{INK};text-align:left;"'
TH = f'style="border-bottom:2px solid {INK};font-size:10.5px;text-transform:uppercase;"'
THN = f'style="border-bottom:2px solid {INK};font-size:10.5px;text-transform:uppercase;text-align:right"'
TD = f'style="border-bottom:1px solid {RULE}"'
TDN = f'style="border-bottom:1px solid {RULE};text-align:right"'


# ── scheduling ──────────────────────────────────────────────────────────────


def last_week_monday(today=None):
    today = frappe.utils.getdate(today or frappe.utils.nowdate())
    return today - timedelta(days=today.weekday() + 7)


def is_send_day(day_name, today=None) -> bool:
    """True when ``today`` is the configured weekday. Pure."""
    today = frappe.utils.getdate(today or frappe.utils.nowdate())
    day_name = day_name if day_name in DAYS else "Monday"
    return DAYS[today.weekday()] == day_name


def settings_for(prefix) -> tuple[bool, str]:
    """(enabled, weekday) of a weekly email; unset means on, Monday."""
    try:
        s = frappe.get_single(SETTINGS)
    except Exception:
        return True, "Monday"
    raw = s.get(f"{prefix}_email_enabled")
    return (True if raw is None else bool(int(raw))), (s.get(f"{prefix}_email_day") or "Monday")


# ── collecting ──────────────────────────────────────────────────────────────


def ingredient_map() -> dict:
    """{Spray Product: [active ingredient, ...]}; a row's label is the linked
    ingredient, else the text as on the label. Rows with neither are skipped."""
    out: dict = {}
    for r in frappe.db.sql(
        """SELECT parent, active_ingredient, ingredient FROM `tabActive Ingredient`
            WHERE parenttype = 'Spray Product' ORDER BY idx""",
        as_dict=True,
    ):
        name = (r.active_ingredient or r.ingredient or "").strip()
        if name:
            lst = out.setdefault(r.parent, [])
            if name.lower() not in {x.lower() for x in lst}:
                lst.append(name)
    return out


def product_lookup() -> dict:
    """{lower(label): {product, name, ingredients, uom}} by Spray Product id,
    display name, item code and item name."""
    ings = ingredient_map()
    rows = frappe.db.sql(
        """SELECT sp.name, sp.product_name, sp.item, i.item_name, i.stock_uom
             FROM `tabSpray Product` sp LEFT JOIN `tabItem` i ON i.name = sp.item""",
        as_dict=True,
    )
    out: dict = {}
    for r in rows:
        rec = {
            "product": r.name, "name": r.product_name or r.item_name or r.name,
            "ingredients": ings.get(r.name, []), "uom": r.stock_uom or "",
        }
        for key in (r.name, r.product_name, r.item, r.item_name):
            if key:
                out.setdefault(key.strip().lower(), rec)
    return out


def _farm_of(location, logged_farm, farm_of_wh) -> str | None:
    return logged_farm or farm_of_wh.get(location) or None


def raw_applications(start, end) -> list[dict]:
    """One dict per (application, product): source, doc, date, farm, location,
    product label, quantity. Logsheets first, then plans without one."""
    sheets = frappe.db.sql(
        """SELECT sal.name AS doc, sal.work_order, sal.date, sal.farm, sal.target_gh AS location,
                  p.pesticide_name AS label, p.pesticide_quantity AS qty
             FROM `tabSpray Application Logsheet` sal
             JOIN `tabSpray Application Pesticide` p
               ON p.parent = sal.name AND p.parenttype = 'Spray Application Logsheet'
            WHERE sal.docstatus = 1 AND sal.date BETWEEN %s AND %s
              AND IFNULL(p.pesticide_name, '') != ''""",
        (start, end), as_dict=True,
    )
    covered = {s.work_order for s in sheets if s.work_order}
    # A plan with a logsheet in ANY period is a logsheet application, so a
    # logsheet submitted a day late does not double count its plan.
    has_sheet = set(frappe.db.sql_list(
        """SELECT DISTINCT work_order FROM `tabSpray Application Logsheet`
            WHERE docstatus = 1 AND IFNULL(work_order, '') != ''"""
    )) | covered
    plans = frappe.db.sql(
        """SELECT wo.name AS doc, DATE(COALESCE(wo.actual_end_date, wo.actual_start_date,
                                                wo.planned_start_date)) AS date,
                  wo.custom_greenhouse AS location, woi.item_code AS label, woi.required_qty AS qty
             FROM `tabWork Order` wo
             JOIN `tabWork Order Item` woi ON woi.parent = wo.name AND woi.parenttype = 'Work Order'
            WHERE wo.custom_type = %s AND wo.docstatus = 1 AND wo.status IN ('Completed', 'Closed')
              AND DATE(COALESCE(wo.actual_end_date, wo.actual_start_date, wo.planned_start_date)) BETWEEN %s AND %s""",
        (AFP, start, end), as_dict=True,
    )
    plans = [p for p in plans if p.doc not in has_sheet]
    for s in sheets:
        s["source"] = "Logsheet"
    for p in plans:
        p["source"] = "Work order"
        p["farm"] = None
    return list(sheets) + list(plans)


def build_rows(apps, lookup, farm_of_wh, names_for_item=None) -> dict:
    """Group applications into per-farm rows. Pure given its inputs.

    Returns ``{farm: {"rows": [...], "detail": [...], "unrecorded": {product: n}}}``.
    A work-order row only counts when its item is a known Spray Product (plans
    also hold packaging and the like); a logsheet row counts whatever it names.
    """
    farms: dict = {}
    for a in apps:
        hit = lookup.get((a["label"] or "").strip().lower())
        if a["source"] == "Work order" and not hit:
            continue
        name = hit["name"] if hit else (a["label"] or "").strip()
        ings = (hit or {}).get("ingredients") or []
        farm = _farm_of(a["location"], a.get("farm"), farm_of_wh) or "No farm"
        qty = float(a["qty"] or 0)
        f = farms.setdefault(farm, {"agg": OrderedDict(), "detail": [], "unrecorded": {}})
        labels = ings or [NOT_RECORDED]
        if not ings:
            f["unrecorded"][name] = f["unrecorded"].get(name, 0) + 1
        for ing in labels:
            key = (a["location"] or "Unknown", ing, name)
            g = f["agg"].setdefault(key, {
                "location": key[0], "ingredient": ing, "product": name, "applications": set(),
                "quantity": 0.0, "last": None, "uom": (hit or {}).get("uom") or "",
                "also": [i for i in ings if i != ing],
            })
            g["applications"].add((a["doc"], a["location"]))
            g["quantity"] += qty
            d = frappe.utils.getdate(a["date"]) if a["date"] else None
            if d and (g["last"] is None or d > g["last"]):
                g["last"] = d
        f["detail"].append({
            "date": a["date"], "doc": a["doc"], "source": a["source"], "location": a["location"] or "",
            "product": name, "ingredients": ", ".join(ings) or NOT_RECORDED, "quantity": qty,
            "uom": (hit or {}).get("uom") or "",
        })
    out = {}
    for farm, f in farms.items():
        rows = []
        for g in f["agg"].values():
            rows.append({**g, "applications": len(g["applications"]), "quantity": round(g["quantity"], 3)})
        # Not-recorded last within a location so the real ingredients lead.
        rows.sort(key=lambda r: (r["location"], r["ingredient"] == NOT_RECORDED, r["ingredient"], r["product"]))
        f["detail"].sort(key=lambda d: (str(d["date"]), d["location"], d["product"]))
        out[farm] = {"rows": rows, "detail": f["detail"], "unrecorded": dict(sorted(f["unrecorded"].items()))}
    return out


def collect(monday) -> dict:
    sunday = monday + timedelta(days=6)
    apps = raw_applications(monday, sunday)
    locs = {a["location"] for a in apps if a["location"]}
    farm_of_wh = dict(frappe.get_all(
        "Warehouse", filters={"name": ["in", list(locs)]}, fields=["name", "custom_farm"], as_list=True,
        limit_page_length=0,
    )) if locs else {}
    farms = build_rows(apps, product_lookup(), farm_of_wh)
    return {"monday": monday, "sunday": sunday, "farms": farms}


# ── rendering ───────────────────────────────────────────────────────────────


def week_label(data) -> str:
    y, w, _ = data["monday"].isocalendar()
    return f"Week {w}, {y} ({data['monday']:%d %b} to {data['sunday']:%d %b})"


def subject(farm, data, test=False) -> str:
    s = f"{farm}: spray records, week {data['monday'].isocalendar()[1]}"
    return f"[Test] {s}" if test else s


def filename(farm, data) -> str:
    y, w, _ = data["monday"].isocalendar()
    return f"{farm}_spray_records_{y}-W{w:02d}.xlsx".replace(" ", "_")


def _qty(v) -> str:
    return f"{v:,.2f}".rstrip("0").rstrip(".") if v else "0"


def render(farm, data, test=False) -> str:
    esc = frappe.utils.escape_html
    f = data["farms"].get(farm) or {"rows": [], "detail": [], "unrecorded": {}}
    rows = f["rows"]
    apps = len({(d["doc"], d["location"]) for d in f["detail"]})
    shown = rows[:MAX_ROWS]
    body = []
    for r in shown:
        also = (f'<br><small style="color:{MUTED};">also contains {esc(", ".join(r["also"]))}; '
                f'full quantity listed under each</small>') if r["also"] else ""
        ing = (f'<span style="color:{BAD};">{esc(r["ingredient"])}</span>' if r["ingredient"] == NOT_RECORDED
               else esc(r["ingredient"]))
        last = f"{r['last']:%d %b}" if r["last"] else ""
        body.append(
            f'<tr valign="top"><td {TD}>{esc(r["location"])}</td><td {TD}>{ing}</td>'
            f'<td {TD}>{esc(r["product"])}{also}</td><td {TDN}>{r["applications"]}</td>'
            f'<td {TDN}>{_qty(r["quantity"])} {esc(r["uom"])}</td><td {TDN}>{last}</td></tr>'
        )
    more = (f'<p style="margin:0 0 8px 0;color:{MUTED};font-size:11px;">and {len(rows) - len(shown)} more rows, '
            f"in the attached workbook.</p>") if len(rows) > len(shown) else ""
    missing = ""
    if f["unrecorded"]:
        items = ", ".join(f"{esc(p)} ({n})" for p, n in list(f["unrecorded"].items())[:40])
        missing = (
            f'<p style="margin:14px 0 0 0;font-size:12px;"><b style="color:{BAD};">Active ingredient not recorded</b> '
            f"for {len(f['unrecorded'])} product(s) sprayed this week: {items}. "
            f'Please add the active ingredients on each product\'s Spray Product record.</p>'
        )
    table = (
        f"<table {TABLE}><tr><th {TH}>Location</th><th {TH}>Active ingredient</th><th {TH}>Product</th>"
        f"<th {THN}>Applications</th><th {THN}>Quantity</th><th {THN}>Last</th></tr>{''.join(body)}</table>{more}"
        if rows else f'<p style="color:{MUTED};">Nothing was sprayed at this farm this week.</p>'
    )
    test_note = f'<p style="margin:0 0 10px 0;color:{MUTED};font-size:12px;"><b>Test email</b>: not the scheduled report.</p>' if test else ""
    return (
        f'<div style="font-family:Poppins,Arial,sans-serif;color:{INK};max-width:820px;">{test_note}'
        f'<h2 style="margin:0 0 4px 0;font-size:19px;">Spray records: {esc(farm)}</h2>'
        f'<p style="margin:0 0 16px 0;color:{MUTED};font-size:13px;">{week_label(data)} · {apps} application(s) · '
        f'{len({r["location"] for r in rows})} location(s) · {len({r["product"] for r in rows})} product(s)</p>'
        f"{table}{missing}"
        f'<p style="margin:16px 0 0 0;color:{MUTED};font-size:11px;">Quantities come from the spray logsheet; a plan with '
        f"no logsheet uses its planned quantity. A product with more than one active ingredient is listed under each, "
        f"with its full quantity. The detail of every application is in the attached workbook.</p></div>"
    )


def workbook_bytes(farm, data) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Font

    f = data["farms"].get(farm) or {"rows": [], "detail": [], "unrecorded": {}}
    wb = Workbook()
    ws = wb.active
    ws.title = "Summary"
    ws.append(["Location", "Active ingredient", "Product", "Applications", "Quantity", "Unit", "Last date", "Also contains"])
    for r in f["rows"]:
        ws.append([r["location"], r["ingredient"], r["product"], r["applications"], r["quantity"], r["uom"],
                   r["last"], ", ".join(r["also"])])
    ws2 = wb.create_sheet("Detail")
    ws2.append(["Date", "Document", "Source", "Location", "Product", "Active ingredients", "Quantity", "Unit"])
    for d in f["detail"]:
        ws2.append([d["date"], d["doc"], d["source"], d["location"], d["product"], d["ingredients"], d["quantity"], d["uom"]])
    ws3 = wb.create_sheet("Ingredient not recorded")
    ws3.append(["Product", "Applications this week"])
    for p, n in f["unrecorded"].items():
        ws3.append([p, n])
    for sheet in wb.worksheets:
        for c in sheet[1]:
            c.font = Font(bold=True)
        for col in sheet.columns:
            sheet.column_dimensions[col[0].column_letter].width = min(40, max(10, max(len(str(c.value or "")) for c in col) + 2))
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ── sending ─────────────────────────────────────────────────────────────────


def send_farm(farm, data, *, only_to=None) -> dict:
    recipients = [only_to] if only_to else C.recipients_for_farm(farm)
    if not recipients:
        return {"sent": False, "reason": "no recipients"}
    company = frappe.db.get_value("Farm", farm, "company") if frappe.db.exists("Farm", farm) else None
    try:
        frappe.sendmail(
            recipients=recipients, subject=subject(farm, data, bool(only_to)),
            message=render(farm, data, bool(only_to)),
            attachments=[{"fname": filename(farm, data), "fcontent": workbook_bytes(farm, data)}],
            sender=report_sender(company),
        )
    except Exception:
        frappe.log_error(frappe.get_traceback(), f"spray records email: {farm}")
        return {"sent": False, "reason": "send failed"}
    return {"sent": True, "recipients": recipients}


def send_weekly_spray_records(today=None, force=False) -> list:
    """Daily scheduler entry: sends on the configured weekday, for last ISO week."""
    enabled, day = settings_for("spray_records")
    if not force and (not enabled or not is_send_day(day, today)):
        return []
    data = collect(last_week_monday(today))
    out = []
    for farm in data["farms"]:
        if farm == "No farm":
            continue
        out.append({"farm": farm, **send_farm(farm, data)})
    frappe.db.commit()
    return out


def _may_trigger():
    if not set(frappe.get_roles(frappe.session.user)) & {"SCP General Manager", "System Manager", "Administrator"}:
        frappe.throw("Not permitted.", frappe.PermissionError)


def _pick(farm=None, week_start=None):
    data = collect(frappe.utils.getdate(week_start) if week_start else last_week_monday())
    farms = [f for f in data["farms"] if f != "No farm"]
    if not farm:
        farm = max(farms, key=lambda f: len(data["farms"][f]["detail"]), default=None)
    if not farm:
        frappe.throw("Nothing was sprayed in that week.")
    return farm, data


@frappe.whitelist()
def preview_spray_records_email(farm=None, week_start=None) -> str:
    _may_trigger()
    farm, data = _pick(farm, week_start)
    return render(farm, data, test=True)


@frappe.whitelist()
def send_test_spray_records_email(farm=None, week_start=None) -> dict:
    _may_trigger()
    farm, data = _pick(farm, week_start)
    email = frappe.db.get_value("User", frappe.session.user, "email") or frappe.session.user
    if "@" not in (email or ""):
        frappe.throw("Your user has no email address to send the test to.")
    return {**send_farm(farm, data, only_to=email), "to": email, "farm": farm}
