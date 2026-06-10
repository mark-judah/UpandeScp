# Farm-to-Farm Chemical Loaning — Design

**Date:** 2026-06-10
**Status:** Approved decisions captured; spec for review before implementation
**Origin:** Decisions locked with james@upande.com on 2026-05-25; data-model and
UI gaps settled 2026-06-10.

## Problem

A farm sometimes runs low on a chemical that a sibling farm has in surplus.
Today there is no way for the low farm to discover that surplus or to pull stock
across without an ad-hoc, untracked manual transfer. We want a privacy-preserving,
auditable way for one farm to request a chemical from another and, on approval,
move the stock with a proper Stock Entry.

This is **not** a repayable loan — it is an *attributed internal transfer* with an
audit trail and valuation movement. We deliberately do not model repayment
obligations in v1.

## Goals

- A Spray Plan Creator on a depleted farm can see which other farms hold the
  chemical they are short on, and request some of it.
- The source farm's Spray Plan Creator approves (or rejects); approval generates
  a Material Transfer Stock Entry that moves stock **and valuation** across the
  two farms' cost centers.
- Cross-farm quantities stay hidden until the requester is genuinely depleted —
  a farm never sees another farm's full inventory, only the one chemical it is
  short on.
- Requests that sit unanswered auto-close after 72 hours.

## Non-goals (v1)

- No repayment ledger / receivable between farms (attributed transfer only).
- No GM approval step (single approval by the source farm's creator).
- No distance- or partner-based ranking (biggest-available-stock only).
- No multi-chemical basket in one request (one chemical per request).

## Locked decisions (2026-05-25)

- **Semantics:** simple attributed transfer, audit trail + financial checks; no
  repayment modelling.
- **"Most suitable farm" ranking:** biggest available stock of the requested
  chemical first.
- **Visibility gate:** per-chemical depletion threshold; cross-farm quantities
  visible only once the requester drops below depletion.
- **Bulk-restock tool:** GM utility to reset baselines in one pass.
- **Approval:** single, by the source farm's Spray Plan Creator.
- **Partial fulfilment:** allowed, split across up to 2 source farms via a slider.
- **Timeout:** request auto-closes after 72 hours with no response.
- **Visibility scope:** receiver sees only the chemical they are low on, never the
  full inventory.

## Decisions settled 2026-06-10

- **Baseline model:** **auto-captured at restock.** The baseline for a
  (farm, chemical) is the on-hand quantity recorded the last time that chemical
  was received into the farm's chemical store. The depletion threshold is a
  **single global percentage** (Spray Plan Settings, default 15%).
- **UI placement:** a **new "Chemical Loaning" page** (dedicated route).
- **Financials:** the approved Material Transfer Stock Entry **moves stock +
  valuation** between the two farms' warehouses/cost centers. No payable or
  receivable is created.
- **Requester role:** only the depleted farm's **Spray Plan Creator** may raise a
  request (symmetric with the approver role).

## Architecture

```
  Restock (inbound receipt) ──hook──▶ capture baseline per (farm, chemical)
                                          │
                                          ▼
                              tabChemical Stock Baseline
                                          │
  Creator (low farm) ── Chemical Loaning page ──▶ availability (gated by depletion)
        │                                                     │
        │ raise request (1 chemical, up to 2 sources, split) │
        ▼                                                     ▼
  Chemical Transfer Request  ──notify──▶  source farm creator approves
   (Draft→Pending→Approved/Rejected/Expired)                 │
        │                                                     ▼
        └────────── on approve ──▶ Material Transfer Stock Entry (stock + valuation)
  daily/hourly job ──▶ expire requests older than 72h with no response
```

### Why this shape

The stock data already lives in `tabBin` (per warehouse, joined to
`Warehouse.custom_farm` for the farm and filtered to chemical item groups — the
same source `chemical_stock_overview` uses). We add only what is missing: a
captured **baseline** per (farm, chemical), a **request** document with a small
workflow, and the **page**. Approval reuses the existing Material-Transfer
machinery. Everything new lives under the established `spray_plan_creator/`
whitelisted-endpoint pattern.

## Component 1 — Data model

### DocType: `Chemical Transfer Request`

The request document. Workflow states: **Draft → Pending Approval → Approved →
Fulfilled / Rejected / Expired**.

| Field | Type | Notes |
|---|---|---|
| `requesting_farm` | Link Farm | the depleted farm (receiver) |
| `item_code` | Link Item | the single chemical requested |
| `item_name` | Data (fetch) | display |
| `uom` | Data (fetch) | stock UoM |
| `requested_qty` | Float | total qty wanted |
| `requesting_warehouse` | Link Warehouse | receiver's chemical store (target of the SE) |
| `sources` | Table (child) | up to 2 rows — see below |
| `workflow_state` | Select | Draft / Pending Approval / Approved / Fulfilled / Rejected / Expired |
| `reason` | Small Text | optional note from requester |
| `expires_on` | Datetime | set to creation + 72h when submitted |
| `stock_entry` | Link Stock Entry | the generated Material Transfer, set on approval |
| `rejected_reason` | Small Text | optional, on reject |

Child table **`Chemical Transfer Request Source`**:

| Field | Type | Notes |
|---|---|---|
| `source_farm` | Link Farm | lending farm |
| `source_warehouse` | Link Warehouse | lending farm's chemical store |
| `qty` | Float | qty from this source (the split) |
| `approved` | Check | source-side approval flag |
| `approved_by` | Data | approver full name |
| `approved_on` | Datetime | |

When the request splits across 2 farms it carries 2 source rows; each source
farm's creator approves their own row. The request becomes **Approved** only when
all source rows are approved (and generates one SE per source — or one SE per
approved source row; see Component 4). A source farm rejecting its row marks the
request **Rejected** with the reason.

### DocType: `Chemical Stock Baseline`

One row per (farm, chemical). The depletion reference.

| Field | Type | Notes |
|---|---|---|
| `farm` | Link Farm | |
| `item_code` | Link Item | chemical |
| `baseline_qty` | Float | on-hand captured at last restock |
| `captured_on` | Datetime | when the baseline was last set |
| `captured_via` | Select | `restock` / `bulk_restock` / `manual` |

Unique on (`farm`, `item_code`). This is a normal (non-single) doctype.

### Spray Plan Settings (new fields)

- `loaning_enabled` (Check) — master on/off for the feature.
- `loaning_depletion_pct` (Int, default 15) — global depletion threshold %.
- `loaning_timeout_hours` (Int, default 72) — request auto-close window.

## Component 2 — Baseline capture & depletion logic

### Auto-capture at restock (hook)

Extend the existing `Stock Entry.on_submit` dispatcher (and add a
`Purchase Receipt.on_submit` hook) so that when chemical stock is **received into
a farm's chemical store** (a Material Receipt / Purchase Receipt whose target
warehouse maps to a farm via `Warehouse.custom_farm`, for an item in the chemical
item groups), we upsert `Chemical Stock Baseline` for that (farm, item_code) with
`baseline_qty` = the **post-receipt on-hand** for that (farm, item) and
`captured_via = "restock"`. One baseline per (farm, chemical); the latest restock
wins.

