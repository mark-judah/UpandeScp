"""Printable issue list for the store: what to hand out on a spray day.

The keeper can already see the draft transfers on screen; this prints them. For
one SPRAY DAY (the plan's ``custom_scheduled_application_time``, not the draft's
posting date) it lists every Material Transfer for Manufacture of an Application
Floor Plan, grouped farm -> greenhouse -> plan, with a pick list (per-greenhouse
and day totals per chemical) and signature lines.

* Drafts are the "to issue" section. Submitted transfers for the same day come
  after, in a small "already issued" section, so the keeper can reconcile.
* Each line carries a small QR made by the same ``generate_qr_base64`` as the
  labels. Payload: the line's traceable code when one already exists (early
  labels mint them), otherwise the plain ``item code / qty uom`` text. This module
  NEVER mints codes: a printed sheet must not create traceability records nobody
  asked for, and an unlabelled line still scans to something useful.
* Rendering is wkhtmltopdf through pdfkit, the same path as the Labels PDF.
"""

from __future__ import annotations

import base64
import re
from collections import OrderedDict

import frappe
from frappe.utils import escape_html, get_datetime, now_datetime

from upande_scp.serverscripts.common import farm_map
from upande_scp.serverscripts.common.place_filter import parse_names
from upande_scp.serverscripts.qr.chemical_labels import AFP_TYPE, TRANSFER_PURPOSE
from upande_scp.serverscripts.qr.qr_generator import generate_qr_base64
from upande_scp.serverscripts.store import store_keeper_api

# wkhtmltopdf here is the unpatched build that shrinks CSS by 0.768 (see the
# labels module); zoom puts text back at its stated size.
_ZOOM = 1.0 / 0.768
_NO_FARM = "No farm"
_NO_HOUSE = "No greenhouse"


def _fmt(n) -> str:
    try:
        v = float(n or 0)
    except (TypeError, ValueError):
        return str(n)
    return str(int(v)) if v == int(v) else f"{v:.3f}".rstrip("0").rstrip(".")


def _supervisor(team_text) -> str:
    """The supervisor line out of the plan's team snapshot ("NAME - Supervisor")."""
    for line in str(team_text or "").splitlines():
        m = re.match(r"^\s*(.+?)\s+-\s+Supervisor\s*$", line, re.I)
        if m:
            return m.group(1)
    return ""


def _spray_day(date) -> str:
    d = str(date or "").strip()[:10]
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", d):
        frappe.throw("date must be YYYY-MM-DD")
    return d


# ----------------------------------------------------------------------
# Data
# ----------------------------------------------------------------------
def _transfer_rows(day: str) -> list[dict]:
    return frappe.db.sql(
        """
        SELECT se.name AS se, se.docstatus, se.to_warehouse, se.from_warehouse,
               wo.name AS wo, wo.custom_greenhouse AS greenhouse,
               wo.custom_spray_type AS spray_type,
               wo.custom_scheduled_application_time AS scheduled,
               wo.custom_spray_team AS team, wo.workflow_state AS state
        FROM   `tabStock Entry` se
        JOIN   `tabWork Order`  wo ON wo.name = se.work_order
        WHERE  se.docstatus IN (0, 1)
          AND  se.purpose = %(purpose)s
          AND  wo.custom_type = %(afp)s
          AND  wo.docstatus < 2
          AND  DATE(wo.custom_scheduled_application_time) = %(day)s
        ORDER  BY wo.custom_scheduled_application_time, wo.name, se.creation
        """,
        {"purpose": TRANSFER_PURPOSE, "afp": AFP_TYPE, "day": day},
        as_dict=True,
    )


def _lines_for(se_names: list[str]) -> dict[str, list[dict]]:
    if not se_names:
        return {}
    rows = frappe.db.sql(
        """
        SELECT parent, idx, item_code, item_name, qty, uom, stock_uom,
               s_warehouse, batch_no
        FROM   `tabStock Entry Detail`
        WHERE  parent IN %(p)s
        ORDER  BY parent, idx
        """,
        {"p": se_names},
        as_dict=True,
    )
    out: dict[str, list[dict]] = {}
    for r in rows:
        out.setdefault(r["parent"], []).append(r)
    return out


