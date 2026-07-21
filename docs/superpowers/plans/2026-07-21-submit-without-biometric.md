# Submit Without Biometric (GM-gated) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manager-gated fallback that lets a store keeper submit a Material-Transfer-for-Manufacture Stock Entry without a biometric scan, and clearly surface which submissions were biometric-authorised vs. manual.

**Architecture:** `upande_ta` never blocks submission server-side — the biometric enforcement lives entirely in SCP's `submit_with_biometric`. So we add a second, GM-gated SCP endpoint (`submit_without_biometric`) that shares validation with the biometric path but skips the scan, leaving `biometric_status="Pending"`. A `Spray Plan Settings` Check toggle gates it. The method is displayed everywhere by a single rule: on a submitted SE, `biometric_status == "Verified"` ⇒ biometric, else ⇒ manual. No new schema on Stock Entry.

**Tech Stack:** Frappe (Python server scripts, whitelisted methods), React + TypeScript + Vite frontend (shadcn/ui), Python `unittest`, Vitest.

## Global Constraints

- **No `Co-Authored-By` trailer** on any commit (repo rule in CLAUDE.md).
- **Only commit — never push** unless the user explicitly asks.
- **Reuse existing fields only** — do NOT add custom fields to Stock Entry and do NOT add a `"Bypassed"` value to `biometric_status` (owned by `upande_ta`, options are `Pending / Verified / Failed`).
- **Canonical method discriminator** (used in every display): on a *submitted* SE, `biometric_status == "Verified"` ⇒ biometric-authorised; otherwise ⇒ manual / no biometric.
- **Setting defaults OFF** — with the toggle off, behavior is exactly as today (biometric required).
- Backend unit tests run from `apps/upande_scp/` with:
  `/home/ubuntu/stive/code/frappe15/env/bin/python -m unittest upande_scp.serverscripts.tests.<module> -v`
- Frontend verification runs from `frontend/`: `yarn build` (runs `tsc -b && vite build`) and `yarn test` (Vitest).
- Never use the Kaitet MCP; query `kaitet.local` via bench if data is needed.

---

### Task 1: Setting field + settings.py load/save plumbing

**Files:**
- Modify: `upande_scp/upande_scp/doctype/spray_plan_settings/spray_plan_settings.json`
- Modify: `upande_scp/serverscripts/spray_plan_creator/settings.py` (return dict ~line 77; `scalar_fields` ~line 126)

**Interfaces:**
- Produces: a `Spray Plan Settings` single-doctype Check field `allow_submit_without_biometric` (default 0); `get_spray_plan_settings()["spray_plan"]["allow_submit_without_biometric"]` returns `int` (0/1); `save_spray_plan_settings` accepts and persists it.

- [ ] **Step 1: Add the field to the doctype JSON**

In `spray_plan_settings.json`, add `"allow_submit_without_biometric"` to the `field_order` array immediately after `"bypass_owner_check"`:

```json
    "submission_gating_section",
    "bypass_owner_check",
    "allow_submit_without_biometric",
    "auto_cancel_section",
```

And add this object to the `fields` array immediately after the `bypass_owner_check` field object:

```json
  {
   "default": "0",
   "fieldname": "allow_submit_without_biometric",
   "fieldtype": "Check",
   "label": "Allow submit without biometric (device-down fallback)",
   "description": "When ON, the Spray Plan Transfers page also offers a \"Submit without biometric\" action. Use only when the biometric device is unavailable — the submitting user is recorded. Leave OFF in normal operation."
  },
```

- [ ] **Step 2: Add the field to the settings read**

In `settings.py`, in the dict returned by `get_spray_plan_settings` (inside the `"spray_plan"` block), add the line immediately after `"bypass_owner_check": int(settings.bypass_owner_check or 0),`:

```python
            "bypass_owner_check": int(settings.bypass_owner_check or 0),
            "allow_submit_without_biometric": int(settings.allow_submit_without_biometric or 0),
```

- [ ] **Step 3: Add the field to the settings save whitelist**

In `settings.py`, add `"allow_submit_without_biometric"` to the `scalar_fields` list immediately after `"bypass_owner_check",`:

```python
        "bypass_owner_check",
        "allow_submit_without_biometric",
```

- [ ] **Step 4: Migrate so the field exists on the site**

Run: `cd /home/ubuntu/stive/code/frappe15 && bench --site kaitet.local migrate`
Expected: completes without error; `Spray Plan Settings` now has the new column.

- [ ] **Step 5: Smoke-test read/write of the new field**

Run:
```bash
cd /home/ubuntu/stive/code/frappe15 && bench --site kaitet.local execute upande_scp.serverscripts.spray_plan_creator.settings.get_spray_plan_settings
```
Expected: JSON output whose `spray_plan` block contains `"allow_submit_without_biometric": 0`.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add upande_scp/upande_scp/doctype/spray_plan_settings/spray_plan_settings.json upande_scp/serverscripts/spray_plan_creator/settings.py
git commit -m "feat(scp): add 'allow submit without biometric' setting (Submission Gating)"
```

---

### Task 2: Backend — shared eligibility helper + `submit_without_biometric`

**Files:**
- Modify: `upande_scp/serverscripts/store_keeper_api.py`
- Test: `upande_scp/serverscripts/tests/test_transfer_submit.py` (create)

**Interfaces:**
- Consumes: `_SE_PURPOSE` (module constant `"Material Transfer for Manufacture"`); `_check_perm()`; the `allow_submit_without_biometric` field from Task 1.
- Produces:
  - `_transfer_submit_error(row: dict) -> str | None` — pure; `row` has keys `name`, `docstatus`, `purpose`, `bio_employee`. Returns an error string if the SE is ineligible to submit, else `None`.
  - `_allow_submit_without_biometric() -> bool` — reads the single value.
  - whitelisted `submit_without_biometric(names: str | list) -> dict` at dotted path `upande_scp.serverscripts.store_keeper_api.submit_without_biometric`, returning `{ok:int, failed:int, results:[{name,ok,error}], method:"manual"}`.
  - `submit_with_biometric` now returns an added `"method": "biometric"` key (existing keys unchanged).
  - `list_draft_transfers` return dict now includes `"allow_submit_without_biometric": bool`.

- [ ] **Step 1: Write the failing test for the pure eligibility helper**

Create `upande_scp/serverscripts/tests/test_transfer_submit.py`:

```python
import unittest

from upande_scp.serverscripts.store_keeper_api import (
    _transfer_submit_error,
    _SE_PURPOSE,
)


class TestTransferSubmitError(unittest.TestCase):
    def _row(self, **over):
        row = {
            "name": "SE-0001",
            "docstatus": 0,
            "purpose": _SE_PURPOSE,
            "bio_employee": "HR-EMP-001",
        }
        row.update(over)
        return row

    def test_eligible_row_returns_none(self):
        self.assertIsNone(_transfer_submit_error(self._row()))

    def test_already_submitted_or_cancelled(self):
        msg = _transfer_submit_error(self._row(docstatus=1))
        self.assertIn("already submitted or cancelled", msg)
        self.assertIn("SE-0001", msg)

    def test_wrong_purpose(self):
        msg = _transfer_submit_error(self._row(purpose="Material Issue"))
        self.assertIn("purpose is not", msg)

    def test_missing_bio_employee(self):
        for val in ("", None):
            msg = _transfer_submit_error(self._row(bio_employee=val))
            self.assertIn("no receiving employee assigned", msg)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && /home/ubuntu/stive/code/frappe15/env/bin/python -m unittest upande_scp.serverscripts.tests.test_transfer_submit -v`
Expected: FAIL — `ImportError: cannot import name '_transfer_submit_error'`.

- [ ] **Step 3: Add the pure helper**

In `store_keeper_api.py`, immediately after the `_SE_PURPOSE = "Material Transfer for Manufacture"` line, add:

```python
def _transfer_submit_error(row: dict) -> str | None:
    """Return why this transfer SE cannot be submitted, or None if it can.

    Pure — shared by both the biometric and the manual submit paths so
    the eligibility rules (draft, correct purpose, receiving employee
    assigned) never drift between them. Biometric identity matching is
    NOT checked here; that is specific to the biometric path.

    ``row`` keys: name, docstatus, purpose, bio_employee.
    """
    name = row.get("name")
    if row.get("docstatus") != 0:
        return f"{name}: already submitted or cancelled."
    if (row.get("purpose") or "") != _SE_PURPOSE:
        return f"{name}: purpose is not {_SE_PURPOSE}."
    if not row.get("bio_employee"):
        return f"{name}: no receiving employee assigned — assign one first."
    return None
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && /home/ubuntu/stive/code/frappe15/env/bin/python -m unittest upande_scp.serverscripts.tests.test_transfer_submit -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Refactor `submit_with_biometric` to use the shared helper**

