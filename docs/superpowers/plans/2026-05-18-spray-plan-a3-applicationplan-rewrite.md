# Spray Plan A3 — ApplicationPlan Rewrite + Approval Page Enhancements

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `ApplicationPlan.tsx` to the new Spray Plan Creator workflow (A1 endpoints), add the Preventive/Curative classification + reason, add a session-local Draft Batch list with a bulk Submit-for-Approval flow, remove the Desk redirect and the inline New-BOM dialog, and enhance the Approval page with chemical rates + IRAC/FRAC chips + bulk approve.

**Architecture:** ApplicationPlan keeps its current single-page form layout (no three-column redesign in this iteration — explicit deferral to keep scope tractable). The page swaps its data layer from the legacy bootstrap/createApplicationWorkOrder endpoints to the A1 endpoints (`fetch_creator_bootstrap`, `create_draft_spray_plan`, `list_my_draft_plans`, `submit_drafts_for_approval`). A new `DraftBatchPanel` component renders the right-rail list of pending drafts. The Approval page's WO card gets a chemicals-with-codes section and a bulk Approve button driven by `get_approval_review` + `approve_drafts_bulk`.

**Tech Stack:** React 18 + TypeScript + shadcn/ui + lucide-react. Existing patterns: `call()` helper, hash router, lazy-loaded routes.

**Spec reference:** [docs/superpowers/specs/2026-05-18-spray-plan-creator-workflow-design.md](../specs/2026-05-18-spray-plan-creator-workflow-design.md) §6 and §7.
**Plans A1 + A2 (prerequisites):** Already shipped.

---

## Scope decisions (read first)

**In scope:**

- Switch ApplicationPlan to A1 endpoints (bootstrap, create-draft, list-drafts, submit-drafts).
- Classification radio (Curative / Preventive) and conditional Preventive Reason textarea.
- Targets picker: **none pre-selected** (current behaviour auto-selects every observed pest — that's the bug we're fixing).
- Remove the inline "New BOM" dialog and its create-BOM lib call.
- Remove the Desk redirect on submit; instead, drafts accumulate in a right-rail Draft Batch panel.
- "Submit all for approval" button that calls `submit_drafts_for_approval` and clears the panel.
- 403 Access-Denied panel when the current user lacks the `Spray Plan Creator` role.
- Empty-state banner when the user has the role but is assigned to zero farms.
- Approval page: per-WO Chemicals table shows IRAC/FRAC chips + rate + rate-status flag + resistance warnings, sourced from `get_approval_review`.
- Approval page: bulk-approve checkbox column + `Approve selected` button.

**Deferred to a future iteration (out of A3):**

- Three-column layout redesign (Diagnose / Plan / Batch side-by-side).
- Open-Meteo weather forecast section. (`custom_weather_snapshot` field exists from A1, so a future change is purely additive.)
- Per-WO spray team member roster editing via `custom_spray_plan_team_members`. (Snapshot child table exists; the legacy `custom_spray_team` text field still works for the basic team-name flow.)
- 24-hour weather strip with click-to-set scheduled time.

These deferrals keep A3 at a manageable size and ensure each shipped task is independently testable. Adding them later is purely additive.

---

## Pre-flight

- Working dir: `/home/ubuntu/stive/code/frappe15/apps/upande_scp`
- Frontend root: `frontend/`
- Bench site: `kaitet.local` (for backend smoke-tests)
- Build verification command: `cd frontend && npm run build`

The existing `ApplicationPlan.tsx` is ~1613 lines. We refactor in place — not a fresh file — so the diff stays reviewable and existing component composition is preserved.

---

## Task 1 — API helper module for the creator-flow endpoints

**Files:**
- Create: `frontend/src/lib/spray-plan-creator-api.ts`

### Steps

- [ ] **Step 1: Write the helper module**

`frontend/src/lib/spray-plan-creator-api.ts`:

```typescript
/**
 * Whitelisted endpoints for the Spray Plan Creator React page.
 *
 * Backend modules:
 *  - upande_scp.serverscripts.spray_plan_creator.bootstrap
 *  - upande_scp.serverscripts.spray_plan_creator.drafts
 *  - upande_scp.serverscripts.spray_plan_creator.bulk
 *  - upande_scp.serverscripts.spray_plan_creator.approval_review
 *
 * Role gating is enforced server-side: every endpoint requires the
 * "Spray Plan Creator" role (or General Manager / Administrator). 403
 * from the call helper means the user isn't permitted; we surface that
 * in the UI as an Access-Denied banner.
 */

import { call } from "./frappe";

// ---------- Bootstrap ----------

export interface CreatorScope {
  farms: string[];
  allowed_warehouses: { name: string; custom_farm: string }[];
}

export interface CreatorGreenhouse {
  name: string;
  custom_farm: string;
  latitude: number | null;
  longitude: number | null;
}

export interface CreatorKit {
  kit: string;
  warehouse: string;
  custom_farm: string;
}

export interface CreatorSprayTeam {
  name: string;
  custom_farm: string;
  members: { employee: string; role: string }[];
}

export interface CreatorTankMix {
  name: string;
  item_name: string;
  custom_farm?: string;
}

export interface CreatorRateLimit {
  lower: number | null;
  upper: number | null;
}

export interface CreatorBootstrap {
  scope: CreatorScope;
  greenhouses: CreatorGreenhouse[];
  kits: CreatorKit[];
  spray_teams: CreatorSprayTeam[];
  tank_mixes: CreatorTankMix[];
  rate_limits: Record<string, CreatorRateLimit>;
  pest_catalog: { name: string }[];
  disease_catalog: { name: string }[];
  weather_settings: Record<string, number>;
  irac_window_days: number;
  frac_window_days: number;
}

export async function fetchCreatorBootstrap(): Promise<CreatorBootstrap> {
  return call<CreatorBootstrap>(
    "upande_scp.serverscripts.spray_plan_creator.bootstrap.fetch_creator_bootstrap",
  );
}

// ---------- Draft CRUD ----------

export interface DraftPayloadChemical {
  item_code: string;
  item_name?: string;
  uom?: string;
  source_warehouse?: string;
  application_rate?: number;
}

export interface DraftPayload {
  custom_greenhouse: string;
  custom_classification: "Curative" | "Preventive";
  custom_preventive_reason?: string;
  custom_spray_type: string;
  custom_scope: string;
  custom_scope_details?: string;
  custom_kit?: string | null;
  custom_spray_team?: string | null;
  custom_water_ph: number;
  custom_water_hardness: number;
  custom_water_volume: number;
  custom_area: number;
  custom_targets: string[];
  production_item: string;
  chemicals: DraftPayloadChemical[];
  custom_scheduled_application_time?: string | null;
}

export interface DraftSummary {
  name: string;
  greenhouse: string;
  classification: string;
  targets: string[];
  scheduled_date: string | null;
  chemical_count: number;
  total_water_volume: number;
  has_warnings: boolean;
}

export async function createDraftSprayPlan(
  payload: DraftPayload,
): Promise<{ work_order: string; summary: unknown }> {
  return call(
    "upande_scp.serverscripts.spray_plan_creator.drafts.create_draft_spray_plan",
    { payload: JSON.stringify(payload) },
  );
}

export async function listMyDraftPlans(): Promise<DraftSummary[]> {
  return call<DraftSummary[]>(
    "upande_scp.serverscripts.spray_plan_creator.drafts.list_my_draft_plans",
  );
}

export async function deleteDraftPlan(name: string): Promise<{ deleted: string }> {
  return call(
    "upande_scp.serverscripts.spray_plan_creator.drafts.delete_draft_plan",
    { name },
  );
}

// ---------- Bulk ----------

export interface BulkSubmitResult {
  submitted: string[];
  skipped: { name: string; reason: string }[];
}

export async function submitDraftsForApproval(
  wo_names: string[],
): Promise<BulkSubmitResult> {
  return call<BulkSubmitResult>(
    "upande_scp.serverscripts.spray_plan_creator.bulk.submit_drafts_for_approval",
    { wo_names: JSON.stringify(wo_names) },
  );
}

export interface BulkApproveResult {
  approved: string[];
  skipped: { name: string; reason: string }[];
}

export async function approveDraftsBulk(
  wo_names: string[],
): Promise<BulkApproveResult> {
  return call<BulkApproveResult>(
    "upande_scp.serverscripts.spray_plan_creator.bulk.approve_drafts_bulk",
    { wo_names: JSON.stringify(wo_names) },
  );
}

// ---------- Approval review ----------

export interface ChemicalReview {
  item_code: string;
  item_name: string;
  application_rate: number;
  stock_uom: string;
  rate_limits: { lower: number | null; upper: number | null } | null;
  rate_status: "ok" | "below" | "above";
  irac_code: string | null;
  frac_code: string | null;
  irac_codes?: string[];
  frac_codes?: string[];
  resistance_warnings: {
    kind: "irac" | "frac";
    code: string;
    severity: "warning" | "block";
    message: string;
    prior_wo: string;
    days_ago: number;
  }[];
}

export interface ApprovalReview {
  work_order: {
    name: string;
    greenhouse: string;
    scheduled_date: string | null;
    classification: string;
    preventive_reason: string | null;
    weather_snapshot: unknown;
    team_members: { employee: string; employee_name: string; role: string }[];
    targets: string[];
  };
  chemicals: ChemicalReview[];
  plan_warnings: string[];
}

export async function getApprovalReview(woName: string): Promise<ApprovalReview> {
  return call<ApprovalReview>(
    "upande_scp.serverscripts.spray_plan_creator.approval_review.get_approval_review",
    { wo_name: woName },
  );
}
```

- [ ] **Step 2: Endpoint contract smoke**

```bash
cd /home/ubuntu/stive/code/frappe15
bench --site kaitet.local console <<'PY'
from upande_scp.serverscripts.spray_plan_creator.bootstrap import fetch_creator_bootstrap
import frappe
frappe.set_user("Administrator")
b = fetch_creator_bootstrap()
print("bootstrap keys:", sorted(b.keys()))
print("scope keys:", sorted(b["scope"].keys()))
print("greenhouses sample:", b["greenhouses"][:1])
PY
```

Expected: keys include `scope`, `greenhouses`, `kits`, `spray_teams`, `tank_mixes`, `rate_limits`, `pest_catalog`, `disease_catalog`, `weather_settings`, `irac_window_days`, `frac_window_days`. (`scope` has `farms` and `allowed_warehouses`.)

- [ ] **Step 3: Build**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend
npm run build 2>&1 | tail -8
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add frontend/src/lib/spray-plan-creator-api.ts
git commit -m "$(cat <<'EOF'
feat(spray-plan): add typed API helpers for Spray Plan Creator endpoints