def _codes_for(se_names: list[str]) -> dict[tuple, str]:
    """(stock entry, line idx) -> live traceable code. Read only; never mints."""
    if not se_names or not frappe.db.table_exists("Chemical QR Label"):
        return {}
    rows = frappe.get_all(
        "Chemical QR Label",
        filters={"stock_entry": ["in", se_names], "voided": 0},
        fields=["stock_entry", "se_line_idx", "code"],
        limit_page_length=0,
    )
    return {(r["stock_entry"], r["se_line_idx"]): r["code"] for r in rows}


def qr_payload(code: str | None, item_code: str, qty, uom: str) -> str:
    return code or f"{item_code}\n{_fmt(qty)} {uom}".strip()


def collect(date, farms=None, greenhouses=None) -> dict:
    """The day's transfers as plain data (no HTML). ``farms``/``greenhouses``
    take one name or several; empty means everything the user may see."""
    day = _spray_day(date)
    want_farms = set(parse_names(farms))
    want_houses = set(parse_names(greenhouses))

    allowed = store_keeper_api._allowed_farms_for()
    rows = _transfer_rows(day)

    wh_names = {r["greenhouse"] for r in rows if r["greenhouse"]}
    wh_names |= {r["to_warehouse"] for r in rows if r["to_warehouse"]}
    wh_names |= {r["from_warehouse"] for r in rows if r["from_warehouse"]}
    farm_of = farm_map.farms_for_warehouses(wh_names)

    kept = []
    for r in rows:
        r["farm"] = (
            farm_of.get(r["greenhouse"]) or farm_of.get(r["to_warehouse"])
            or farm_of.get(r["from_warehouse"]) or ""
        )
        if allowed is not None and r["farm"] not in allowed:
            continue
        if want_farms and r["farm"] not in want_farms:
            continue
        if want_houses and r["greenhouse"] not in want_houses:
            continue
        kept.append(r)

    se_names = [r["se"] for r in kept]
    lines = _lines_for(se_names)
    codes = _codes_for(se_names)

    tree: "OrderedDict[str, OrderedDict[str, list]]" = OrderedDict()
    day_totals: dict[tuple, dict] = {}
    house_totals: dict[tuple, dict] = {}
    n_issue = n_issued = 0

    def add_total(bucket, key, ln, qty, uom):
        t = bucket.setdefault(
            key + (ln["item_code"], uom),
            {"item_code": ln["item_code"], "item_name": ln["item_name"] or ln["item_code"],
             "uom": uom, "qty": 0.0},
        )
        t["qty"] += qty

    for r in sorted(kept, key=lambda x: (x["farm"] or "~", x["greenhouse"] or "~",
                                         str(x["scheduled"]), x["wo"])):
        issued = r["docstatus"] == 1
        plan = {
            "wo": r["wo"], "se": r["se"], "state": r["state"] or "",
            "spray_type": r["spray_type"] or "",
            "scheduled": get_datetime(r["scheduled"]).strftime("%H:%M") if r["scheduled"] else "",
            "supervisor": _supervisor(r["team"]), "issued": issued, "lines": [],
        }
        farm = r["farm"] or _NO_FARM
        house = r["greenhouse"] or _NO_HOUSE
        for ln in lines.get(r["se"], []):
            uom = ln["uom"] or ln["stock_uom"] or ""
            qty = float(ln["qty"] or 0)
            plan["lines"].append({
                "item_code": ln["item_code"], "item_name": ln["item_name"] or ln["item_code"],
                "qty": qty, "uom": uom, "source": ln["s_warehouse"] or r["from_warehouse"] or "",
                "batch": ln["batch_no"] or "",
                "qr": qr_payload(codes.get((r["se"], ln["idx"])), ln["item_code"], qty, uom),
                "coded": (r["se"], ln["idx"]) in codes,
            })
            if not issued:
                add_total(house_totals, (farm, house), ln, qty, uom)
                add_total(day_totals, (), ln, qty, uom)
        if issued:
            n_issued += 1
        else:
            n_issue += 1
        tree.setdefault(farm, OrderedDict()).setdefault(house, []).append(plan)

    def totals_list(bucket, prefix=()):
        got = [v for k, v in bucket.items() if k[: len(prefix)] == prefix]
        return sorted(got, key=lambda t: (t["item_name"].lower(), t["uom"]))

    farms_out = []
    for farm, houses in tree.items():
        farms_out.append({
            "farm": farm,
            "houses": [
                {"greenhouse": h, "plans": plans, "totals": totals_list(house_totals, (farm, h))}
                for h, plans in houses.items()
            ],
        })
    return {
        "date": day, "farms": farms_out, "totals": totals_list(day_totals),
        "to_issue": n_issue, "issued": n_issued,
    }