In `submit_with_biometric`, replace the inline eligibility checks (the `if doc.docstatus != 0` / `if (doc.purpose or "") != _SE_PURPOSE` / `if not expected` blocks) with a single call, keeping the biometric-identity match. The loop body becomes:

```python
        try:
            doc = frappe.get_doc("Stock Entry", name)
            err = _transfer_submit_error({
                "name": name,
                "docstatus": doc.docstatus,
                "purpose": doc.purpose,
                "bio_employee": doc.bio_employee,
            })
            if err:
                raise frappe.ValidationError(err)

            expected = doc.bio_employee
            expected_name = doc.bio_employee_name or expected
            if expected != scanned_emp:
                raise frappe.ValidationError(
                    f"{name}: biometric belongs to {scanned_name} but "
                    f"the entry is assigned to {expected_name}."
                )

            doc.bio_employee = scanned_emp
            doc.biometric_status = "Verified"
            doc.biometric_verified_at = now_datetime()
            if scan.get("name"):
                doc.matched_biometric_log = scan["name"]
            doc.save(ignore_permissions=False)
            doc.submit()
            ok_count += 1
            results.append({"name": name, "ok": True, "error": None})
        except Exception as e:
            failed_count += 1
            results.append({"name": name, "ok": False, "error": str(e)})
            frappe.db.rollback()
```

Then add `"method": "biometric",` to the returned dict of `submit_with_biometric` (alongside `"ok"`, `"failed"`, `"results"`, `"scanned"`).

- [ ] **Step 6: Add the setting reader and the manual submit endpoint**

In `store_keeper_api.py`, immediately after `submit_with_biometric` (end of file), add:

```python
def _allow_submit_without_biometric() -> bool:
    """Whether the GM has enabled the biometric-bypass fallback."""
    try:
        return bool(
            frappe.db.get_single_value(
                "Spray Plan Settings", "allow_submit_without_biometric"
            )
        )
    except Exception:
        return False


@frappe.whitelist()
def submit_without_biometric(names: str | list) -> dict:
    """Submit each transfer SE in ``names`` WITHOUT a biometric scan.

    Gated behind ``Spray Plan Settings.allow_submit_without_biometric`` —
    throws if a manager has not enabled it. Shares eligibility validation
    with the biometric path via ``_transfer_submit_error`` but performs no
    scan check: ``biometric_status`` is left at "Pending" and no
    ``matched_biometric_log`` is set, so a submitted SE without biometric
    is distinguishable from a verified one. The submitting user is captured
    by Frappe's built-in ``modified_by``.

    Returns ``{ok, failed, results, method}`` — same shape as the biometric
    path minus ``scanned`` (there was no scan), plus ``method="manual"``.
    """
    _check_perm()

    if not _allow_submit_without_biometric():
        frappe.throw(
            "Submitting without biometric is disabled. Ask a manager to "
            "enable it in Spray Plan Settings → Submission Gating.",
            frappe.ValidationError,
        )

    if isinstance(names, str):
        try:
            names = json.loads(names)
        except (ValueError, TypeError):
            names = [n.strip() for n in names.split(",") if n.strip()]
    if not isinstance(names, list) or not names:
        frappe.throw("No Stock Entries selected.", frappe.ValidationError)

    results: list = []
    ok_count = 0
    failed_count = 0

    for name in names:
        try:
            doc = frappe.get_doc("Stock Entry", name)
            err = _transfer_submit_error({
                "name": name,
                "docstatus": doc.docstatus,
                "purpose": doc.purpose,
                "bio_employee": doc.bio_employee,
            })
            if err:
                raise frappe.ValidationError(err)

            # No scan — leave biometric_status as-is (Pending); do not set
            # matched_biometric_log / biometric_verified_at.
            doc.save(ignore_permissions=False)
            doc.submit()
            ok_count += 1
            results.append({"name": name, "ok": True, "error": None})
        except Exception as e:
            failed_count += 1
            results.append({"name": name, "ok": False, "error": str(e)})
            frappe.db.rollback()

    frappe.db.commit()
    return {
        "ok": ok_count,
        "failed": failed_count,
        "results": results,
        "method": "manual",
    }
```

