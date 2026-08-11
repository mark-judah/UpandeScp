# Chemical Loaning Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Remove the depletion-value limit on chemical loaning, allow several chemicals per request (batch), lift the lender cap to 5, and add a read-only Creditors view for the borrowing farm.

**Architecture:** Backend changes in `serverscripts/spray_plan_creator/loaning.py` (drop the `loaning_depletion_pct` floor; cap at on-hand; extract per-request creation into `_create_one`; add batch `create_requests` + `get_creditors`; pure `validate_source_split` helper for tests). Frontend changes in `ChemicalLoaning.tsx` + `loaning-api.ts` (multi-chemical cart, up-to-5 lenders, Creditors tab). No doctype change.

**Tech Stack:** Frappe (Python whitelisted methods, Chemical Transfer Request doctype), React/TS frontend, Python `unittest`, Vitest.

## Global Constraints

- **Keep** `loaning_enabled`, request expiry/timeout, "can't lend to self," and "sources must sum to requested qty." **Drop** the depletion floor entirely (`loaning_depletion_pct` field stays but is no longer referenced by loaning logic).
- Each source qty is capped at the lender's **on-hand** (can't lend more than it has). No lending into negative stock.
- `MAX_SOURCES = 5`.
- Keep BOTH `create_request` (single) and `create_requests` (batch); both delegate to a shared `_create_one`.
- Creditors is **visibility-only** — no repayment flow.
- No `Co-Authored-By` trailer. Commit only the files each task names (never `git add -A`). Work on `kaitet` (current branch).
- Paths: app `/home/ubuntu/stive/code/frappe15/apps/upande_scp`; bench `/home/ubuntu/stive/code/frappe15`; env python `.../env/bin/python`; site `kaitet.local`. Backend tests run from `apps/upande_scp`: `.../env/bin/python -m unittest upande_scp.serverscripts.tests.<module> -v`. Frontend from `frontend/`: `yarn build`, `yarn test`.
- Never use any Kaitet MCP tool.

---

### Task 1: Backend — no floor, batch, creditors, pure validation

**Files:**
- Modify: `upande_scp/serverscripts/spray_plan_creator/loaning.py`
- Test: `upande_scp/serverscripts/tests/test_loaning_validation.py` (create)

**Interfaces:**
- Produces: `validate_source_split(sources, requested_qty, requesting_farm, lendable_by_farm, max_sources) -> str | None` (pure); `_create_one(farm, reason, item) -> str`; whitelisted `create_requests(payload) -> dict`; whitelisted `get_creditors(farm) -> list[dict]`. `MAX_SOURCES = 5`.

- [ ] **Step 1: Write the failing test for the pure validator**

Create `upande_scp/serverscripts/tests/test_loaning_validation.py`:

```python
import unittest
from upande_scp.serverscripts.spray_plan_creator.loaning import validate_source_split

FARM = "Farm A"
LEND = {"Farm B": 10.0, "Farm C": 5.0}


class TestValidateSourceSplit(unittest.TestCase):
    def ok(self, sources, qty):
        return validate_source_split(sources, qty, FARM, LEND, 5)

    def test_valid_single_source(self):
        self.assertIsNone(self.ok([{"source_farm": "Farm B", "qty": 8}], 8))

    def test_valid_multi_source(self):
        self.assertIsNone(self.ok(
            [{"source_farm": "Farm B", "qty": 6}, {"source_farm": "Farm C", "qty": 4}], 10))

    def test_split_must_sum_to_requested(self):
        self.assertIn("add up", self.ok([{"source_farm": "Farm B", "qty": 5}], 8))

    def test_cannot_exceed_on_hand(self):
        self.assertIn("can only lend", self.ok([{"source_farm": "Farm C", "qty": 9}], 9))

    def test_cannot_loan_to_self(self):
        self.assertIn("itself", self.ok([{"source_farm": "Farm A", "qty": 5}], 5))

    def test_source_needs_farm_and_positive_qty(self):
        self.assertIn("positive", self.ok([{"source_farm": "Farm B", "qty": 0}], 0))

    def test_source_count_bounds(self):
        self.assertIn("between 1 and 5", self.ok([], 0))
        many = [{"source_farm": f"F{i}", "qty": 1} for i in range(6)]
        self.assertIn("between 1 and 5", self.ok(many, 6))
```

