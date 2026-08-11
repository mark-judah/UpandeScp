# Chemical Loaning Overhaul — Design

**Date:** 2026-07-21
**Status:** Draft for review
**Scope:** Remove the depletion-value limit on chemical loaning, let a request
cover several chemicals at once, and give the borrowing farm a read-only
"Creditors" view of what it received and from whom. Multi-lender per chemical
already works and is kept.

## Context

Chemical loaning (farm-to-farm internal chemical transfer) is a React page
(`frontend/src/pages/ChemicalLoaning.tsx` + `frontend/src/lib/loaning-api.ts`)
backed by `serverscripts/spray_plan_creator/loaning.py` and the
`Chemical Transfer Request` doctype (parent: one `item_code` + `requested_qty`;
child `sources` = the lending farms + split). Today loaning is gated by a
depletion threshold `Spray Plan Settings.loaning_depletion_pct` (default 15%):
a farm must be "depleted" to request, and a lender may only lend down to its
own 15%-of-baseline floor.

## Decisions (confirmed)

1. **No value limit.** Drop the depletion floor entirely; a lender's qty is
   capped only at its actual on-hand (cannot lend more than it has). Keep the
   `loaning_enabled` toggle, request expiry/timeout, "can't lend to self," and
   "sources must sum to the requested qty."
2. **Creditors = visibility only** (matches the existing "attributed transfer,
   not a repayable loan" model — no repayment flow).
3. **Several chemicals at once = batch** (one form → N requests; no doctype
   restructure).
4. Multi-lender already works; lift the frontend's hard 2-lender cap.

## Components

### 1. Backend — drop the depletion floor (`loaning.py`)

- `create_request`: remove the "your farm is not depleted — no request needed"
  guard and the `_lendable` floor check. Keep: `loaning_enabled`, farm access,
  `item_code` + positive `requested_qty`, 1..MAX_SOURCES, each source has a
  farm + positive qty, source farm ≠ requesting farm, **each source qty ≤ that
  farm's on-hand** (`_on_hand`), sources sum to `requested_qty`, expiry stamp.
- `get_loanable_chemicals(farm)`: return **all** chemicals in the chemical item
  groups with the farm's current on-hand (no low-stock/depletion filter). The
  Request tab becomes "pick any chemical," not "pick a depleted one."
- `get_sources_for(farm, item_code)`: list every *other* farm with on-hand > 0
  for that item; `lendable = on_hand` (no floor). Drop the "above the depletion
  threshold" message.
- Simplify/retire the floor helpers: `_lendable` returns full on-hand;
  `_is_depleted` no longer gates requests (keep only if still used for display,
  else remove). `loaning_depletion_pct` field stays in Settings but is no
  longer referenced by loaning logic.
- `MAX_SOURCES`: raise (e.g. to 5) so more lenders can split one chemical.

### 2. Backend — batch multi-chemical (`loaning.py`)

- New `@frappe.whitelist() create_requests(payload)`: `payload = {requesting_farm,
  reason, items: [{item_code, uom, requested_qty, sources: [{source_farm, qty}]}]}`.
  Validates farm access once, then for each item runs the same per-request
  validation + creation as `create_request` (refactor the single-request body
  into a shared `_create_one(farm, reason, item)` helper so both endpoints share
  it). Creates one `Chemical Transfer Request` per item; notifies each source's
  creators. Returns `{names: [...], failed: [{item_code, error}]}` — one bad
  chemical doesn't abort the others. `create_request` (single) stays for
  backward compat, delegating to `_create_one`.

### 3. Backend — Creditors visibility (`loaning.py`)

- New `@frappe.whitelist() get_creditors(farm)`: `_assert_farm_access(farm)`,
  then aggregate the farm's **approved** request sources — for requests where
  `requesting_farm == farm`, sum approved `sources.qty` grouped by
  `(source_farm, item_code)` → `[{creditor_farm, item_code, item_name, uom,
  qty}]`. Read-only. (Uses the approved child rows; the "debited" borrowing
  farm sees who lent it what.)

### 4. Frontend (`ChemicalLoaning.tsx`, `loaning-api.ts`)

- **Request tab → multi-chemical cart:** pick a chemical, choose its lender
  split (now up to MAX_SOURCES, not 2), "Add to request"; repeat for more
  chemicals; a cart lists the chosen chemicals + their splits; one **Submit**
  calls `createRequests` with the items array. Show per-chemical success/failure
  from the response.
- **Creditors tab/section:** calls `getCreditors(farm)`, renders a read-only
  table "Received *qty uom* of *chemical* from *lending farm*."
- `loaning-api.ts`: add `createRequests(payload)` + `getCreditors(farm)` and the
  types; keep `createRequest` if still referenced.
- Remove the client "max 2 sources" guard; drive the cap from MAX_SOURCES.

## Testing

- Backend pure-helper unit tests (`serverscripts/tests/`): the source-split
  validation (sum == requested_qty within tolerance; each qty ≤ on-hand; self-
  loan rejected; empty/invalid source rejected). Extract the per-item validation
  into a pure function so it's unit-testable without the DB.
- Frontend: `yarn build` clean; existing Vitest green; (component test for the
  cart if feasible).
- Manual smoke on `kaitet.local`: request two chemicals in one submit (each from
  ≥1 lender), approve sources, confirm two requests created and the Creditors
  tab shows the received amounts.

## Out of scope

- Repayable/settle-able loan balances (visibility only).
- The `Chemical Transfer Request` doctype structure (unchanged — batch = N
  single-chemical requests).
- The interactive flow diagram (separate, next effort).
- Any change to the loaning Stock Entry accounting (the "Chemical Loaning" type
  rename already shipped).

## Open items for review

- MAX_SOURCES target (proposed 5).
- Whether to keep `create_request` (single) or fully replace with `create_requests`.