- [ ] **Step 7: Expose the setting flag on the draft-transfers listing**

In `list_draft_transfers`, change the final return (currently `return {"rows": rows, "farms": farms}`) to:

```python
    return {
        "rows": rows,
        "farms": farms,
        "allow_submit_without_biometric": _allow_submit_without_biometric(),
    }
```

- [ ] **Step 8: Re-run the unit test and confirm the module still imports**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && /home/ubuntu/stive/code/frappe15/env/bin/python -m unittest upande_scp.serverscripts.tests.test_transfer_submit -v`
Expected: PASS (4 tests) — confirms the whole edited module imports cleanly.

- [ ] **Step 9: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add upande_scp/serverscripts/store_keeper_api.py upande_scp/serverscripts/tests/test_transfer_submit.py
git commit -m "feat(scp): add gated submit_without_biometric path + shared eligibility helper"
```

---

### Task 3: Settings frontend — type + checkbox

**Files:**
- Modify: `frontend/src/lib/settings-api.ts` (`SprayPlanSettings` interface)
- Modify: `frontend/src/components/settings/SprayPlanTab.tsx` (Submission Gating card)

**Interfaces:**
- Consumes: `get_spray_plan_settings` now returns `allow_submit_without_biometric` (Task 1); `draft` / `set` helpers already present in `SprayPlanTab`.
- Produces: the toggle is editable and persists.

- [ ] **Step 1: Add the field to the TypeScript interface**

In `settings-api.ts`, in `interface SprayPlanSettings`, add the line immediately after `bypass_owner_check: number;`:

```ts
  bypass_owner_check: number;
  allow_submit_without_biometric: number;
```

- [ ] **Step 2: Add the checkbox to the Submission Gating card**

In `SprayPlanTab.tsx`, immediately after the closing `</div>` of the `bypass_owner_check` block (the `<div className="flex items-start gap-3 rounded-lg border bg-card p-3">` that ends at the line before `</CardContent>`), add a sibling block:

```tsx
          <div className="flex items-start gap-3 rounded-lg border bg-card p-3">
            <Checkbox
              id="allow_submit_without_biometric"
              checked={!!draft.allow_submit_without_biometric}
              onCheckedChange={(v) =>
                set("allow_submit_without_biometric", v ? 1 : 0)
              }
            />
            <div className="flex flex-col gap-1">
              <Label
                htmlFor="allow_submit_without_biometric"
                className="text-xs font-semibold cursor-pointer"
              >
                Allow submit without biometric (device-down fallback)
              </Label>
              <p className="text-[0.65rem] text-muted-foreground leading-snug">
                When on, the Spray Plan Transfers page also offers a “Submit
                without biometric” action. Use only when the biometric device
                is unavailable — the submitting user is recorded. Leave off in
                normal operation.
              </p>
            </div>
          </div>
```

- [ ] **Step 3: Build to verify types compile**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && yarn build`
Expected: build succeeds, no TS errors.

- [ ] **Step 4: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add frontend/src/lib/settings-api.ts frontend/src/components/settings/SprayPlanTab.tsx
git commit -m "feat(scp-fe): expose 'allow submit without biometric' toggle in Settings"
```

---

### Task 4: Transfers page — manual submit action + result labelling

**Files:**
- Modify: `frontend/src/lib/store-keeper-api.ts` (types + `submitWithoutBiometric`)
- Modify: `frontend/src/pages/SprayPlanTransfers.tsx`