- [ ] **Step 2: Run it — expect ImportError**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && /home/ubuntu/stive/code/frappe15/env/bin/python -m unittest upande_scp.serverscripts.tests.test_loaning_validation -v`
Expected: FAIL — `cannot import name 'validate_source_split'`.

- [ ] **Step 3: Add the pure validator + set MAX_SOURCES=5**

In `loaning.py`, change `MAX_SOURCES = 2` → `MAX_SOURCES = 5`, and add near the other module-level helpers:

```python
def validate_source_split(sources, requested_qty, requesting_farm,
                          lendable_by_farm, max_sources=MAX_SOURCES):
    """Pure validation of a chemical's lender split. Returns an error message
    string, or None if valid. `lendable_by_farm` maps source_farm -> its
    on-hand (the cap). No depletion floor — a lender may lend down to zero."""
    from frappe.utils import flt as _flt
    if not (1 <= len(sources) <= max_sources):
        return f"Pick between 1 and {max_sources} source farm(s)."
    total = 0.0
    for src in sources:
        sf = src.get("source_farm")
        sq = _flt(src.get("qty"))
        if not sf or sq <= 0:
            return "Each source needs a farm and a positive qty."
        if sf == requesting_farm:
            return "A farm cannot loan to itself."
        cap = _flt(lendable_by_farm.get(sf, 0))
        if sq > cap + QTY_TOL:
            return f"{sf} can only lend {cap:g} of this chemical."
        total += sq
    if abs(total - _flt(requested_qty)) > QTY_TOL:
        return f"Source split ({total:g}) must add up to the requested qty ({_flt(requested_qty):g})."
    return None
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && /home/ubuntu/stive/code/frappe15/env/bin/python -m unittest upande_scp.serverscripts.tests.test_loaning_validation -v`
Expected: PASS (7 tests).

- [ ] **Step 5: Refactor `create_request` into `_create_one` (no floor) + keep the wrapper**

Replace `create_request`'s body so the per-item work lives in `_create_one`, using the pure validator with on-hand caps (no depletion gate):

```python
def _create_one(farm, reason, item, settings):
    """Create one Chemical Transfer Request for a single chemical. `item` =
    {item_code, uom?, requested_qty, sources:[{source_farm, qty}]}. Returns name."""
    item_code = item.get("item_code")
    requested_qty = flt(item.get("requested_qty"))
    sources = item.get("sources") or []
    if not item_code or requested_qty <= 0:
        frappe.throw("item_code and a positive requested_qty are required.")
    # cap = each source farm's on-hand (no floor)
    lendable = {s.get("source_farm"): _on_hand(s.get("source_farm"), item_code)
                for s in sources if s.get("source_farm")}
    err = validate_source_split(sources, requested_qty, farm, lendable)
    if err:
        frappe.throw(err)

    timeout_h = int(settings.loaning_timeout_hours or 72)
    doc = frappe.new_doc("Chemical Transfer Request")
    doc.requesting_farm = farm
    doc.requesting_warehouse = _primary_store(farm)
    doc.item_code = item_code
    doc.item_name = frappe.db.get_value("Item", item_code, "item_name")
    doc.uom = item.get("uom") or frappe.db.get_value("Item", item_code, "stock_uom")
    doc.requested_qty = requested_qty
    doc.reason = reason
    doc.workflow_state = "Pending Approval"
    doc.expires_on = add_to_date(now_datetime(), hours=timeout_h)
    for src in sources:
        doc.append("sources", {
            "source_farm": src.get("source_farm"),
            "source_warehouse": _primary_store(src.get("source_farm")),
            "qty": flt(src.get("qty")),
        })
    doc.insert(ignore_permissions=True)
    for src in doc.sources:
        _notify_farm_creators(
            src.source_farm,
            f"Chemical loan request {doc.name} — {doc.item_name}",
            f"{farm} requests {flt(src.qty):g} {doc.uom} of {doc.item_name}. Approve in Chemical Loaning.",
            doc.name,
        )
    return doc.name