# ----------------------------------------------------------------------
# HTML
# ----------------------------------------------------------------------
_CSS = """
@page { size: A4; }
body { font-family: Poppins, 'Helvetica Neue', Arial, sans-serif; font-size: 8.5pt; color: #1b1b1b; margin: 0; }
h1 { font-size: 15pt; margin: 0 0 2px 0; }
.meta { color: #666; font-size: 7.5pt; margin-bottom: 8px; }
h2 { font-size: 11pt; margin: 14px 0 4px 0; padding-bottom: 2px; border-bottom: 1.5px solid #1b1b1b; }
h3 { font-size: 9.5pt; margin: 8px 0 3px 0; }
.plan { page-break-inside: avoid; margin-bottom: 8px; }
.planhead { font-size: 8pt; color: #444; margin-bottom: 2px; }
table { width: 100%; font-size: 8.5pt; border-collapse: collapse; }
th { text-align: left; font-size: 7pt; text-transform: uppercase; letter-spacing: .04em; color: #666; border-bottom: 1px solid #bbb; padding: 2px 4px; }
td { font-size: 8.5pt; padding: 2px 4px; border-bottom: 1px solid #e5e5e5; vertical-align: middle; }
td.n, th.n { text-align: right; white-space: nowrap; }
td.q { width: 34px; text-align: center; }
td.q img { width: 30px; height: 30px; display: block; margin: 1px auto; }
.mono { font-family: 'DejaVu Sans Mono', monospace; font-size: 7.5pt; }
.pick { margin: 3px 0 6px 0; page-break-inside: avoid; }
.pick th { background: #f3f3f3; }
.tag { display: inline-block; border: 1px solid #999; border-radius: 8px; padding: 0 6px; font-size: 7pt; color: #444; }
.sig { margin-top: 26px; page-break-inside: avoid; }
.sig td { border: 0; padding: 0 12px 0 0; width: 33%; }
.sig .ln { border-top: 1px solid #333; padding-top: 2px; font-size: 7.5pt; color: #555; }
.empty { color: #666; margin: 12px 0; }
"""


def _totals_table(totals: list[dict]) -> str:
    body = "".join(
        f"<tr><td>{escape_html(t['item_name'])}</td><td class=mono>{escape_html(t['item_code'])}</td>"
        f"<td class=n>{_fmt(t['qty'])} {escape_html(t['uom'])}</td></tr>"
        for t in totals
    )
    return ("<table class=pick><tr><th>Chemical</th><th>Item code</th><th class=n>Total to issue</th></tr>"
            f"{body}</table>")


def _plan_html(plan: dict, with_qr: bool) -> str:
    bits = [escape_html(plan["wo"]), escape_html(plan["spray_type"]), plan["scheduled"]]
    if plan["supervisor"]:
        bits.append("Supervisor: " + escape_html(plan["supervisor"]))
    head = " &middot; ".join(b for b in bits if b)
    rows = []
    for ln in plan["lines"]:
        qr = ""
        if with_qr:
            b64 = generate_qr_base64(ln["qr"], box_size=3, border=1, error_correction="M")
            qr = f"<td class=q><img src='data:image/png;base64,{b64}'></td>" if b64 else "<td class=q></td>"
        rows.append(
            f"<tr><td>{escape_html(ln['item_name'])}</td><td class=mono>{escape_html(ln['item_code'])}</td>"
            f"<td class=n>{_fmt(ln['qty'])} {escape_html(ln['uom'])}</td>"
            f"<td>{escape_html(ln['source'])}</td><td class=mono>{escape_html(ln['batch'] or '-')}</td>{qr}</tr>"
        )
    qh = "<th class=q>QR</th>" if with_qr else ""
    return (
        f"<div class=plan><div class=planhead>{head}</div><table>"
        f"<tr><th>Chemical</th><th>Item code</th><th class=n>Quantity</th><th>Source store</th><th>Batch</th>{qh}</tr>"
        f"{''.join(rows)}</table></div>"
    )