**Interfaces:**
- Consumes: `submit_without_biometric` endpoint + `allow_submit_without_biometric` on the draft listing (Task 2).
- Produces: `submitWithoutBiometric(names: string[]): Promise<BiometricSubmitResp>`; `DraftTransfersResp.allow_submit_without_biometric: boolean`; `BiometricSubmitResp` gains `method: "biometric" | "manual"` and `scanned?` becomes optional.

- [ ] **Step 1: Extend the API types**

In `store-keeper-api.ts`, update `DraftTransfersResp`:

```ts
export interface DraftTransfersResp {
  rows: TransferRow[];
  farms: string[];
  allow_submit_without_biometric: boolean;
}
```

and update `BiometricSubmitResp` (make `scanned` optional, add `method`):

```ts
export interface BiometricSubmitResp {
  ok: number;
  failed: number;
  results: BiometricSubmitResult[];
  method: "biometric" | "manual";
  scanned?: { employee: string; employee_name: string; biometric_id: string };
}
```

- [ ] **Step 2: Add the `submitWithoutBiometric` call**

In `store-keeper-api.ts`, immediately after `submitWithBiometric`, add:

```ts
export async function submitWithoutBiometric(
  names: string[],
): Promise<BiometricSubmitResp> {
  const r = await call(
    "upande_scp.serverscripts.store_keeper_api.submit_without_biometric",
    { names: JSON.stringify(names) },
  );
  return unwrap<BiometricSubmitResp>(r);
}
```

- [ ] **Step 3: Build to verify the guarded `scanned` usage is caught**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && yarn build`
Expected: FAIL — TS error in `SprayPlanTransfers.tsx` where `result.scanned.employee_name` is now possibly-undefined. (This confirms the type tightening; fixed in Step 5.)

- [ ] **Step 4: Wire state, imports, and the manual-submit handler**

In `SprayPlanTransfers.tsx`:

(a) Add `submitWithoutBiometric` to the import from `@/lib/store-keeper-api` (the block ending at `} from "@/lib/store-keeper-api";`).

(b) Add `Dialog` imports near the other ui imports:

```tsx
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
```

(c) Add state next to the other `useState`s (after `const [result, setResult] = ...`):

```tsx
  const [allowManual, setAllowManual] = useState(false);
  const [confirmManual, setConfirmManual] = useState(false);
```

(d) In `load()`, inside the `.then((r) => { ... })` where `setRows(r.rows); setFarms(r.farms);` are called, add immediately after `setFarms(r.farms);`:

```tsx
        setAllowManual(!!r.allow_submit_without_biometric);
```

(e) Add the manual submit handler after `onSubmit`:

```tsx
  const onSubmitManual = async () => {
    setConfirmManual(false);
    if (selected.size === 0 || submitting) return;
    setSubmitting(true);
    setResult(null);
    setError(null);
    try {
      const r = await submitWithoutBiometric(Array.from(selected));
      setResult(r);
      if (r.ok > 0) {
        setSelected((prev) => {
          const next = new Set(prev);
          for (const item of r.results) if (item.ok) next.delete(item.name);
          return next;
        });
        load();
      }
    } catch (e: any) {
      setError(e?.message || "Submit failed");
    } finally {
      setSubmitting(false);
    }
  };
```

- [ ] **Step 5: Render the manual button, confirm dialog, and fix the result panel**

(a) Immediately after the existing primary "Submit … with biometric" `<Button>` block (the one ending `</Button>` right before the action-row closing `</div>`), add:

```tsx
          {allowManual && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmManual(true)}
              className="h-9 gap-2"
              disabled={selected.size === 0 || submitting}
              title="Submit without a biometric scan (recorded against you)"
            >
              Submit {selected.size > 0 ? `(${selected.size})` : "selected"} without biometric
            </Button>
          )}
```

(b) Replace the result-panel `CardDescription` (currently `Scanned: <strong>{result.scanned.employee_name}</strong> ({result.scanned.employee})`) with a method-aware version:

```tsx
              <CardDescription>
                {result.method === "manual" || !result.scanned ? (
                  <>Submitted without biometric — recorded against your user.</>
                ) : (
                  <>
                    Scanned: <strong>{result.scanned.employee_name}</strong>{" "}
                    ({result.scanned.employee})
                  </>
                )}
              </CardDescription>