@frappe.whitelist()
def create_request(payload) -> dict:
    """Single-chemical request (kept for backward compat)."""
    s = _ensure_enabled(); _ensure_creator()
    if isinstance(payload, str):
        payload = json.loads(payload)
    farm = payload.get("requesting_farm")
    _assert_farm_access(farm)
    name = _create_one(farm, payload.get("reason"), {
        "item_code": payload.get("item_code"),
        "uom": payload.get("uom"),
        "requested_qty": payload.get("requested_qty"),
        "sources": payload.get("sources") or [],
    }, s)
    return {"name": name}
```
(Removes the `_is_depleted` requester gate and the `_lendable` floor — those helpers may be deleted if now unused, or left; `loaning_depletion_pct` is no longer read here.)

- [ ] **Step 6: Add batch `create_requests`**

```python
@frappe.whitelist()
def create_requests(payload) -> dict:
    """Batch: one Chemical Transfer Request per chemical.
    payload = {requesting_farm, reason, items: [{item_code, uom, requested_qty,
    sources:[{source_farm, qty}]}]}. One bad chemical doesn't abort the rest."""
    s = _ensure_enabled(); _ensure_creator()
    if isinstance(payload, str):
        payload = json.loads(payload)
    farm = payload.get("requesting_farm")
    _assert_farm_access(farm)
    items = payload.get("items") or []
    if not items:
        frappe.throw("Add at least one chemical.")
    names, failed = [], []
    for it in items:
        try:
            names.append(_create_one(farm, payload.get("reason"), it, s))
        except Exception as e:
            failed.append({"item_code": it.get("item_code"), "error": str(e)})
            frappe.db.rollback()
    frappe.db.commit()
    return {"names": names, "failed": failed}
```

- [ ] **Step 7: Drop the floor in `get_loanable_chemicals` + `get_sources_for`**

- `get_loanable_chemicals(farm)`: remove the `pct`/`_is_depleted` filter — append **every** candidate item (drop the `if _is_depleted(...)` guard; return all items with their `on_hand`, dropping the `depleted`/`baseline_qty` gating). Keep the union of Bin items + baseline items so zero-stock chemicals still list.
- `get_sources_for(farm, item_code)`: delete the "visibility gate" `frappe.throw` block; set `lend = on_hand` (drop `_lendable`/`pct`); keep `src != farm` and `lend > 0`.

- [ ] **Step 8: Add `get_creditors`**

```python
@frappe.whitelist()
def get_creditors(farm) -> list[dict]:
    """Read-only: for the borrowing `farm`, what it received and from whom —
    approved loan sources grouped by (lending farm, chemical)."""
    _ensure_creator(); _assert_farm_access(farm)
    rows = frappe.db.sql(
        """SELECT s.source_farm AS creditor_farm, r.item_code, r.item_name, r.uom,
                  SUM(s.qty) AS qty
           FROM `tabChemical Transfer Request Source` s
           JOIN `tabChemical Transfer Request` r ON r.name = s.parent
           WHERE r.requesting_farm = %(farm)s AND s.approved = 1
           GROUP BY s.source_farm, r.item_code
           ORDER BY r.item_name, s.source_farm""",
        {"farm": farm}, as_dict=True)
    return rows
```

- [ ] **Step 9: Verify import + tests + no stale floor refs**

Run:
```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
/home/ubuntu/stive/code/frappe15/env/bin/python -m unittest upande_scp.serverscripts.tests.test_loaning_validation -v
grep -n "loaning_depletion_pct\|_is_depleted\|_lendable" upande_scp/serverscripts/spray_plan_creator/loaning.py
/home/ubuntu/stive/code/frappe15/env/bin/python -c "import upande_scp.serverscripts.spray_plan_creator.loaning as m; print('import OK', m.MAX_SOURCES)"
```
Expected: 7 tests PASS; the grep shows `loaning_depletion_pct` no longer gates create/sources (only the now-unused setting reference, if any, remains — remove any that still gates); import OK, MAX_SOURCES 5.

- [ ] **Step 10: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add upande_scp/serverscripts/spray_plan_creator/loaning.py upande_scp/serverscripts/tests/test_loaning_validation.py
git commit -m "feat(scp): loaning — drop depletion floor, batch multi-chemical, creditors view, 5 lenders"
```