### Depletion test

A (farm, chemical) is **depleted** when:

```
current_on_hand < (loaning_depletion_pct / 100) * baseline_qty
```

`current_on_hand` = Σ `Bin.actual_qty` over warehouses where
`Warehouse.custom_farm = farm` for that `item_code`. If no baseline exists, the
chemical is treated as **not** depletion-eligible (we cannot judge depletion
without a reference) — surfaced in the UI as "no baseline yet".

### Lendable quantity (source side)

To stop a lender draining itself into shortage, a source farm's **lendable**
quantity for a chemical is its on-hand above its own depletion floor:

```
lendable = max(0, source_on_hand - (loaning_depletion_pct/100) * source_baseline)
```

Ranking across candidate source farms is by **lendable desc** (biggest available
first). Farms with `lendable <= 0` are not offered.

## Component 3 — Endpoints (`spray_plan_creator/loaning.py`)

All whitelisted, gated to Spray Plan Creator / GM / System Manager. The
requesting endpoints additionally enforce that the caller is acting for a farm
they create plans for (reuse the farm-scope helpers from `spray_plan_approval`).

- `get_loanable_chemicals(farm)` — chemicals on `farm` that are **depleted**
  (the only ones whose cross-farm availability the requester may see). Returns
  `{item_code, item_name, uom, on_hand, baseline_qty, depleted: true}`.
- `get_sources_for(farm, item_code)` — candidate source farms for one depleted
  chemical, ranked by lendable desc: `[{source_farm, source_warehouse,
  lendable, on_hand}]`. Throws if the requesting farm is **not** depleted in that
  chemical (enforces the visibility gate server-side, not just in the UI).