```

(c) Add the confirmation dialog near the end of the component's returned JSX (before the final closing `</div>`):

```tsx
      <Dialog open={confirmManual} onOpenChange={setConfirmManual}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Submit without biometric?</DialogTitle>
            <DialogDescription>
              {selected.size} transfer{selected.size === 1 ? "" : "s"} will be
              submitted without a biometric scan. This is a device-down
              fallback and is recorded against your user account. Continue?
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setConfirmManual(false)}>
              Cancel
            </Button>
            <Button onClick={onSubmitManual} disabled={submitting}>
              Submit without biometric
            </Button>
          </div>
        </DialogContent>
      </Dialog>
```

- [ ] **Step 6: Build to verify everything compiles**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && yarn build`
Expected: build succeeds, no TS errors.

- [ ] **Step 7: Run the frontend test suite**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && yarn test`
Expected: existing tests pass (no regressions).

- [ ] **Step 8: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add frontend/src/lib/store-keeper-api.ts frontend/src/pages/SprayPlanTransfers.tsx
git commit -m "feat(scp-fe): add gated 'Submit without biometric' action to Transfers page"
```

---

### Task 5: Highlight method — lifecycle timeline + submitted-transfers badge

**Files:**
- Modify: `upande_scp/serverscripts/spray_plan_creator/lifecycle.py` (~line 280, "Chemical Issued" step)
- Test: `upande_scp/serverscripts/tests/test_lifecycle_bio_label.py` (create)
- Modify: `upande_scp/serverscripts/store_keeper_api.py` (`list_submitted_transfers` SELECT + row post-processing)
- Modify: `frontend/src/lib/labels-api.ts` (`SubmittedTransferRow`)
- Modify: `frontend/src/pages/Labels.tsx` (row badge)

**Interfaces:**
- Consumes: canonical discriminator (`biometric_status == "Verified"`).
- Produces: `_issue_biometric_label(biometric_status: str | None) -> str` in `lifecycle.py` returning `"Biometric ✓"` or `"No biometric"`; `list_submitted_transfers` rows include `biometric_status: str`; `SubmittedTransferRow.biometric_status: string`.

- [ ] **Step 1: Write the failing test for the lifecycle label helper**

Create `upande_scp/serverscripts/tests/test_lifecycle_bio_label.py`:

```python
import unittest

from upande_scp.serverscripts.spray_plan_creator.lifecycle import (
    _issue_biometric_label,
)


class TestIssueBiometricLabel(unittest.TestCase):
    def test_verified_shows_biometric_check(self):
        self.assertEqual(_issue_biometric_label("Verified"), "Biometric ✓")

    def test_pending_shows_no_biometric(self):
        self.assertEqual(_issue_biometric_label("Pending"), "No biometric")

    def test_none_shows_no_biometric(self):
        self.assertEqual(_issue_biometric_label(None), "No biometric")

    def test_failed_shows_no_biometric(self):
        self.assertEqual(_issue_biometric_label("Failed"), "No biometric")
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && /home/ubuntu/stive/code/frappe15/env/bin/python -m unittest upande_scp.serverscripts.tests.test_lifecycle_bio_label -v`
Expected: FAIL — `ImportError: cannot import name '_issue_biometric_label'`.

- [ ] **Step 3: Add the helper and use it in the "Chemical Issued" step**

In `lifecycle.py`, add the pure helper (place it just above the function that builds the "Chemical Issued" step, near `_biometric_issuer`):

```python
def _issue_biometric_label(biometric_status: str | None) -> str:
    """Human label for how a submitted transfer was authorised.

    Canonical rule: "Verified" ⇒ biometric; anything else ⇒ manual.
    """
    return "Biometric ✓" if biometric_status == "Verified" else "No biometric"
```

Then, in the "Chemical Issued" step, replace the biometric bit logic:

```python
    # 3 — Chemical Issued (biometric or manual)
    issuer = _biometric_issuer(se["name"]) if se else None
    issued_detail = None
    if se:
        bits = [_issue_biometric_label(se.get("biometric_status"))]
        if issuer:
            bits.append(issuer)
        bits.append(se["name"])
        issued_detail = " · ".join(bits)
```

