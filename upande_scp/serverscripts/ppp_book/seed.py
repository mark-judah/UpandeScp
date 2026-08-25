"""Seed Chemical / Foliar metadata from the Plant Protection Products book.

Fill-blanks-only and idempotent: an existing value is never overwritten, so
agronomist corrections survive a re-run and the loader is safe to run again.

Targets resolve by ACTIVE INGREDIENT as well as by the product's own section.
Each sheet files a product under exactly one heading, so section matching alone
yields no multi-target products at all; the active-ingredient map recovers the
genuine broad-spectrum activity the layout hides.

Provenance rule: Sheet1 (Mona) supplies every field. Sheet2 (Equator Flowers)
supplies targets only — the farms disagree on rates for 31 of 58 shared
products, and a rate gates what physically goes in a sprayer.

Run:  bench --site mona.local execute \
        upande_scp.serverscripts.ppp_book.seed.seed_from_book
"""
from __future__ import annotations

import difflib

import frappe

from upande_scp.serverscripts.common import crop_protection
from upande_scp.serverscripts.ppp_book import parse

FUZZY_CUTOFF = 0.85
_CODE_MASTER = {"frac": "FRAC Code", "irac": "IRAC Code"}


def _item_index(kind):
    groups = list(crop_protection.product_groups(kind))
    if not groups:
        return {}
    items = frappe.get_all(
        "Item",
        filters={"item_group": ["in", groups], "disabled": 0},
        fields=["name", "item_name"],
    )
    return {parse.norm_product(i.item_name or i.name): i.name for i in items}


def _resolve(key, index, keys):
    if key in index:
        return index[key]
    match = difflib.get_close_matches(key, keys, n=1, cutoff=FUZZY_CUTOFF)
    return index[match[0]] if match else None


def _ensure_pest(name):
    """Create a Pest master if a stocked product actually targets it.

    `Pest` autonames from `common_name` (autoname: field:common_name), NOT
    `pest_name` — setting the wrong field makes naming fail, and because the
    caller is failure-isolated that silently costs the whole product its
    targets rather than just the one.
    """
    if not frappe.db.exists("Pest", name):
        frappe.get_doc({"doctype": "Pest", "common_name": name}).insert(
            ignore_permissions=True, ignore_if_duplicate=True
        )


def _fill(doc, field, value):
    """Set only when the field is currently blank. True if written."""
    if value in (None, "") or doc.get(field):
        return False
    doc.set(field, value)
    return True


def _code_table_for(code, prefer):
    """'frac' | 'irac' | None — whichever master actually holds this code."""
    other = "irac" if prefer == "frac" else "frac"
    for table in (prefer, other):
        if frappe.db.exists(_CODE_MASTER[table], code):
            return table
    return None


@frappe.whitelist()
def seed_from_book(path=None, dry_run=False):
    rows = parse.parse_workbook(path or parse.DEFAULT_WORKBOOK)
    amap = parse.active_target_map(rows)

    chem_index = _item_index("chemical")
    foliar_index = _item_index("foliar")
    chem_keys, foliar_keys = list(chem_index), list(foliar_index)

    resolved: dict[str, dict] = {}
    conflicts = []
    sections: dict[str, set] = {}

    for r in rows:
        code = _resolve(r["key"], chem_index, chem_keys)
        kind = "chemical"
        if not code:
            code = _resolve(r["key"], foliar_index, foliar_keys)
            kind = "foliar"
        if not code:
            continue

        targets = set(r["targets"])
        for a in r["actives"]:
            targets |= amap.get(a, set())

        entry = resolved.setdefault(code, {"kind": kind, "targets": set(), "row": None})
        entry["targets"] |= targets
        if r["sheet"] == parse.MONA_SHEET and entry["row"] is None:
            entry["row"] = r

        prior = sections.setdefault(code, set())
        if prior and r["section"] not in prior:
            conflicts.append({
                "product": r["product"], "item": code,
                "sections": sorted(prior | {r["section"]}),
            })
        prior.add(r["section"])

    report = {
        "matched": len(resolved),
        "targets_written": 0,
        "fields_written": 0,
        "unknown_codes": [],
        "conflicts": conflicts,
        "uncovered": sorted(set(chem_index.values()) - set(resolved)),
        "skipped_existing": 0,
    }
    if dry_run:
        return report

    pests = set(frappe.get_all("Pest", pluck="name"))
    diseases = set(frappe.get_all("Plant Disease", pluck="name"))

    for code, entry in sorted(resolved.items()):
        master = "Chemical" if entry["kind"] == "chemical" else "Foliar"
        name = frappe.db.get_value(master, {"item": code}, "name")
        if not name:
            continue
        try:
            doc = frappe.get_doc(master, name)
            dirty = False

            if doc.get("default_targets"):
                report["skipped_existing"] += 1
            else:
                wrote = False
                for t in sorted(entry["targets"]):
                    if t == "Nematodes":
                        _ensure_pest(t)
                        pests.add(t)
                    if t in pests:
                        doc.append("default_targets", {"pest": t})
                        wrote = True
                    elif t in diseases:
                        doc.append("default_targets", {"disease": t})
                        wrote = True
                if wrote:
                    dirty = True
                    report["targets_written"] += 1

            row = entry["row"]
            if row:
                for field, value in (
                    ("registration_no", row["registration_no"]),
                    ("formulation", row["formulation"]),
                    ("toxicity", row["toxicity"]),
                    ("default_lower_rate_limit", row["rate_low"]),
                    ("default_upper_rate_limit", row["rate_high"]),
                ):
                    if _fill(doc, field, value):
                        dirty = True
                        report["fields_written"] += 1

                if not doc.get("active_ingredients"):
                    for a in row["actives"]:
                        doc.append("active_ingredients", {"ingredient": a})
                        dirty = True

                prefer = "irac" if (entry["targets"] & pests) else "frac"
                for c in row["codes"]:
                    table = _code_table_for(c, prefer)
                    if not table:
                        report["unknown_codes"].append({"item": code, "code": c})
                        continue
                    if doc.get(table):
                        continue
                    doc.append(table, {"code": c})
                    dirty = True

            if dirty:
                doc.save(ignore_permissions=True)
        except Exception:
            frappe.log_error(frappe.get_traceback(), f"seed_from_book: {code}")

    frappe.db.commit()
    return report
