# Spray Plan A2 — Admin Page (GM → Farm Assignments) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the GM-only `/scp_app#/spray-plan-access` React page that lets a General Manager assign Spray Plan Creators to farms. Consumes the admin endpoints that already shipped in A1.

**Architecture:** Single new React page following the existing hash-router + lazy-loaded pattern (no React Router). One screen, one row per Farm, inline-editable multi-user chip picker per farm with server-side typeahead for "Spray Plan Creator" role candidates. Endpoint-level role gating already enforced; the page surfaces 403 as an Access-Denied panel.

**Tech Stack:** React 18 + TypeScript + shadcn/ui + lucide-react. Hash-based custom router (`@/lib/router`). Backend endpoints from A1: `list_farms_with_creators`, `list_spray_plan_creator_candidates`, `set_farm_creators`.

**Spec reference:** [docs/superpowers/specs/2026-05-18-spray-plan-creator-workflow-design.md](../specs/2026-05-18-spray-plan-creator-workflow-design.md) §4.
**Plan A1 (prerequisite):** [2026-05-18-spray-plan-a1-backend-foundation.md](2026-05-18-spray-plan-a1-backend-foundation.md) — backend endpoints already shipped.

---

## Pre-flight

### Conventions
- Working dir: `/home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend` (the Vite project root).
- TypeScript strict mode. shadcn/ui components live under `src/components/ui/`.
- The `call()` helper at `src/lib/frappe.ts:46` is the universal Frappe API caller — it throws `FrappeError` with `.status` on non-2xx. 403 means PermissionError (the user isn't General Manager / System Manager).
- Hash router from `src/lib/router.ts` — adding a route means: (a) extending the `View` union, (b) extending `KNOWN_VIEWS`, (c) adding a lazy import + render branch in `src/App.tsx`, (d) adding a sidebar entry in `src/components/AppSidebar.tsx`.
- Commit prefixes: `feat(spray-plan-admin):`, `fix(spray-plan-admin):`, `refactor(spray-plan-admin):`. Always include the `Co-Authored-By` footer.

### Build + sanity check

Before starting, confirm the Vite build succeeds from a clean tree:

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend
npm run build 2>&1 | tail -10
```

Expected: `vite build` exits with no errors (warnings about chunk size are fine).

---

## Task 1 — Wire up the new route, sidebar entry, and skeleton page

**Files:**
- Modify: `frontend/src/lib/router.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/AppSidebar.tsx`
- Create: `frontend/src/pages/SprayPlanAccess.tsx`

### Steps

- [ ] **Step 1: Extend the router's `View` union**

In `frontend/src/lib/router.ts`, add `"spray-plan-access"` to BOTH the `View` type and the `KNOWN_VIEWS` set. Find the existing pattern (each view appears in both places, alphabetised within their group) and add the new value to keep that order. Example — the relevant blocks become:

```typescript
export type View =
  | "dashboard"
  | "trends"
  | "observations"
  | "traps"
  | "heatmaps"
  | "rose"
  | "avocado"
  | "varieties"
  | "reports"
  | "tank-mixes"
  | "historical"
  | "approvals"
  | "spray-plan-access"
  | "application-plan";

const KNOWN_VIEWS: ReadonlySet<View> = new Set([
  "dashboard",
  "trends",
  "observations",
  "traps",
  "heatmaps",
  "rose",
  "avocado",
  "varieties",
  "reports",
  "tank-mixes",
  "historical",
  "approvals",
  "spray-plan-access",
  "application-plan",
]);
```

- [ ] **Step 2: Add the lazy import in `App.tsx`**

In `frontend/src/App.tsx`, find the block of `const Approvals = lazy(...)` declarations near the top of the file. Add a sibling declaration right after `Approvals`:

```typescript
const SprayPlanAccess = lazy(() =>
  import("@/pages/SprayPlanAccess").then((m) => ({ default: m.SprayPlanAccess })),
);
```

- [ ] **Step 3: Add the render branch in `App.tsx`**

Find the `view === "approvals" ? (...)` ternary branch around line 160. Add a new branch immediately after it, before the existing `view === "application-plan"` branch (the order in the chain doesn't affect functionality, but keep visual symmetry with the sidebar order):

```tsx
          ) : view === "spray-plan-access" ? (
            <SprayPlanAccess />
```

Match the indentation and trailing `) :` of the surrounding branches.

- [ ] **Step 4: Add the sidebar entry**

In `frontend/src/components/AppSidebar.tsx`, find the Spray Plan nav group (the block containing `view: "application-plan"`, `view: "approvals"`, `view: "historical"`, `view: "tank-mixes"`). Add a new entry directly after `approvals`:

```tsx
      {
        kind: "view",
        view: "spray-plan-access",
        label: "Access Control",
        icon: ShieldCheck,  // import from lucide-react
      },