- `create_request(payload)` — create + submit a `Chemical Transfer Request`
  (validates ≤2 sources, split sums to `requested_qty`, each split ≤ that
  source's lendable, requester is depleted). Stamps `expires_on`. Notifies each
  source farm's creator.
- `list_requests(role, farm, states)` — inbox: requests I raised (receiver view)
  or awaiting my approval (source view).
- `approve_source(request, source_farm)` — source-side approval of one row; when
  all rows approved, transition to **Approved** and generate the SE(s)
  (Component 4). Notifies the requester.
- `reject_request(request, reason)` — source rejects; request → **Rejected**;
  notify requester.
- `bulk_restock(payload)` — GM utility: set every (farm, chemical) baseline to
  the current on-hand (`captured_via = "bulk_restock"`) in one pass, optionally
  scoped to one farm. This is the "everyone restocked to 100%" tool.

## Component 4 — Approval → Material Transfer Stock Entry

On full approval, for each approved source row, generate and submit a **Material
Transfer** Stock Entry:

- `from_warehouse` = `source_warehouse`, `to_warehouse` = `requesting_warehouse`.
- One line: `item_code`, `qty` = source row qty, stock UoM.
- **Valuation moves with the stock** across the farms' cost centers — set the
  source/target warehouses' cost centers on the entry so the lending farm is
  credited and the receiving farm debited (no payable/receivable raised).
- Link the SE back on the request (`stock_entry`), add a workflow comment, and
  set the request **Fulfilled**.

Each source row's SE is independent so a 2-farm split produces two transfers.
A failure on one SE rolls back only that row's transition (per-row transaction),
leaving the rest intact; the request stays **Approved (partially fulfilled)**
until retried.

## Component 5 — Timeout job

`expire_dormant_requests()` added to `scheduler_events` (hourly — 72h precision
does not need finer). Any `Pending Approval` request with `expires_on < now`
transitions to **Expired** and notifies the requester. Honours
`loaning_enabled`; no-op when the feature is off.

## Component 6 — Frontend: new "Chemical Loaning" page

New route `chemical-loaning` (router `View` union + `KNOWN_VIEWS`, lazy import +
render branch in `App.tsx`, sidebar entry under Crop Protection, gated to Spray
Plan Creator / GM). `lib/loaning-api.ts` wraps the endpoints.

Page sections:

1. **My low chemicals** — `get_loanable_chemicals(myFarm)`: the depleted
   chemicals on the user's farm. Picking one reveals…
2. **Source picker** — `get_sources_for`: ranked source farms with lendable qty.
   The requester chooses up to 2 sources and uses a **split slider** to divide
   `requested_qty` between them (the locked partial-fulfilment behaviour).
3. **Raise request** — submits via `create_request`.
4. **Requests inbox** — two tabs: *Mine* (requests I raised, with state +
   timeline) and *To approve* (rows awaiting my farm's approval, with
   Approve / Reject). Realtime nudges via Frappe socketio so a source creator
   sees a new request without refreshing.

A GM-only **Bulk restock** action (button → confirm) calls `bulk_restock`.

## Permissions

- Raise / view "mine": the requesting farm's Spray Plan Creator (farm-scoped).
- Approve / reject: the source farm's Spray Plan Creator (farm-scoped).
- `bulk_restock` and baseline overrides: GM / System Manager.
- The visibility gate is enforced in `get_sources_for` (throws unless the
  requesting farm is depleted in that chemical), so the UI cannot leak another
  farm's inventory by calling the endpoint directly.

## Testing

**Backend:**
- Depletion test: on-hand just below / just above `pct * baseline`; missing
  baseline → not eligible.
- `get_sources_for` ranks by lendable desc, excludes `lendable <= 0`, and throws
  when the requester is not depleted.
- `create_request` validation: ≤2 sources, split sums to requested_qty, each
  split ≤ source lendable.
- `approve_source`: partial vs full approval; full approval generates the SE(s)
  with correct from/to warehouses + cost-center valuation and sets Fulfilled.
- `expire_dormant_requests`: expires at the 72h boundary, skips answered/closed.
- Baseline auto-capture on a chemical receipt into a farm chemical store; ignores
  non-chemical / non-farm receipts. `bulk_restock` sets all baselines.

**Frontend:**
- Low-chemicals list only shows depleted items; source picker split slider sums
  correctly; inbox tabs route Approve/Reject; realtime nudge updates the inbox.

## Files

**New**
- `upande_scp/.../doctype/chemical_transfer_request/` (+ child
  `chemical_transfer_request_source`)
- `upande_scp/.../doctype/chemical_stock_baseline/`
- `upande_scp/serverscripts/spray_plan_creator/loaning.py`
- `frontend/src/lib/loaning-api.ts`
- `frontend/src/pages/ChemicalLoaning.tsx`
- backend tests under `upande_scp/serverscripts/tests/`

**Modified**
- `upande_scp/hooks.py` (baseline-capture doc_events for Stock Entry / Purchase
  Receipt; hourly `expire_dormant_requests`)
- `upande_scp/.../doctype/spray_plan_settings/` (+ `loaning_enabled`,
  `loaning_depletion_pct`, `loaning_timeout_hours`) and the settings endpoints +
  Settings page
- `frontend/src/lib/router.ts`, `frontend/src/App.tsx`,
  `frontend/src/components/AppSidebar.tsx` (new route)

## Open considerations (flag, not blockers)

- **Lendable floor** (a source won't lend below its own depletion floor) is a
  design addition beyond the locked decisions — included because lending a farm
  into its own shortage would be perverse. Easy to drop if undesired.
- **Cost-center valuation** assumes each farm's chemical-store Warehouse has a
  cost center configured; if some don't, approval falls back to the company
  default and logs a warning.