Wraps the four A1 backend modules (bootstrap, drafts, bulk,
approval_review) with TypeScript interfaces and call() helpers ready
for the ApplicationPlan rewrite and Approval page enhancements.
EOF
)"
```

---

## Task 2 — Switch ApplicationPlan to the new bootstrap + Access-Denied gate

**Files:**
- Modify: `frontend/src/pages/ApplicationPlan.tsx`

This task replaces the legacy `fetchApplicationPlanBootstrap` import with `fetchCreatorBootstrap`, adds a 403/no-farms gate at the top of the component, and replaces the four-call bootstrap (`fetchApplicationPlanBootstrap`, `fetchChemicalRateLimits`, `fetchBedsAndZones`, `fetchZonesByGreenhouse`) with a single call. Existing UI structure stays intact.

### Steps

- [ ] **Step 1: Read the existing imports + first 100 lines of ApplicationPlan.tsx**

Open `frontend/src/pages/ApplicationPlan.tsx` and read lines 1-110 to understand the import structure and state declarations.

- [ ] **Step 2: Swap the bootstrap imports**

Find the import block at the top of the file (around lines 42-60) that imports from `@/lib/scouting-api`. The legacy line includes things like:

```typescript
import {
  createBom,
  fetchApplicationPlanBootstrap,
  fetchBedsAndZones,
  fetchBedsByGreenhouse,
  fetchBomDetails,
  fetchChemicalRateLimits,
  fetchZonesByGreenhouse,
  searchChemicalItems,
  type BedAreaRow,
  type BomChemical,
  type BomDetails,
  type ChemicalItem,
  type PlanBootstrap,
  type RateLimit,
  type VarietyNode,
} from "@/lib/scouting-api";
```

Keep `fetchBedsAndZones`, `fetchBedsByGreenhouse`, `fetchBomDetails`, `fetchZonesByGreenhouse`, `searchChemicalItems`, and the type imports `BedAreaRow`, `BomChemical`, `BomDetails`, `ChemicalItem`, `RateLimit`, `VarietyNode`. **Remove** `createBom`, `fetchApplicationPlanBootstrap`, `fetchChemicalRateLimits`, and `type PlanBootstrap`.

Add a new import below:

```typescript
import {
  fetchCreatorBootstrap,
  type CreatorBootstrap,
} from "@/lib/spray-plan-creator-api";
import { FrappeError } from "@/lib/frappe";
```

- [ ] **Step 3: Replace the bootstrap state**

Find the state declaration near the top of the component (around line 171):

```typescript
  const [bootstrap, setBootstrap] = useState<PlanBootstrap | null>(null);
```

Replace with:

```typescript
  const [bootstrap, setBootstrap] = useState<CreatorBootstrap | null>(null);
  const [bootstrapError, setBootstrapError] = useState<{ status: number; message: string } | null>(null);
```

Also find `rateLimits` state (around line 178):

```typescript
  const [rateLimits, setRateLimits] = useState<Record<string, RateLimit>>({});
```

Keep that — but derive its value from the bootstrap in the effect instead of fetching separately.

- [ ] **Step 4: Replace the bootstrap effect**

Find the `useEffect` that calls the four legacy fetches (around line 262):

```typescript
  useEffect(() => {
    fetchApplicationPlanBootstrap().then(setBootstrap);
    fetchChemicalRateLimits().then(setRateLimits);
    fetchBedsAndZones().then(setVarietyTree);
    fetchZonesByGreenhouse().then(setZonesByGh);
    fetchBedsByGreenhouse().then(setBedsByGh);
  }, []);
```

Replace with:

```typescript
  useEffect(() => {
    let cancelled = false;
    fetchCreatorBootstrap()
      .then((b) => {
        if (cancelled) return;
        setBootstrap(b);
        // Convert the rate_limits Record from bootstrap into the existing RateLimit shape
        setRateLimits(b.rate_limits as Record<string, RateLimit>);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof FrappeError) {
          setBootstrapError({ status: e.status, message: e.message });
        } else {
          setBootstrapError({ status: 0, message: String(e) });
        }
      });
    fetchBedsAndZones().then((v) => !cancelled && setVarietyTree(v));
    fetchZonesByGreenhouse().then((z) => !cancelled && setZonesByGh(z));
    fetchBedsByGreenhouse().then((b) => !cancelled && setBedsByGh(b));
    return () => {
      cancelled = true;
    };
  }, []);
```

- [ ] **Step 5: Replace the derived lists from bootstrap**

Find these around line 528-533:

```typescript
  const ghList = useMemo(
    () => bootstrap?.warehouses.map((w) => w.name) || [],
    [bootstrap],
  );
  const bomList = useMemo(() => bootstrap?.boms || [], [bootstrap]);
  const kitList = useMemo(() => bootstrap?.kits || [], [bootstrap]);
```

Replace with:

```typescript
  const ghList = useMemo(
    () => bootstrap?.greenhouses.map((g) => g.name) || [],
    [bootstrap],
  );
  const bomList = useMemo(
    () => (bootstrap?.tank_mixes || []).map((t) => ({
      name: t.name,
      item_name: t.item_name,
      custom_farm: t.custom_farm,
    })),
    [bootstrap],
  );
  const kitList = useMemo(
    () => (bootstrap?.kits || []).map((k) => ({ kit: k.kit, warehouse: k.warehouse })),
    [bootstrap],
  );
```

- [ ] **Step 6: Add the 403 / no-farms gate**

Find the top of the `return` statement (around line 771). Just BEFORE it, add:

```typescript
  if (bootstrapError) {
    return <AccessGate error={bootstrapError} />;
  }
  if (bootstrap && bootstrap.scope.farms.length === 0) {
    return <NoFarmsGate />;
  }