```

Add `ShieldCheck` to the existing `lucide-react` import at the top of the file. Visual hint: the entry shows "Access Control" with a shield-check icon. (No sidebar-level role gating in this codebase — every signed-in user sees every entry; the page itself surfaces 403 as Access-Denied. This matches the existing Approvals page pattern.)

- [ ] **Step 5: Create the page skeleton**

`frontend/src/pages/SprayPlanAccess.tsx`:

```tsx
/**
 * Spray Plan Access — General Manager-only admin page that assigns
 * Spray Plan Creators to farms. One row per Farm, inline-editable
 * multi-user chip picker with server-side typeahead.
 *
 * Server-side role gating: the underlying whitelisted endpoints
 * (list_farms_with_creators, list_spray_plan_creator_candidates,
 * set_farm_creators) all call _require_admin() which throws unless the
 * user holds General Manager or System Manager. We surface that as a
 * 403 Access-Denied panel.
 */

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2 } from "lucide-react";

export function SprayPlanAccess() {
  return (
    <div className="flex flex-col min-h-svh">
      <header className="sticky top-0 z-40 flex flex-col gap-3 border-b bg-card/80 backdrop-blur px-4 py-3 md:px-6 md:py-4">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-6" />
          <div>
            <h1 className="text-base md:text-lg font-semibold leading-tight tracking-tight flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" />
              Spray Plan Access
            </h1>
            <p className="text-[0.7rem] uppercase tracking-wide text-muted-foreground font-medium">
              Assign Spray Plan Creators to farms
            </p>
          </div>
        </div>
      </header>

      <section className="px-4 md:px-6 py-4">
        <Card>
          <CardContent className="py-8 flex items-center justify-center text-sm text-muted-foreground gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
```

- [ ] **Step 6: Build verification**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend
npm run build 2>&1 | tail -15
```

Expected: builds cleanly. No TypeScript errors.

- [ ] **Step 7: Manual route smoke**

If you have the dev server running, open `/scp_app#/spray-plan-access` in a browser and confirm the page renders the loading skeleton with the "Spray Plan Access" header. (If you don't have the dev server, skip this step — the build success is enough verification.)

- [ ] **Step 8: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add frontend/src/lib/router.ts \
        frontend/src/App.tsx \
        frontend/src/components/AppSidebar.tsx \
        frontend/src/pages/SprayPlanAccess.tsx
git commit -m "$(cat <<'EOF'
feat(spray-plan-admin): scaffold Spray Plan Access route, sidebar entry, skeleton page

New /scp_app#/spray-plan-access view registered in the hash router with a
lazy-loaded skeleton page. Sidebar gets an "Access Control" entry with a
shield-check icon under the Spray Plan group. Page surfaces only a header
and a loading card for now; data + chip picker land in Task 2 + 3.
EOF
)"
```

---

## Task 2 — API helpers + data fetch + farm-row table render

**Files:**
- Create: `frontend/src/lib/spray-plan-admin-api.ts`
- Modify: `frontend/src/pages/SprayPlanAccess.tsx`

### Steps

- [ ] **Step 1: Write the API helper module**

`frontend/src/lib/spray-plan-admin-api.ts`:

```typescript
/**
 * Whitelisted endpoints for the Spray Plan Access admin page.
 *
 * Backend module: upande_scp.serverscripts.spray_plan_creator.admin
 * Permission: General Manager / System Manager only.
 */

import { call } from "./frappe";

export interface FarmCreatorRow {
  user: string;
  full_name: string;
}

export interface FarmWithCreators {
  farm: string;
  farm_name: string | null;
  business_unit: string;
  creators: FarmCreatorRow[];
}

export interface CreatorCandidate {
  user: string;
  full_name: string | null;
  email: string | null;
}

const PREFIX = "upande_scp.serverscripts.spray_plan_creator.admin";

export async function listFarmsWithCreators(): Promise<FarmWithCreators[]> {
  const r = await call<{ message: FarmWithCreators[] }>(
    `${PREFIX}.list_farms_with_creators`,
  );
  return r.message ?? [];
}

export async function listCreatorCandidates(q?: string): Promise<CreatorCandidate[]> {
  const r = await call<{ message: CreatorCandidate[] }>(
    `${PREFIX}.list_spray_plan_creator_candidates`,
    { q: q ?? "" },
  );
  return r.message ?? [];
}

export async function setFarmCreators(
  farm: string,
  users: string[],
): Promise<FarmWithCreators> {
  const r = await call<{ message: { farm: string; creators: FarmCreatorRow[] } }>(
    `${PREFIX}.set_farm_creators`,
    { farm, users: JSON.stringify(users) },
  );
  const reply = r.message;
  return {
    farm: reply.farm,
    farm_name: null,
    business_unit: "",
    creators: reply.creators,
  };
}
```

Note: Frappe wraps return values in `{ message: ... }` because the endpoint is decorated with `@frappe.whitelist()`. The `call()` helper preserves that envelope — we unpack `.message` per-call.

Note: `users` is JSON-stringified because Frappe's REST API serialises every argument as a string and the server uses `frappe.parse_json` to reparse it. This matches the pattern in A1's `set_farm_creators` implementation.

- [ ] **Step 2: Replace the skeleton page with the data-loaded table**

Replace the `<section>` body in `frontend/src/pages/SprayPlanAccess.tsx` with the data-loaded version. Update the file to:

```tsx
/**
 * Spray Plan Access — General Manager-only admin page that assigns
 * Spray Plan Creators to farms. One row per Farm, inline-editable
 * multi-user chip picker with server-side typeahead.
 *
 * Server-side role gating: the underlying whitelisted endpoints all call
 * _require_admin() which throws 403 unless the user holds General Manager
 * or System Manager. We surface that as an Access-Denied panel.
 */

import { useEffect, useState } from "react";
import { Loader2, ShieldCheck, ShieldAlert } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  listFarmsWithCreators,
  type FarmWithCreators,
} from "@/lib/spray-plan-admin-api";
import { FrappeError } from "@/lib/frappe";

export function SprayPlanAccess() {
  const [farms, setFarms] = useState<FarmWithCreators[] | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listFarmsWithCreators()
      .then((rows) => {
        if (cancelled) return;
        setFarms(rows);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof FrappeError) {
          setError({ status: e.status, message: e.message });
        } else {
          setError({ status: 0, message: String(e) });
        }
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const totalCreators = (farms ?? []).reduce(
    (s, f) => s + (f.creators?.length || 0),
    0,
  );

  return (
    <div className="flex flex-col min-h-svh">
      <header className="sticky top-0 z-40 flex flex-col gap-3 border-b bg-card/80 backdrop-blur px-4 py-3 md:px-6 md:py-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-6" />
            <div>
              <h1 className="text-base md:text-lg font-semibold leading-tight tracking-tight flex items-center gap-2">
                <ShieldCheck className="h-4 w-4" />
                Spray Plan Access
              </h1>
              <p className="text-[0.7rem] uppercase tracking-wide text-muted-foreground font-medium">
                Assign Spray Plan Creators to farms
              </p>
            </div>
          </div>
          {farms && (
            <div className="text-xs text-muted-foreground tabular-nums">
              {farms.length} farms · {totalCreators} creators
            </div>
          )}
        </div>
      </header>

      <section className="px-4 md:px-6 py-4">
        {loading && (
          <Card>
            <CardContent className="py-8 flex items-center justify-center text-sm text-muted-foreground gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading farms…
            </CardContent>
          </Card>
        )}

        {!loading && error?.status === 403 && (
          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base text-destructive">
                <ShieldAlert className="h-4 w-4" />
                Access denied
              </CardTitle>
              <CardDescription>
                This page is restricted to General Manager and System Manager.
                Ask an administrator if you believe this is incorrect.
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {!loading && error && error.status !== 403 && (
          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base text-destructive">
                <ShieldAlert className="h-4 w-4" />
                Failed to load
              </CardTitle>
              <CardDescription>{error.message}</CardDescription>
            </CardHeader>
          </Card>
        )}

        {!loading && !error && farms && farms.length === 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">No farms configured</CardTitle>
              <CardDescription>
                Create at least one Farm in Frappe Desk to start assigning
                Spray Plan Creators here.
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {!loading && !error && farms && farms.length > 0 && (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-1/4">Farm</TableHead>
                    <TableHead className="w-1/6">Business Unit</TableHead>
                    <TableHead>Spray Plan Creators</TableHead>
                    <TableHead className="w-32 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {farms.map((f) => (
                    <TableRow key={f.farm}>
                      <TableCell className="font-medium">{f.farm}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {f.business_unit || "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {f.creators.length
                          ? f.creators.map((c) => c.full_name || c.user).join(" · ")
                          : "(none yet)"}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        Task 3 wires this up
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Build verification**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend
npm run build 2>&1 | tail -10
```

Expected: builds cleanly.

- [ ] **Step 4: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add frontend/src/lib/spray-plan-admin-api.ts \
        frontend/src/pages/SprayPlanAccess.tsx
git commit -m "$(cat <<'EOF'
feat(spray-plan-admin): fetch farms + render read-only roster table

Adds the API helper module (listFarmsWithCreators, listCreatorCandidates,
setFarmCreators) and replaces the skeleton page with a data-loaded table:
one row per Farm with the current creator roster shown as a joined string.
403 surfaces as an Access-Denied card; other errors as a Failed-to-Load
card. Chip-picker editing lands in Task 3.
EOF
)"
```

---

## Task 3 — Creator chip-picker + per-row save flow

**Files:**
- Modify: `frontend/src/pages/SprayPlanAccess.tsx`
- Create: `frontend/src/components/spray-plan-access/CreatorChipPicker.tsx`

### Steps

- [ ] **Step 1: Create the chip picker component**

```bash
mkdir -p frontend/src/components/spray-plan-access
```

`frontend/src/components/spray-plan-access/CreatorChipPicker.tsx`:

```tsx
/**
 * Inline multi-user chip picker for the Spray Plan Access admin page.
 *
 * Props:
 *  - value: the currently assigned creator users (display + remove)
 *  - onChange: parent-supplied callback; emits the *full* next list
 *  - disabled: locks the picker (e.g. while saving)
 *
 * The Add input opens a server-side typeahead that filters Frappe Users
 * by name/email AND restricts to users who hold the "Spray Plan Creator"
 * role (the backend SQL is in admin.list_spray_plan_creator_candidates).
 */

import { useEffect, useRef, useState } from "react";
import { Plus, X, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  listCreatorCandidates,
  type CreatorCandidate,
  type FarmCreatorRow,
} from "@/lib/spray-plan-admin-api";

interface Props {
  value: FarmCreatorRow[];
  onChange: (next: FarmCreatorRow[]) => void;
  disabled?: boolean;
}

export function CreatorChipPicker({ value, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CreatorCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSearching(true);
    debounceRef.current = setTimeout(() => {
      listCreatorCandidates(query)
        .then((rows) => {
          setResults(
            rows.filter((r) => !value.find((v) => v.user === r.user)),
          );
        })
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open, value]);

  const add = (c: CreatorCandidate) => {
    onChange([
      ...value,
      { user: c.user, full_name: c.full_name || c.user },
    ]);
    setQuery("");
    setOpen(false);
  };

  const remove = (user: string) => {
    onChange(value.filter((v) => v.user !== user));
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((v) => (
        <span
          key={v.user}
          className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[0.7rem] font-medium"
        >
          {v.full_name || v.user}
          {!disabled && (
            <button
              type="button"
              onClick={() => remove(v.user)}
              className="text-muted-foreground hover:text-destructive"
              aria-label={`Remove ${v.full_name || v.user}`}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <div className="relative">
          {open ? (
            <div className="flex items-center gap-1">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="search users…"
                autoFocus
                onBlur={() => {
                  // Defer so click-on-result registers before the menu closes
                  setTimeout(() => setOpen(false), 150);
                }}
                className="h-7 text-xs w-40"
              />
              {searching && <Loader2 className="h-3 w-3 animate-spin" />}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="inline-flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-[0.7rem] text-muted-foreground hover:bg-muted/50"
            >
              <Plus className="h-3 w-3" />
              Add
            </button>
          )}
          {open && results.length > 0 && (
            <div
              className="absolute top-8 left-0 z-50 min-w-56 max-h-60 overflow-auto rounded-md border bg-popover shadow-md"
              onMouseDown={(e) => e.preventDefault()} /* keep input focused so blur fires after click */
            >
              {results.map((r) => (
                <button
                  type="button"
                  key={r.user}
                  onClick={() => add(r)}
                  className="block w-full text-left px-3 py-1.5 text-xs hover:bg-muted"
                >
                  <div className="font-medium">{r.full_name || r.user}</div>
                  <div className="text-[0.65rem] text-muted-foreground">
                    {r.email || r.user}
                  </div>
                </button>
              ))}
            </div>
          )}
          {open && !searching && results.length === 0 && query && (
            <div className="absolute top-8 left-0 z-50 min-w-56 rounded-md border bg-popover px-3 py-2 text-xs text-muted-foreground shadow-md">
              No matching users with the Spray Plan Creator role.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire dirty-state + save into the page**

Replace `frontend/src/pages/SprayPlanAccess.tsx` with the full editable version. The diff from Task 2 is large enough that pasting the whole file is clearer than partial edits:

```tsx
import { useEffect, useMemo, useState } from "react";
import { Loader2, ShieldCheck, ShieldAlert, RotateCcw, Check } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CreatorChipPicker } from "@/components/spray-plan-access/CreatorChipPicker";
import {
  listFarmsWithCreators,
  setFarmCreators,
  type FarmCreatorRow,
  type FarmWithCreators,
} from "@/lib/spray-plan-admin-api";
import { FrappeError } from "@/lib/frappe";

interface RowState {
  farm: string;
  business_unit: string;
  saved: FarmCreatorRow[];        // last server-acknowledged roster
  draft: FarmCreatorRow[];        // current in-memory edit
  saving: boolean;
  error: string | null;
}

function rosterEqual(a: FarmCreatorRow[], b: FarmCreatorRow[]): boolean {
  if (a.length !== b.length) return false;
  const aUsers = a.map((x) => x.user).sort();
  const bUsers = b.map((x) => x.user).sort();
  return aUsers.every((u, i) => u === bUsers[i]);
}

export function SprayPlanAccess() {
  const [rows, setRows] = useState<RowState[] | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listFarmsWithCreators()
      .then((farms) => {
        if (cancelled) return;
        setRows(
          farms.map((f) => ({
            farm: f.farm,
            business_unit: f.business_unit,
            saved: f.creators,
            draft: f.creators,
            saving: false,
            error: null,
          })),
        );
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof FrappeError) {
          setError({ status: e.status, message: e.message });
        } else {
          setError({ status: 0, message: String(e) });
        }
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const updateRow = (farm: string, patch: Partial<RowState>) =>
    setRows((prev) =>
      prev ? prev.map((r) => (r.farm === farm ? { ...r, ...patch } : r)) : prev,
    );

  const saveRow = async (farm: string) => {
    const row = rows?.find((r) => r.farm === farm);
    if (!row) return;
    updateRow(farm, { saving: true, error: null });
    try {
      const fresh = await setFarmCreators(
        farm,
        row.draft.map((d) => d.user),
      );
      updateRow(farm, {
        saved: fresh.creators,
        draft: fresh.creators,
        saving: false,
      });
    } catch (e) {
      const msg =
        e instanceof FrappeError ? e.message : String(e);
      updateRow(farm, { saving: false, error: msg });
    }
  };

  const revertRow = (farm: string) => {
    const row = rows?.find((r) => r.farm === farm);
    if (!row) return;
    updateRow(farm, { draft: row.saved, error: null });
  };

  const dirtyCount = useMemo(
    () =>
      (rows ?? []).filter((r) => !rosterEqual(r.saved, r.draft)).length,
    [rows],
  );
  const totalCreators = useMemo(
    () => (rows ?? []).reduce((s, r) => s + r.saved.length, 0),
    [rows],
  );

  const saveAll = async () => {
    const dirty = (rows ?? []).filter((r) => !rosterEqual(r.saved, r.draft));
    for (const r of dirty) await saveRow(r.farm);
  };

  return (
    <div className="flex flex-col min-h-svh">
      <header className="sticky top-0 z-40 flex flex-col gap-3 border-b bg-card/80 backdrop-blur px-4 py-3 md:px-6 md:py-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-6" />
            <div>
              <h1 className="text-base md:text-lg font-semibold leading-tight tracking-tight flex items-center gap-2">
                <ShieldCheck className="h-4 w-4" />
                Spray Plan Access
              </h1>
              <p className="text-[0.7rem] uppercase tracking-wide text-muted-foreground font-medium">
                Assign Spray Plan Creators to farms
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {rows && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {rows.length} farms · {totalCreators} creators
              </span>
            )}
            {dirtyCount > 0 && (
              <Button onClick={saveAll} size="sm" className="h-8">
                Save all ({dirtyCount})
              </Button>
            )}
          </div>
        </div>
      </header>

      <section className="px-4 md:px-6 py-4">
        {loading && (
          <Card>
            <CardContent className="py-8 flex items-center justify-center text-sm text-muted-foreground gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading farms…
            </CardContent>
          </Card>
        )}

        {!loading && error?.status === 403 && (
          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base text-destructive">
                <ShieldAlert className="h-4 w-4" />
                Access denied
              </CardTitle>
              <CardDescription>
                This page is restricted to General Manager and System Manager.
                Ask an administrator if you believe this is incorrect.
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {!loading && error && error.status !== 403 && (
          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base text-destructive">
                <ShieldAlert className="h-4 w-4" />
                Failed to load
              </CardTitle>
              <CardDescription>{error.message}</CardDescription>
            </CardHeader>
          </Card>
        )}

        {!loading && !error && rows && rows.length === 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">No farms configured</CardTitle>
              <CardDescription>
                Create at least one Farm in Frappe Desk to start assigning
                Spray Plan Creators here.
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {!loading && !error && rows && rows.length > 0 && (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-1/5">Farm</TableHead>
                    <TableHead className="w-1/6">Business Unit</TableHead>
                    <TableHead>Spray Plan Creators</TableHead>
                    <TableHead className="w-40 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const dirty = !rosterEqual(r.saved, r.draft);
                    return (
                      <TableRow key={r.farm} className={dirty ? "bg-amber-50/30" : ""}>
                        <TableCell className="font-medium">{r.farm}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {r.business_unit || "—"}
                        </TableCell>
                        <TableCell>
                          <CreatorChipPicker
                            value={r.draft}
                            onChange={(next) => updateRow(r.farm, { draft: next })}
                            disabled={r.saving}
                          />
                          {r.error && (
                            <div className="text-[0.65rem] text-destructive mt-1">
                              {r.error}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="inline-flex items-center gap-1">
                            {dirty && !r.saving && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  onClick={() => revertRow(r.farm)}
                                  title="Revert"
                                >
                                  <RotateCcw className="h-3 w-3" />
                                </Button>
                                <Button
                                  size="sm"
                                  className="h-7"
                                  onClick={() => saveRow(r.farm)}
                                >
                                  <Check className="h-3 w-3" />
                                  Save
                                </Button>
                              </>
                            )}
                            {r.saving && (
                              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                            )}
                            {!dirty && !r.saving && (
                              <span className="text-[0.65rem] text-muted-foreground">
                                Saved
                              </span>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Build verification**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend
npm run build 2>&1 | tail -10
```

Expected: builds cleanly. Bundle size for the Spray Plan Access chunk should be modest (< 20 kB gzipped) — flag if it's much larger.

- [ ] **Step 4: Manual flow test (if dev server is up)**

If a dev server is running:

1. Navigate to `/scp_app#/spray-plan-access` as a General Manager / System Manager.
2. Verify the farm list renders with the current rosters.
3. Click `+ Add` on one row, type a few characters → should show Spray-Plan-Creator-role candidates as a dropdown.
4. Pick one → it becomes a chip; row highlights amber; Save button appears.
5. Click `Save` → chip persists; amber goes away; "Saved" label appears.
6. Click `+ Add`, add another, change mind, click revert (`RotateCcw` icon) → goes back to saved state.
7. Add a non-creator user (you'd need to bypass the typeahead — try via console) → save should surface the role-required error from the server.
8. Log in as a non-GM user, navigate to the page → should see Access-Denied card.

Skip this step if no dev server is available; the build success is the minimum bar.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add frontend/src/components/spray-plan-access \
        frontend/src/pages/SprayPlanAccess.tsx
git commit -m "$(cat <<'EOF'
feat(spray-plan-admin): inline chip picker + per-row save + save-all flow

CreatorChipPicker component with debounced server-side typeahead against
list_spray_plan_creator_candidates. Per-row dirty tracking (amber row tint,
inline Save/Revert), header-level Save-all button, and error surfacing
inline beneath the chip picker. Saving is per-row optimistic; the response
from set_farm_creators becomes the new saved state.
EOF
)"
```

---

## Task 4 — Polish: explicit role-required server errors, focus states

**Files:**
- Modify: `frontend/src/components/spray-plan-access/CreatorChipPicker.tsx` (minor)
- Modify: `frontend/src/pages/SprayPlanAccess.tsx` (minor)

This task tightens edge cases discovered during Task 3 testing. Skip the steps that don't apply to your dev environment.

### Steps

- [ ] **Step 1: Improve the role-required error surfacing**

In `SprayPlanAccess.tsx`, the per-row `r.error` text currently uses the raw server message. Wrap it with a clearer prefix and an icon when the message mentions the role:

Find the existing block:

```tsx
{r.error && (
  <div className="text-[0.65rem] text-destructive mt-1">
    {r.error}
  </div>
)}
```

Replace with:

```tsx
{r.error && (
  <div className="text-[0.65rem] text-destructive mt-1 flex items-start gap-1">
    <ShieldAlert className="h-3 w-3 mt-[1px] flex-shrink-0" />
    <span>{r.error}</span>
  </div>
)}
```

- [ ] **Step 2: Add a keyboard hint to the typeahead empty state**

In `CreatorChipPicker.tsx`, the "no matching users" message is helpful but doesn't explain WHY. Update it (find the existing `No matching users with the Spray Plan Creator role.` text) to:

```tsx
No users found. Only enabled accounts with the
"Spray Plan Creator" role appear here. Add the role
in Frappe Desk first if you need to grant access.
```

- [ ] **Step 3: Build + commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend
npm run build 2>&1 | tail -8
```

If clean:

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add frontend/src/components/spray-plan-access/CreatorChipPicker.tsx \
        frontend/src/pages/SprayPlanAccess.tsx
git commit -m "$(cat <<'EOF'
feat(spray-plan-admin): clearer error surfacing + role-source hint

Per-row save errors now show a shield icon next to the message. The
typeahead's empty state explains the role prerequisite so administrators
know to grant the "Spray Plan Creator" role in Frappe Desk before the
user becomes pickable here.
EOF
)"
```

---

## Self-review

After all four tasks:

**Spec coverage** (§4 of [the design doc](../specs/2026-05-18-spray-plan-creator-workflow-design.md)):

- §4.1 route + role gate → Task 1 + 2 (gating surfaced on 403)
- §4.2 layout — table one row per Farm → Task 2 + 3
- §4.2 inline chip picker with typeahead → Task 3
- §4.2 per-row Save / Revert / amber dirty tint → Task 3
- §4.2 header banner with farm + creator counts → Task 2 + 3
- §4.3 backend endpoints — already shipped in A1, consumed by all three tasks
- §4.4 edge cases — empty farm list, 403, role-required error → Tasks 2 + 3 + 4
- §4.5 out-of-scope: role grant/revoke — confirmed not in this page

**Type consistency:**

- `FarmCreatorRow`, `FarmWithCreators`, `CreatorCandidate` consistent across `spray-plan-admin-api.ts` + the page + the picker.
- `setFarmCreators` returns a `FarmWithCreators` shape; we discard `farm_name`/`business_unit` from the response in `saveRow` because the displayed values came from the initial `listFarmsWithCreators` and don't change here.

**Placeholder scan:** none — every step has full code.

---

## Open follow-ups (deliberately out of scope, for future plans)

- Role grant/revoke from this same page. Future enhancement; not in spec.
- Bulk-copy a creator across multiple farms in one click. Future enhancement.
- Audit log view ("when was user X assigned to farm Y, by whom?"). Frappe already records this in `Version` history on the Farm doctype; no additional UI needed for A2.