---

### Task 2: Frontend — multi-chemical cart, 5 lenders, Creditors tab

**Files:**
- Modify: `frontend/src/lib/loaning-api.ts`, `frontend/src/pages/ChemicalLoaning.tsx`

**Interfaces:**
- Consumes: `create_requests`, `get_creditors`, and the now-unfiltered `get_loanable_chemicals`/`get_sources_for` from Task 1.
- Produces: `createRequests(payload)`, `getCreditors(farm)` in `loaning-api.ts`.

- [ ] **Step 1: API layer**

In `loaning-api.ts` add:
```ts
export interface LoanCartItem {
  item_code: string; uom: string; requested_qty: number;
  sources: { source_farm: string; qty: number }[];
}
export interface CreditorRow {
  creditor_farm: string; item_code: string; item_name: string; uom: string; qty: number;
}
export async function createRequests(payload: {
  requesting_farm: string; reason?: string; items: LoanCartItem[];
}): Promise<{ names: string[]; failed: { item_code: string; error: string }[] }> {
  const r = await call("upande_scp.serverscripts.spray_plan_creator.loaning.create_requests",
    { payload: JSON.stringify(payload) });
  return unwrap(r);
}
export async function getCreditors(farm: string): Promise<CreditorRow[]> {
  const r = await call("upande_scp.serverscripts.spray_plan_creator.loaning.get_creditors", { farm });
  return unwrap(r);
}
```
(Match the file's existing `call`/`unwrap` helpers and import style.)

- [ ] **Step 2: Multi-chemical cart + 5 lenders (RequestTab / SourcePicker)**

In `ChemicalLoaning.tsx`:
- Change the `SourcePicker` "max 2 sources" guard (`if (Object.keys(next).length >= 2) return prev;`) to use the max of 5.
- Add a **cart**: instead of submitting one chemical immediately, "Add to request" pushes `{item_code, uom, requested_qty, sources}` into a `cart: LoanCartItem[]` state; the tab shows the cart (chemicals + their splits, removable). A single **Submit request** button calls `createRequests({requesting_farm: farm, reason, items: cart})`, then shows per-item success/failure from `{names, failed}` and clears the cart.
- The loanable-chemicals list now shows all chemicals (Task 1) — keep the pick → SourcePicker → add-to-cart flow.

- [ ] **Step 3: Creditors tab**

Add a third tab (alongside `request` / `inbox`): **"Creditors"** — on select, calls `getCreditors(farm)` and renders a read-only table: `{item_name} — received {qty} {uom} from {creditor_farm}`. Empty state when none.

- [ ] **Step 4: Build + test**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && yarn build && yarn test`
Expected: build clean (no TS errors); existing Vitest green.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add frontend/src/lib/loaning-api.ts frontend/src/pages/ChemicalLoaning.tsx
git commit -m "feat(scp-fe): loaning — multi-chemical cart, up to 5 lenders, Creditors tab"
```

---

## Final verification checklist

- [ ] `validate_source_split` unit tests pass (7); no depletion floor gates request creation or source listing.
- [ ] `create_requests` creates one request per chemical, isolates per-item failures; `create_request` still works.
- [ ] `get_creditors` returns approved received amounts grouped by lending farm + chemical.
- [ ] `MAX_SOURCES == 5`; frontend allows up to 5 lenders.
- [ ] `yarn build` clean; Vitest green.
- [ ] Manual smoke on kaitet.local: one submit requests two chemicals (each ≥1 lender); approve; Creditors tab shows the received amounts.
- [ ] Commits carry no `Co-Authored-By` trailer.