def render_html(data: dict, company: str = "", generated_by: str = "", generated_at: str = "") -> str:
    out = [f"<!doctype html><html><head><meta charset='utf-8'><style>{_CSS}</style></head><body>"]
    out.append(f"<h1>Chemical issue list &middot; {escape_html(data['date'])}</h1>")
    out.append(
        f"<div class=meta>{escape_html(company)} &middot; {data['to_issue']} to issue, "
        f"{data['issued']} already issued &middot; generated {escape_html(generated_at)} "
        f"by {escape_html(generated_by)}</div>"
    )
    if not data["farms"]:
        out.append("<div class=empty>No transfers are planned for this day and selection.</div>")
    for section, issued in (("To issue", False), ("Already issued", True)):
        body = []
        for f in data["farms"]:
            hb = []
            for h in f["houses"]:
                plans = [p for p in h["plans"] if p["issued"] == issued]
                if not plans:
                    continue
                hb.append(f"<h3>{escape_html(h['greenhouse'])}</h3>")
                hb += [_plan_html(p, with_qr=not issued) for p in plans]
                if not issued:
                    hb.append(f"<div class=planhead>Pick list &middot; {escape_html(h['greenhouse'])}</div>"
                              + _totals_table(h["totals"]))
            if hb:
                body.append(f"<h2>{escape_html(f['farm'])}</h2>" + "".join(hb))
        if not body:
            continue
        out.append(f"<h2 style='border-bottom:0;font-size:12pt;margin-top:16px'>{section}</h2>")
        out += body
        if not issued:
            out.append("<h2>Day totals (all selected greenhouses)</h2>" + _totals_table(data["totals"]))
            out.append("<table class=sig><tr><td><div class=ln>Issued by (name / signature)</div></td>"
                       "<td><div class=ln>Received by (name / signature)</div></td>"
                       "<td><div class=ln>Date / time</div></td></tr></table>")
    out.append("</body></html>")
    return "".join(out)


def build_pdf(data: dict, html_only: bool = False):
    import pdfkit

    company = frappe.defaults.get_global_default("company") or ""
    html = render_html(
        data, company, frappe.utils.get_fullname(frappe.session.user),
        now_datetime().strftime("%Y-%m-%d %H:%M"),
    )
    if html_only:
        return html
    return pdfkit.from_string(
        html,
        options={
            "page-size": "A4", "margin-top": "12mm", "margin-bottom": "14mm",
            "margin-left": "10mm", "margin-right": "10mm", "encoding": "UTF-8",
            "zoom": str(_ZOOM), "quiet": "", "enable-local-file-access": "",
            "footer-center": "[page] / [topage]", "footer-font-size": "7",
        },
    )


def _filename(data: dict, farms) -> str:
    names = parse_names(farms) or [f["farm"] for f in data["farms"]]
    tag = names[0] if len(names) == 1 else ("farms" if names else "all")
    tag = re.sub(r"[^A-Za-z0-9]+", "-", tag).strip("-").lower() or "all"
    return f"issue-list-{tag}-{data['date']}.pdf"


@frappe.whitelist()
def download_issue_list_pdf(date: str | None = None, farms=None, greenhouses=None) -> dict:
    """Base64 PDF of the day's issue list (same envelope as the Labels PDF)."""
    store_keeper_api._check_perm()
    data = collect(date or frappe.utils.nowdate(), farms, greenhouses)
    pdf = build_pdf(data)
    return {
        "data": base64.b64encode(pdf).decode("ascii"),
        "filename": _filename(data, farms),
        "to_issue": data["to_issue"],
        "issued": data["issued"],
    }


@frappe.whitelist()
def issue_list_places() -> dict:
    """farm -> greenhouses that have Application Floor Plans (for the picker)."""
    store_keeper_api._check_perm()
    houses = frappe.get_all(
        "Work Order",
        filters={"custom_type": AFP_TYPE, "docstatus": ["<", 2],
                 "custom_scheduled_application_time": [">=", frappe.utils.add_days(frappe.utils.nowdate(), -120)]},
        pluck="custom_greenhouse", group_by="custom_greenhouse", limit_page_length=0,
    )
    farm_of = farm_map.farms_for_warehouses(houses)
    allowed = store_keeper_api._allowed_farms_for()
    by_farm: dict[str, list] = {}
    for h in houses:
        f = farm_of.get(h)
        if f and (allowed is None or f in allowed):
            by_farm.setdefault(f, []).append(h)
    return {"farms": sorted(by_farm), "greenhouses_by_farm": {f: sorted(v) for f, v in by_farm.items()}}