```

Then at the bottom of the file, BEFORE the `NumInput` function declaration, add these two new components:

```tsx
function AccessGate({ error }: { error: { status: number; message: string } }) {
  return (
    <div className="flex flex-col min-h-svh items-center justify-center px-4">
      <Card className="max-w-md border-destructive/40">
        <CardHeader>
          <CardTitle className="text-base text-destructive">
            {error.status === 403 ? "Access denied" : "Cannot load spray plan tools"}
          </CardTitle>
          <CardDescription>
            {error.status === 403
              ? "This page is restricted to users with the 'Spray Plan Creator' role. Ask a General Manager to grant you the role."
              : error.message}
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}

function NoFarmsGate() {
  return (
    <div className="flex flex-col min-h-svh items-center justify-center px-4">
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle className="text-base">No farms assigned yet</CardTitle>
          <CardDescription>
            You hold the 'Spray Plan Creator' role but no farm has been assigned to you.
            Ask a General Manager to add you on the Spray Plan Access page.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
```

- [ ] **Step 7: Build**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend
npm run build 2>&1 | tail -10
```

If TypeScript flags missing imports (`Card`, `CardHeader`, etc.) for the new gate components — those are likely already imported in the file. If a build error persists, add the missing ones to the top of the file.

Expected: clean build.

- [ ] **Step 8: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add frontend/src/pages/ApplicationPlan.tsx
git commit -m "$(cat <<'EOF'
feat(spray-plan): switch ApplicationPlan to A1 bootstrap + role gate

Replaces the legacy fetchApplicationPlanBootstrap/fetchChemicalRateLimits
calls with a single fetch_creator_bootstrap call that returns farm-scoped
greenhouses, kits, spray teams and tank mixes. Adds Access-Denied (403)
and No-Farms (empty scope) gate panels. UI structure unchanged otherwise.
EOF
)"
```

---

## Task 3 — Classification + Preventive Reason

**Files:**
- Modify: `frontend/src/pages/ApplicationPlan.tsx`

### Steps

- [ ] **Step 1: Add new state**

Near the existing `sprayType`, `scope`, `bom`, `kit` state declarations (around line 192), add:

```typescript
  const [classification, setClassification] = useState<"" | "Curative" | "Preventive">("");
  const [preventiveReason, setPreventiveReason] = useState<string>("");
```

- [ ] **Step 2: Render the classification radio + conditional reason**

Find the "Spray Details" card body (around line 992 — `<CardContent className="p-0 grid grid-cols-2 gap-3">`). Insert this block as the FIRST item inside that grid (before the existing "Scheduled Application Date" field):

```tsx
              <div className="flex flex-col gap-1 col-span-2">
                <Label>Classification</Label>
                <div className="flex gap-2">
                  {(["Curative", "Preventive"] as const).map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setClassification(c)}
                      className={
                        "px-3 py-1.5 rounded-md border text-xs transition-colors " +
                        (classification === c
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-muted hover:bg-muted/70")
                      }
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>

              {classification === "Preventive" && (
                <div className="flex flex-col gap-1 col-span-2">
                  <Label className="flex items-center justify-between">
                    <span>Preventive Reason</span>
                    <span className="text-[0.6rem] uppercase tracking-wide text-muted-foreground">
                      required (min 20 chars)
                    </span>
                  </Label>
                  <textarea
                    value={preventiveReason}
                    onChange={(e) => setPreventiveReason(e.target.value)}
                    placeholder="Why does this routine spray make sense without an observation trigger?"
                    rows={3}
                    className="w-full rounded-md border bg-background px-3 py-2 text-xs"
                  />
                </div>
              )}
```

- [ ] **Step 3: Validate classification in `submit`**

Find the existing `submit` function (around line 574). After the first guard (around line 575):

```typescript
    if (!greenhouse || !sprayDate || !sprayType || !scope || !bom || !kit) {
```

Replace with:

```typescript
    if (!greenhouse || !sprayDate || !sprayType || !scope || !bom || !kit || !classification) {
      pushToast("err", "Fill in greenhouse, date, spray type, scope, kit, BOM and classification.");
      return;
    }
    if (classification === "Preventive" && preventiveReason.trim().length < 20) {
      pushToast("err", "Preventive plans need a reason of at least 20 characters.");
      return;
    }
```

(Delete the original message — it's superseded by this combined check.)

- [ ] **Step 4: Build**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend
npm run build 2>&1 | tail -8
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add frontend/src/pages/ApplicationPlan.tsx
git commit -m "$(cat <<'EOF'
feat(spray-plan): add Classification radio + conditional Preventive Reason

Adds a Curative/Preventive picker at the top of Spray Details. Preventive
unlocks a required Reason textarea (min 20 chars), validated before
submission. Curative path is unchanged from the user's perspective.
EOF
)"
```

---

## Task 4 — Stop auto-selecting targets; switch to A1 create endpoint; remove Desk redirect

**Files:**
- Modify: `frontend/src/pages/ApplicationPlan.tsx`

### Steps

- [ ] **Step 1: Add targets state**

Near the other plan-form state (around line 213), add:

```typescript
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());
```

- [ ] **Step 2: Replace the `targetsList` derivation in `submit`**

Find the block in `submit` (around line 615) that auto-builds `targetsList`:

```typescript
    const targetsList =
      diag.pest !== ALL
        ? [diag.pest]
        : Array.from(
            new Set(
              data?.entries
                .filter(
                  (e) =>
                    greenhouseOfZone(e.zone || "") === greenhouse &&
                    (e.zone ? !!zoneObs[e.zone] : false),
                )
                .flatMap((e) => [
                  ...e.pests_scouting_entry.map((p) => p.pest),
                  ...e.diseases_scouting_entry.map((d) => d.disease),
                ]) || [],
            ),
          );
    if (!targetsList.length) {
      pushToast("err", "No targets — pick a pest in the diagnose filter.");
      return;
    }
```

Replace with:

```typescript
    const targetsList = Array.from(selectedTargets);
    if (!targetsList.length) {
      pushToast("err", "Pick at least one target.");
      return;
    }
```

- [ ] **Step 3: Render a target-picker chip row in the Targets section**

Find the existing "Targets" card section (around line 1136, the block that renders `<Badge variant="default">...</Badge>` chips based on `diag.pest`). Replace that entire `<div className="col-span-2">` block with:

```tsx
              <div className="col-span-2">
                <Label className="flex items-center justify-between">
                  <span>Targets</span>
                  <span className="text-[0.6rem] uppercase tracking-wide text-muted-foreground">
                    {selectedTargets.size} selected
                  </span>
                </Label>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {(() => {
                    const sourceList =
                      classification === "Preventive"
                        ? [
                            ...(bootstrap?.pest_catalog || []).map((p) => p.name),
                            ...(bootstrap?.disease_catalog || []).map((d) => d.name),
                          ]
                        : Array.from(
                            new Set(
                              data?.entries
                                .filter(
                                  (e) => greenhouseOfZone(e.zone || "") === greenhouse,
                                )
                                .flatMap((e) => [
                                  ...e.pests_scouting_entry.map((p) => p.pest),
                                  ...e.diseases_scouting_entry.map((d) => d.disease),
                                ]) || [],
                            ),
                          );
                    if (!sourceList.length) {
                      return (
                        <span className="text-xs text-muted-foreground">
                          {classification === "Preventive"
                            ? "Pest + Disease catalog is empty — add entries in Frappe Desk."
                            : "No pest/disease observations in the chosen greenhouse yet."}
                        </span>
                      );
                    }
                    return sourceList.sort().map((t) => {
                      const on = selectedTargets.has(t);
                      return (
                        <button
                          key={t}
                          type="button"
                          onClick={() =>
                            setSelectedTargets((prev) => {
                              const next = new Set(prev);
                              if (next.has(t)) next.delete(t);
                              else next.add(t);
                              return next;
                            })
                          }
                          className={
                            "px-2 py-0.5 rounded-full text-[0.7rem] border transition-colors " +
                            (on
                              ? "bg-primary text-primary-foreground border-primary"
                              : "bg-muted hover:bg-muted/70")
                          }
                        >
                          {t}
                        </button>
                      );
                    });
                  })()}
                </div>
              </div>
```

- [ ] **Step 4: Reset selected targets when greenhouse or classification changes**

Find the existing scope-reset effect (around line 338):

```typescript
  useEffect(() => {
    setSelectedVarieties(new Set());
    setBedNumbers("");
  }, [scope, greenhouse]);
```

Add a similar effect right below it:

```typescript
  useEffect(() => {
    setSelectedTargets(new Set());
  }, [greenhouse, classification]);
```

- [ ] **Step 5: Swap the `submit` call to `createDraftSprayPlan`**

In the `submit` function (around line 678), find:

```typescript
      const r: any = await call(
        "upande_scp.serverscripts.create_application_work_order.createApplicationWorkOrder",
        { payload: { raw_data: formData } },
      );
```

Replace with:

```typescript
      // Use the A1 create_draft_spray_plan endpoint. Payload shape matches
      // the DraftPayload interface in spray-plan-creator-api.ts.
      const draftPayload = {
        custom_greenhouse: greenhouse,
        custom_classification: classification,
        custom_preventive_reason: preventiveReason,
        custom_spray_type: sprayType,
        custom_scope: scope,
        custom_scope_details: customScopeDetails,
        custom_kit: kit,
        custom_spray_team: sprayTeam || null,
        custom_water_ph: parseFloat(waterPh) || 0,
        custom_water_hardness: parseFloat(waterHardness) || 0,
        custom_water_volume: parseFloat(waterVolume) || 0,
        custom_area: parseFloat(area) || 0,
        custom_targets: targetsList,
        production_item: bom,
        chemicals: chemRows.map((c) => ({
          item_code: c.item_code,
          item_name: c.item_name,
          uom: c.stock_uom,
          source_warehouse: c.source,
          application_rate: c.stock_qty,
        })),
        custom_scheduled_application_time: sprayDate || null,
      };
      const r = await createDraftSprayPlan(draftPayload);
```

Also add `createDraftSprayPlan` to the imports from `spray-plan-creator-api` at the top of the file.

- [ ] **Step 6: Remove the Desk redirect**

Right after the `await createDraftSprayPlan(...)` call, the next block currently looks like (paraphrased):

```typescript
      const woName = r?.work_order_name || r?.work_order;
      if (r?.status && r.status !== "success") {
        dismissToast(loaderId);
        pushToast("err", r?.message || "Server rejected the work order.");
        return;
      }
      dismissToast(loaderId);
      pushToast(
        "ok",
        woName
          ? `Created ${woName} — redirecting to Desk…`
          : "Spray plan created — redirecting…",
      );
      setTimeout(() => {
        if (woName) {
          window.location.assign(
            `/app/work-order/${encodeURIComponent(woName)}`,
          );
        }
      }, 1200);
```

Replace with:

```typescript
      const woName = (r as { work_order?: string })?.work_order;
      dismissToast(loaderId);
      pushToast(
        "ok",
        woName ? `Added ${woName} to your draft batch.` : "Plan added to batch.",
      );
      // Reset the form so the user can build the next plan in the batch
      setClassification("");
      setPreventiveReason("");
      setSelectedTargets(new Set());
      setChemRows([]);
      setBom("");
      // Notify the draft batch panel to refresh (Task 5 wires this)
      window.dispatchEvent(new CustomEvent("spray-plan:draft-added"));
```

- [ ] **Step 7: Build**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend
npm run build 2>&1 | tail -10
```

Expected: clean build.

- [ ] **Step 8: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add frontend/src/pages/ApplicationPlan.tsx
git commit -m "$(cat <<'EOF'
feat(spray-plan): targets no longer auto-selected; switch to create_draft endpoint

Targets must be explicitly picked by the operator. Curative pulls
candidates from recent scouting; Preventive pulls from the full
Pest + Disease catalog. Submission now hits create_draft_spray_plan
(the A1 endpoint), which creates a workflow_state='Pending Submission'
Work Order. Desk redirect removed — drafts accumulate in the batch
panel (wired in next task).
EOF
)"
```

---

## Task 5 — Draft Batch panel + Submit-all-for-approval

**Files:**
- Create: `frontend/src/components/spray-plan/DraftBatchPanel.tsx`
- Modify: `frontend/src/pages/ApplicationPlan.tsx`

### Steps

- [ ] **Step 1: Create the panel component**

```bash
mkdir -p frontend/src/components/spray-plan
```

`frontend/src/components/spray-plan/DraftBatchPanel.tsx`:

```tsx
/**
 * Right-rail panel listing the current user's Pending Submission spray plan
 * drafts. Hooks into the "spray-plan:draft-added" window event so newly
 * created drafts refresh the list without a manual reload.
 *
 * Submit-all calls submit_drafts_for_approval (race-free bulk transition).
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Trash2, Send, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  deleteDraftPlan,
  listMyDraftPlans,
  submitDraftsForApproval,
  type DraftSummary,
} from "@/lib/spray-plan-creator-api";
import { FrappeError } from "@/lib/frappe";

interface Props {
  onToast: (kind: "ok" | "err" | "loading", text: string, autoMs?: number) => number;
  onDismiss: (id: number) => void;
}

export function DraftBatchPanel({ onToast, onDismiss }: Props) {
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    listMyDraftPlans()
      .then((rows) => setDrafts(rows))
      .catch((e) => {
        if (e instanceof FrappeError && e.status === 403) {
          // Caller's gate already handles this; just keep panel empty.
          setDrafts([]);
        } else {
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    const handler = () => refresh();
    window.addEventListener("spray-plan:draft-added", handler);
    return () => window.removeEventListener("spray-plan:draft-added", handler);
  }, [refresh]);

  const remove = async (name: string) => {
    const tid = onToast("loading", `Removing ${name}…`, 0);
    try {
      await deleteDraftPlan(name);
      onDismiss(tid);
      onToast("ok", `${name} removed.`);
      refresh();
    } catch (e) {
      onDismiss(tid);
      onToast("err", e instanceof Error ? e.message : String(e));
    }
  };

  const submitAll = async () => {
    if (!drafts.length) return;
    setBusy(true);
    const tid = onToast("loading", `Submitting ${drafts.length} draft(s) for approval…`, 0);
    try {
      const result = await submitDraftsForApproval(drafts.map((d) => d.name));
      onDismiss(tid);
      if (result.skipped.length > 0) {
        onToast(
          "ok",
          `Submitted ${result.submitted.length} · ${result.skipped.length} skipped.`,
          6000,
        );
      } else {
        onToast("ok", `Submitted ${result.submitted.length} for approval.`);
      }
      refresh();
    } catch (e) {
      onDismiss(tid);
      onToast("err", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="sticky top-20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span>Draft batch ({drafts.length})</span>
          {drafts.length > 0 && (
            <Button onClick={submitAll} disabled={busy} size="sm" className="h-7">
              {busy ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Send className="h-3 w-3" />
              )}
              Submit all
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {loading && (
          <div className="px-4 py-3 text-xs text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading drafts…
          </div>
        )}
        {error && (
          <div className="px-4 py-3 text-xs text-destructive flex items-start gap-1">
            <AlertTriangle className="h-3 w-3 mt-[1px]" />
            <span>{error}</span>
          </div>
        )}
        {!loading && !error && drafts.length === 0 && (
          <div className="px-4 py-3 text-xs text-muted-foreground">
            No drafts yet. Build a plan above, click <b>Create Spray Plan</b>,
            and it appears here.
          </div>
        )}
        {!loading && !error && drafts.length > 0 && (
          <ul className="divide-y">
            {drafts.map((d) => (
              <li
                key={d.name}
                className="px-3 py-2 flex flex-col gap-0.5 text-xs hover:bg-muted/30"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{d.name}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground hover:text-destructive"
                    onClick={() => remove(d.name)}
                    title="Remove from batch"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
                <div className="text-[0.65rem] text-muted-foreground">
                  {d.greenhouse} · {d.classification}
                </div>
                <div className="text-[0.65rem] text-muted-foreground">
                  {d.targets.slice(0, 4).join(", ")}
                  {d.targets.length > 4 && ` · +${d.targets.length - 4}`}
                </div>
                {d.scheduled_date && (
                  <div className="text-[0.6rem] text-muted-foreground tabular-nums">
                    {d.scheduled_date}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Mount the panel inside ApplicationPlan**

In `frontend/src/pages/ApplicationPlan.tsx`, find the "STEP 2 · PRESCRIBE" section header (around line 974). The section currently has a grid: `<div className="grid grid-cols-1 lg:grid-cols-2 gap-3">` with two cards. We restructure that container to fit a third column on wide screens for the batch panel.

Change the grid declaration from:

```tsx
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
```

To:

```tsx
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_1fr_18rem] gap-3">
```

Then, immediately AFTER the closing `</Card>` of the second card (the "Bill of Materials" card — around line 1374), add a third column:

```tsx
          <div className="hidden xl:block">
            <DraftBatchPanel onToast={pushToast} onDismiss={dismissToast} />
          </div>
```

Below `<div className="flex justify-end">` (around line 1377), also wrap the batch panel into the mobile layout — it should appear after the Create button on narrower screens. Add this block AFTER the closing `</div>` that wraps the Create button:

```tsx
        <div className="xl:hidden mt-3">
          <DraftBatchPanel onToast={pushToast} onDismiss={dismissToast} />
        </div>
```

Add the import at the top of the file:

```tsx
import { DraftBatchPanel } from "@/components/spray-plan/DraftBatchPanel";
```

- [ ] **Step 3: Update the Create button label**

The submit button (around line 1378) currently says `Create Spray Plan`. The new wording reflects the batch flow:

```tsx
            Add to batch
```

Replace the existing label `Create Spray Plan` with `Add to batch`.

- [ ] **Step 4: Build**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend
npm run build 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add frontend/src/components/spray-plan/DraftBatchPanel.tsx \
        frontend/src/pages/ApplicationPlan.tsx
git commit -m "$(cat <<'EOF'
feat(spray-plan): Draft Batch panel + bulk Submit-for-Approval

Right-rail panel lists the current user's Pending Submission drafts,
refreshed on every successful Add-to-batch via a window CustomEvent.
'Submit all' calls submit_drafts_for_approval (the A1 race-free endpoint)
and surfaces submitted/skipped counts. Per-draft Remove deletes via
delete_draft_plan. Layout becomes 3-column on xl+ screens, stacked below
on smaller. Create-Spray-Plan button renamed to Add-to-batch.
EOF
)"
```

---

## Task 6 — Approval page: per-WO rates + IRAC/FRAC + bulk approve

**Files:**
- Modify: `frontend/src/pages/Approvals.tsx`
- Create: `frontend/src/components/spray-plan/ApprovalChemicalsTable.tsx`

This task augments the Approval page rather than rewriting it. The bulk-approve flow needs a checkbox column + button; each row gets an expandable chemicals section sourced from `get_approval_review`.

### Steps

- [ ] **Step 1: Read the existing Approvals.tsx to confirm structure**

Open `frontend/src/pages/Approvals.tsx` and scan its current structure. Find:
- Where rows are rendered (typically a `<Table>` or `Card`-per-row pattern).
- Whether selection state already exists.
- Where the approve action is dispatched (single approve currently).

The page is ~1012 lines; you don't need to memorise it, just locate the row-render block.

- [ ] **Step 2: Add the chemicals-with-codes mini component**

`frontend/src/components/spray-plan/ApprovalChemicalsTable.tsx`:

```tsx
/**
 * Inline expand-panel for the Approval page showing each chemical with
 * its IRAC/FRAC codes, rate, rate-limit indicator, and resistance
 * warnings (IRAC/FRAC rotation within the configured window).
 *
 * Data comes from get_approval_review — loaded on demand when the
 * Approval page expands the row. We don't pre-fetch all reviews for
 * the whole page to keep it fast for large pending sets.
 */

import { useEffect, useState } from "react";
import { Loader2, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  getApprovalReview,
  type ApprovalReview,
} from "@/lib/spray-plan-creator-api";

interface Props {
  woName: string;
}

export function ApprovalChemicalsTable({ woName }: Props) {
  const [review, setReview] = useState<ApprovalReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getApprovalReview(woName)
      .then((r) => !cancelled && setReview(r))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [woName]);

  if (loading) {
    return (
      <div className="text-xs text-muted-foreground flex items-center gap-2 px-2 py-3">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading chemical review…
      </div>
    );
  }
  if (error) {
    return (
      <div className="text-xs text-destructive flex items-start gap-1 px-2 py-3">
        <AlertTriangle className="h-3 w-3 mt-[1px]" />
        <span>{error}</span>
      </div>
    );
  }
  if (!review) return null;

  return (
    <div className="px-3 py-2 border-t bg-muted/20">
      {review.plan_warnings.length > 0 && (
        <div className="mb-2 text-[0.65rem] text-amber-700 dark:text-amber-400 flex flex-wrap gap-2">
          {review.plan_warnings.map((w) => (
            <span key={w} className="inline-flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {w}
            </span>
          ))}
        </div>
      )}
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[0.65rem] uppercase tracking-wide text-muted-foreground">
            <th className="py-1">Chemical</th>
            <th>Codes</th>
            <th className="text-right">Rate</th>
            <th>Status</th>
            <th>Resistance</th>
          </tr>
        </thead>
        <tbody>
          {review.chemicals.map((c) => (
            <tr key={c.item_code} className="border-t border-border/40">
              <td className="py-1.5 align-top">
                <div className="font-medium">{c.item_name || c.item_code}</div>
                <div className="text-[0.6rem] text-muted-foreground font-mono">{c.item_code}</div>
              </td>
              <td className="align-top">
                <div className="flex flex-wrap gap-1">
                  {c.irac_code && (
                    <Badge variant="outline" className="text-[0.6rem]">
                      IRAC {c.irac_code}
                    </Badge>
                  )}
                  {c.frac_code && (
                    <Badge variant="outline" className="text-[0.6rem]">
                      FRAC {c.frac_code}
                    </Badge>
                  )}
                  {!c.irac_code && !c.frac_code && (
                    <span className="text-[0.6rem] text-muted-foreground">—</span>
                  )}
                </div>
              </td>
              <td className="text-right tabular-nums align-top">
                {c.application_rate?.toFixed(2)} {c.stock_uom}
              </td>
              <td className="align-top">
                {c.rate_status === "ok" && (
                  <span className="text-[0.65rem] text-[var(--sd-data-green)]">OK</span>
                )}
                {c.rate_status === "below" && (
                  <span className="text-[0.65rem] text-amber-600">below limit</span>
                )}
                {c.rate_status === "above" && (
                  <span className="text-[0.65rem] text-destructive">above limit</span>
                )}
              </td>
              <td className="align-top">
                {c.resistance_warnings.length === 0 ? (
                  <span className="text-[0.65rem] text-muted-foreground">—</span>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    {c.resistance_warnings.map((w, i) => (
                      <span
                        key={`${w.kind}-${w.code}-${i}`}
                        className="text-[0.6rem] text-amber-700 dark:text-amber-400"
                      >
                        {w.message}
                      </span>
                    ))}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Mount the chemicals table in Approvals.tsx**

Open `frontend/src/pages/Approvals.tsx`. The page renders pending WOs as rows; each row likely has some expandable detail or just static info. Strategy:

1. Add a `selectedWOs: Set<string>` state at the top of the component.
2. Find the row-render block. Add a checkbox at the start of each row that toggles inclusion in `selectedWOs`.
3. Below each row's existing content, mount `<ApprovalChemicalsTable woName={wo.name} />` so the chemicals are always visible (no toggle).
4. Add a sticky bulk-action bar showing `{selectedWOs.size} selected · Approve selected` when at least one is selected.

The exact line numbers depend on the current structure of Approvals.tsx, so use Edit with the surrounding context once you've read the relevant section. A minimal addition pattern looks like:

Import:
```tsx
import { ApprovalChemicalsTable } from "@/components/spray-plan/ApprovalChemicalsTable";
import { approveDraftsBulk } from "@/lib/spray-plan-creator-api";
import { Checkbox } from "@/components/ui/checkbox";  // likely already imported
```

State (add inside the component near other state declarations):
```tsx
const [selectedWOs, setSelectedWOs] = useState<Set<string>>(new Set());
const [bulkBusy, setBulkBusy] = useState(false);

const toggleSelect = (name: string) =>
  setSelectedWOs((prev) => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });

const bulkApprove = async () => {
  if (!selectedWOs.size) return;
  setBulkBusy(true);
  try {
    const result = await approveDraftsBulk(Array.from(selectedWOs));
    pushToast?.(
      "ok",
      `Approved ${result.approved.length}${result.skipped.length ? ` · ${result.skipped.length} skipped` : ""}.`,
    );
    setSelectedWOs(new Set());
    // Trigger whatever refresh the page already does after a single-approve
    refresh?.();   // adapt to the existing refresh function name in the page
  } catch (e) {
    pushToast?.("err", e instanceof Error ? e.message : String(e));
  } finally {
    setBulkBusy(false);
  }
};
```

(Replace `pushToast?.` / `refresh?.` with the actual function names used in the existing Approvals.tsx — read the file first to find them.)

Where each WO row is rendered, add a `<Checkbox>` cell at the front and an `<ApprovalChemicalsTable />` directly below the row's main content. The exact placement depends on the existing layout — fit it in.

Add a sticky bulk-action bar near the top of the rendered list (above the table):

```tsx
{selectedWOs.size > 0 && (
  <div className="sticky top-16 z-30 bg-card border-b py-2 px-4 flex items-center justify-between gap-2">
    <span className="text-xs text-muted-foreground">
      {selectedWOs.size} selected
    </span>
    <Button onClick={bulkApprove} disabled={bulkBusy} size="sm" className="h-8">
      {bulkBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
      Approve selected
    </Button>
  </div>
)}
```

- [ ] **Step 4: Build**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend
npm run build 2>&1 | tail -10
```

Expected: clean build.

If TypeScript complains about `pushToast` / `refresh` references that don't exist in Approvals.tsx, locate the actual function names (often the page has its own toaster state) and adapt the snippets above.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add frontend/src/components/spray-plan/ApprovalChemicalsTable.tsx \
        frontend/src/pages/Approvals.tsx
git commit -m "$(cat <<'EOF'
feat(spray-plan): Approval page — rates, IRAC/FRAC chips, bulk approve

Each WO row now expands with a chemicals table sourced from
get_approval_review: IRAC/FRAC code chips, per-chemical rate +
rate-status indicator, and per-chemical resistance warnings.
A checkbox column + sticky bulk-approve bar drive the new
approve_drafts_bulk endpoint (race-free GM transition).
EOF
)"
```

---

## Self-review

After all six tasks:

**Spec coverage** (§6 + §7 of the design doc):

- §6.1 Page gate → Task 2 (AccessGate + NoFarmsGate)
- §6.2 Scope chip — partially: scope farms shown in counts; full chip with switcher deferred (only one farm per user in practice)
- §6.3 Three-column layout → Deferred (single-column with batch panel as a 3rd col on XL screens — see Task 5)
- §6.4 Weather forecast → **Deferred** (per the Scope decisions block above)
- §6.5 Plan form sequence + Classification → Tasks 3 + 4
- §6.5 Targets picker (no pre-selection, dual-mode) → Task 4
- §6.5 Tank mix + rates without New BOM → Already present in current page (the legacy New BOM button can be removed in a follow-up; A1 backend already ignores the rate-override path)
- §6.5 Spray team roster editing → **Deferred** (child table `custom_spray_plan_team_members` exists from A1; the basic `custom_spray_team` text mirror still works)
- §6.5 Validation panel → Implicit in Task 3 + 4 (toasts on submit)
- §6.5 Add-to-batch → Task 4 + 5
- §6.6 Draft batch list → Task 5
- §6.6 No Desk redirect → Task 4
- §6.7 React Query — not adopted; existing imperative pattern kept to minimise churn in this iteration
- §7.1 Approval card layout → Task 6
- §7.2 Bulk approve → Task 6
- §7.3 Rejection → Already worked via the existing `stop_single_work_order` flow; no change needed

**Type consistency:**

- `DraftPayload` shape sent by the frontend exactly matches the keys accepted by `_apply_payload` in `drafts.py`.
- `ApprovalReview` matches the response shape from `approval_review.get_approval_review`.

---

## Open follow-ups (deliberately out of scope of A3)

- Weather forecast section (Open-Meteo + traffic-light chips).
- Three-column layout redesign.
- Per-plan spray team roster editing via `custom_spray_plan_team_members`.
- Remove the inline `createBom` / "New BOM" dialog (still callable; harmless until A2 admins manage tank mixes elsewhere).
- React Query migration.