(The `bio_ok` variable is removed; the label now always states the method.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && /home/ubuntu/stive/code/frappe15/env/bin/python -m unittest upande_scp.serverscripts.tests.test_lifecycle_bio_label -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Surface `biometric_status` on the submitted-transfers listing**

In `store_keeper_api.py` `list_submitted_transfers`, add `se.biometric_status` to the SELECT (after `se.custom_labels_printed_by AS labels_printed_by,`):

```sql
               se.custom_labels_printed_by AS labels_printed_by,
               se.biometric_status AS biometric_status,
```

and in the per-row post-processing loop (the `for r in rows:` block near the end), add:

```python
        r["biometric_status"] = r.get("biometric_status") or "Pending"
```

- [ ] **Step 6: Add `biometric_status` to the frontend row type**

In `labels-api.ts` `interface SubmittedTransferRow`, add after `spray_type: string;`:

```ts
  spray_type: string;
  /** Verification status of the underlying SE — "Verified" means the
   *  transfer was biometric-authorised; anything else means manual. */
  biometric_status: string;
```

- [ ] **Step 7: Render a method badge on each submitted-transfer row**

In `Labels.tsx`, in the row `<label>` (after the `{r.spray_type && (...)}` `Badge` block and before the `{r.qr_count} QR` badge), add:

```tsx
                              {r.biometric_status === "Verified" ? (
                                <Badge
                                  className="bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/15 text-[10px]"
                                  title="Submitted with biometric verification"
                                >
                                  Biometric ✓
                                </Badge>
                              ) : (
                                <Badge
                                  className="bg-amber-500/15 text-amber-600 hover:bg-amber-500/15 text-[10px]"
                                  title="Submitted without biometric"
                                >
                                  No biometric
                                </Badge>
                              )}
```

- [ ] **Step 8: Build and run both test suites**

Run:
```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && /home/ubuntu/stive/code/frappe15/env/bin/python -m unittest upande_scp.serverscripts.tests.test_lifecycle_bio_label upande_scp.serverscripts.tests.test_transfer_submit -v
cd frontend && yarn build && yarn test
```
Expected: unittest PASS (8 tests total); frontend build succeeds; Vitest passes.

- [ ] **Step 9: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add upande_scp/serverscripts/spray_plan_creator/lifecycle.py upande_scp/serverscripts/tests/test_lifecycle_bio_label.py upande_scp/serverscripts/store_keeper_api.py frontend/src/lib/labels-api.ts frontend/src/pages/Labels.tsx
git commit -m "feat(scp): highlight biometric vs manual method in lifecycle + labels list"
```

---

## Verification checklist (after all tasks)

- [ ] Toggle OFF (default): Transfers page shows no "without biometric" button; `submit_without_biometric` throws if called directly. Behaviour identical to today.
- [ ] Toggle ON: "Submit without biometric" appears; confirm dialog gates it; submitting leaves `biometric_status == "Pending"`, `docstatus == 1`, no `matched_biometric_log`.
- [ ] A biometric submit still sets `biometric_status == "Verified"` + `matched_biometric_log`.
- [ ] Lifecycle timeline "Chemical Issued" step reads "Biometric ✓" for verified, "No biometric" for manual.
- [ ] Labels page shows a green "Biometric ✓" / amber "No biometric" badge per submitted transfer.
- [ ] Per-row failure isolation holds on the manual path (one bad SE doesn't abort the batch).

## Manual verification note (DB-touching submit path)

The `submit_without_biometric` DB flow is not unit-tested (the repo's unit tests are pure-function only). Verify it once on `kaitet.local`: enable the setting, pick a draft transfer with an assigned `bio_employee`, submit without biometric, and confirm via
`bench --site kaitet.local execute frappe.client.get_value --kwargs "{'doctype':'Stock Entry','filters':{...},'fieldname':['docstatus','biometric_status','matched_biometric_log']}"`
that `docstatus=1`, `biometric_status='Pending'`, `matched_biometric_log` empty.
