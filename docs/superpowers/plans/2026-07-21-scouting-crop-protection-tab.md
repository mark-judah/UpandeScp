# Scouting & Crop Protection Tab (layout enforcer) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship an `after_migrate` layout enforcer that puts each of five shared doctypes' SCP custom fields into one "Scouting and Crop Protection" tab, with zero foreign fields intruding.

**Architecture:** A code function (authoritative, runs after fixture sync) reorganizes only `insert_after` on custom fields of Item, Work Order, Warehouse, BOM, Farm — using a hard-coded, evidence-based classification. A meta-walk verifier (zero orphans, zero intruders, one tab, idempotent) is the acceptance oracle; the implementer iterates the enforcer until it passes.

**Tech Stack:** Frappe (Custom Field, get_meta, after_migrate hook), Python, `bench migrate`.

## Global Constraints

- **Layout only.** Only custom-field `insert_after` changes (+ 4 created Tab Break rows). No field renamed/retyped/removed; no standard field touched; no behavior change.
- **Classification is fixed** (from spec v3, by cross-app code reference). Do not add name-guessed fields. The exact per-doctype SCP lists are in the enforcer's `SCP_FIELDS` below — treat them as the spec.
- **Excluded:** BOM Item, Work Order Item (child tables), Spray Team (SCP's own), upande_ta.
- Item's tab break already exists — keep it and its `depends_on: eval:doc.item_group=='CHEMICALS'`. The 4 created tab breaks have `depends_on` null, `module` null.
- **No `Co-Authored-By` trailer.** Commit only `upande_scp/serverscripts/common/scouting_tab_layout.py` (new) and `upande_scp/hooks.py`. Never `git add -A`.
- Paths: app `/home/ubuntu/stive/code/frappe15/apps/upande_scp`; bench `/home/ubuntu/stive/code/frappe15`; env python `.../env/bin/python`; sites `.../sites`; site `kaitet.local`; scratchpad `$SP` = `/tmp/claude-1001/-home-ubuntu-stive-code-frappe15-apps-upande-scp/a8af0d3e-4a44-44d3-8d59-aaabea670d65/scratchpad`.
- Never use any Kaitet MCP tool.

---

### Task 1: Enforcer + hook, applied and verified

**Files:**
- Create: `upande_scp/serverscripts/common/scouting_tab_layout.py`
- Modify: `upande_scp/hooks.py` (append to `after_migrate`)
- Create (scratchpad, NOT committed): `$SP/tab_verify.py`

**Interfaces:**
- Produces: `upande_scp.serverscripts.common.scouting_tab_layout.enforce(doc=None, method=None)` registered on `after_migrate`.

- [ ] **Step 1: Write the verifier oracle**

Create `$SP/tab_verify.py`:

```python
import frappe
frappe.init(site="kaitet.local", sites_path="/home/ubuntu/stive/code/frappe15/sites")
frappe.connect()
from upande_scp.serverscripts.common.scouting_tab_layout import SCP_FIELDS, TAB

ok = True
for dt, fields in SCP_FIELDS.items():
    frappe.clear_cache(doctype=dt)
    meta = frappe.get_meta(dt, cached=False)
    cur, field_tab, ntab = None, {}, 0
    for df in meta.fields:
        if df.fieldtype == "Tab Break":
            cur = df.fieldname
            if df.fieldname == TAB:
                ntab += 1
        field_tab[df.fieldname] = cur
    present = [f for f in fields if f in field_tab]
    scp = set(present)
    orphans = sorted(f for f in present if field_tab.get(f) != TAB)
    intruders = sorted(f for f, t in field_tab.items() if t == TAB and f not in scp and f != TAB)
    good = (ntab == 1 and not orphans and not intruders)
    ok = ok and good
    print(f"{dt}: tab={ntab} present={len(present)}/{len(fields)} orphans={orphans} intruders={intruders} -> {'PASS' if good else 'FAIL'}")
print("ALL PASS" if ok else "FAILURES PRESENT")
```

- [ ] **Step 2: Write the enforcer module**

Create `upande_scp/serverscripts/common/scouting_tab_layout.py`. This is a working reference; the verifier (Step 5) is the oracle — if it reports any orphan/intruder or non-idempotency, debug and adjust this module (e.g. the anchor choice or the foreign-detach walk) until Step 5 and Step 6 both pass.

```python
"""after_migrate enforcer: group upande_scp's crop-protection/scouting custom
fields into one 'Scouting and Crop Protection' tab per shared doctype.

Layout only (custom-field insert_after). Idempotent. Classification is fixed
(cross-app code reference; see the design spec) — do NOT infer from names.
"""
import frappe

TAB = "custom_scouting_and_crop_protection_tab"
TAB_LABEL = "Scouting and Crop Protection"

# Ordered SCP fields per doctype (display order under the tab).
SCP_FIELDS = {
    "Item": [
        "custom_type", "custom_frac", "custom_frac_moa", "custom_irac",
        "custom_irac_moa", "custom_ghs", "custom_ghs_description", "custom_toxicity",
        "custom_active_ingredients", "custom_targets", "custom_reentry_interval_hrs",
        "custom_lower_rate_limit", "custom_upper_rate_limit", "custom_low_stock_threshold",
        "custom_section_break_vuei1", "custom_chemical_intervention_threshhold",
    ],
    "Work Order": [
        "custom_type", "custom_classification", "custom_preventive_reason",
        "custom_application_floor_plan", "custom_greenhouse", "custom_reentry_period_hrs",
        "custom_cost_center", "custom_rate_overridden", "custom_weather_snapshot",
        "custom_scheduled_application_time", "custom_reentry_time", "custom_scope",
        "custom_scope_details", "custom_area", "custom_water_volume", "custom_water_ph",
        "custom_water_hardness", "custom_variety", "custom_spray_type", "custom_kit",
        "custom_targets", "custom_spray_team", "custom_spray_plan_team_members",
        "custom_chemical_scans", "custom_spray_application_logsheet",
    ],
    "Warehouse": [
        "custom_location", "custom_raw_geojson", "custom_cost_center",
        "custom_bed_numbering", "custom_zone_numbering", "custom_area_ha",
    ],
    "BOM": [
        "custom_item_group", "custom_water_ph", "custom_water_hardness",
        "custom_work_order",
    ],
    "Farm": [
        "custom_chemical_store", "custom_fertilizer_store", "spray_plan_creators",
        "store_keepers", "spray_plan_approvers",
    ],
}


def enforce(doc=None, method=None):
    """after_migrate entry-point. One doctype failing never aborts the rest."""
    for dt, fields in SCP_FIELDS.items():
        try:
            _enforce_doctype(dt, fields)
        except Exception:
            frappe.log_error(
                title=f"scouting_tab_layout: {dt}",
                message=frappe.get_traceback(),
            )


def _names(dt):
    return {c["fieldname"]: c["name"] for c in frappe.get_all(
        "Custom Field", filters={"dt": dt}, fields=["name", "fieldname"])}


def _order(dt):
    return [df.fieldname for df in frappe.get_meta(dt, cached=False).fields]


def _preceding_non_scp(field, order, scp):
    """Nearest field before `field` (in order) that is not an SCP field."""
    idx = order.index(field) if field in order else len(order)
    for j in range(idx - 1, -1, -1):
        if order[j] not in scp:
            return order[j]
    return order[0] if order else None


def _set_after(name, new_ia):
    """Set insert_after on one Custom Field only if it changed. Returns 1/0."""
    if frappe.db.get_value("Custom Field", name, "insert_after") == new_ia:
        return 0
    cf = frappe.get_doc("Custom Field", name)
    cf.insert_after = new_ia
    cf.save(ignore_permissions=True)
    return 1


def _enforce_doctype(dt, scp_fields):
    scp = set(scp_fields) | {TAB}
    order = _order(dt)
    anchor = next((fn for fn in reversed(order) if fn not in scp), order[-1])

    # 1. ensure the tab break exists, anchored at `anchor`
    names = _names(dt)
    if TAB not in names:
        cf = frappe.new_doc("Custom Field")
        cf.dt = dt
        cf.fieldname = TAB
        cf.label = TAB_LABEL
        cf.fieldtype = "Tab Break"
        cf.insert_after = anchor
        cf.print_hide = 1
        cf.insert(ignore_permissions=True)
        names = _names(dt)
        order = _order(dt)
        anchor = next((fn for fn in reversed(order) if fn not in scp), order[-1])

    changed = 0

    # 2. detach foreign fields chained onto an SCP field / the tab
    for fn, name in names.items():
        if fn in scp:
            continue
        ia = frappe.db.get_value("Custom Field", name, "insert_after")
        if ia in scp:
            new = _preceding_non_scp(ia, order, scp)
            if new and new != ia:
                changed += _set_after(name, new)

    # 3. anchor the tab as a trailing tab
    changed += _set_after(names[TAB], anchor)

    # 4. chain SCP fields under the tab (only those present on the site)
    prev = TAB
    for fn in scp_fields:
        if fn in names:
            changed += _set_after(names[fn], prev)
            prev = fn

    if changed:
        frappe.clear_cache(doctype=dt)
    return changed
```

- [ ] **Step 3: Register the enforcer on after_migrate**

In `upande_scp/hooks.py`, change the `after_migrate` list to include the enforcer (append after the existing entry):

```python
after_migrate = [
    "upande_scp.serverscripts.scouting.observation_colors.after_migrate",
    "upande_scp.serverscripts.common.scouting_tab_layout.enforce",
]
```
(The current value is a one-element list with just the observation_colors entry — preserve it and add the second.)

- [ ] **Step 4: Apply**

Run: `cd /home/ubuntu/stive/code/frappe15 && bench --site kaitet.local migrate`
Expected: completes without error; the `after_migrate` hooks run (the enforcer reorganizes the five doctypes).

- [ ] **Step 5: Verify (oracle)**

Run: `cd /home/ubuntu/stive/code/frappe15 && env/bin/python "$SP/tab_verify.py"`
Expected: `PASS` for all five doctypes and `ALL PASS` — every SCP field under the tab (zero orphans), zero non-SCP intruders, exactly one tab break each.
If ANY doctype FAILs, do NOT proceed: debug the enforcer (common culprits: a foreign field competing for the tab's anchor position → re-point that field too, or choose the anchor as the last field overall rather than last-non-SCP; a field name not present on site → it's skipped, which is fine), re-run migrate + verify, repeat until `ALL PASS`.

- [ ] **Step 6: Verify idempotency**

Run the enforcer directly a second time and confirm it changes nothing:
```bash
cd /home/ubuntu/stive/code/frappe15
env/bin/python - <<'PY'
import frappe
frappe.init(site="kaitet.local", sites_path="/home/ubuntu/stive/code/frappe15/sites"); frappe.connect()
from upande_scp.serverscripts.common.scouting_tab_layout import SCP_FIELDS, _enforce_doctype
total = sum(_enforce_doctype(dt, f) for dt, f in SCP_FIELDS.items())
print("second-run changes:", total)
PY
```
Expected: `second-run changes: 0`.

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add upande_scp/serverscripts/common/scouting_tab_layout.py upande_scp/hooks.py
git commit -m "feat(scp): enforce Scouting & Crop Protection tab layout on shared doctypes"
```

- [ ] **Step 8: Manual Desk smoke (report, don't block)**

Note for the human: on `kaitet.local` Desk, open Item, Work Order, Warehouse, BOM, Farm — each should show one "Scouting and Crop Protection" tab containing exactly the classified fields; foreign fields (nursery/livestock/core) stay in their original tabs; Item's tab gates on CHEMICALS. (Desk isn't clickable from here — the verifier is the objective proxy.)

---

## Final verification checklist

- [ ] `bench migrate` clean.
- [ ] `tab_verify.py` → `ALL PASS` (5/5, zero orphans, zero intruders, one tab each).
- [ ] Idempotency: second enforcer run → `0` changes.
- [ ] Diff touches only `scouting_tab_layout.py` (new) + `hooks.py`; no `Co-Authored-By` trailer.
