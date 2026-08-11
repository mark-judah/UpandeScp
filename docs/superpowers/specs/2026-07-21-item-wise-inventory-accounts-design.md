# Item-wise Inventory Accounts (streamlined spray GL) — Design

**Date:** 2026-07-21
**Status:** Draft for review
**Scope:** Make ERPNext post the spray stock GL from **item-group account
defaults** natively (the primary path), leaving the `SprayStockEntry.get_gl_entries`
override as the fallback. Achieved by setting `Item Group` inventory/expense
account defaults and enabling `Company.enable_item_wise_inventory_account` on the
companies that hold stock. Config/data on `kaitet.local` — no app-logic change.

## Why

Verified in ERPNext source (`stock_controller.py`): when
`Company.enable_item_wise_inventory_account` is on, the stock-in-hand GL leg is
resolved per **item → item-group → brand `default_inventory_account`** instead
of the warehouse account, and the Material-Issue debit uses the item/group
`expense_account`. This is warehouse-agnostic (solves multi-purpose warehouses)
and reconciles natively — the clean primary mechanism, with the override kept
as a fallback. Caveat confirmed: the toggle is **company-wide and strict** — any
stocked item whose item/group/brand has no `default_inventory_account` makes the
stock entry **throw**. So every item group that could hold stock must be mapped
first.

## Current state (kaitet.local)

- Toggle OFF on all 8 companies.
- Zero item-group / item `default_inventory_account` set anywhere.
- Only 3 companies hold stock: **Karen Roses (KR, 33 groups/960 items), Kaitet
  Ltd. (KL, 23/275), Westwood Dairies (WDL, 6/51)**. The other 5 have no stock
  (toggle harmless there → left OFF).
- Accounts (numbered CoA, per company `<abbr>`): `1010010105 - Chemicals and
  sprays - <abbr>` (exists KR, KL — not WDL, which has no chemicals),
  `50100301 - Chemicals Expense - <abbr>`, `Stock In Hand - <abbr>`.
- `Spray Plan Settings.default_chemical_expense_account` is blank.

## Decisions (confirmed)

- Issue-debit expense = `Chemicals Expense - <abbr>`.
- "The rest" default = the real `Stock In Hand - <abbr>` (no fabricated dummy;
  keeps non-chemical stock posting exactly as today, reconciles).
- Fertilizer = treated like chemicals (`Chemicals and sprays`).
- Delivery = idempotent script, applied on `kaitet.local` now, only the 3
  stocked companies. Promotable to a migrate patch for prod later (separate
  decision). Toggle left OFF on the 5 zero-stock companies.

## Mapping (per stocked company; `<abbr>` ∈ {KR, KL, WDL})

For each company, for **every leaf `Item Group` (is_group=0)** — not just
currently-stocked ones, so future stock can't throw — upsert an `Item Default`
row for that company:

| Item group | `default_inventory_account` | `expense_account` |
|---|---|---|
| `CHEMICALS`, `Fertilizer` | `Chemicals and sprays - <abbr>` (if the account exists for that company) | — |
| `Chemical Mix` | `Chemicals and sprays - <abbr>` (same as chemicals — mixing nets to zero) | `Chemicals Expense - <abbr>` |
| every other leaf group | `Stock In Hand - <abbr>` | — |

- If a company lacks the `Chemicals and sprays` account (WDL), its chemical
  groups (if any) fall back to `Stock In Hand` — WDL has no chemical groups, so
  moot.
- Account resolution is by name pattern per company (`… - <abbr>`); skip a
  mapping only if the target account genuinely doesn't exist (report it).
- Also set `Spray Plan Settings.default_chemical_expense_account =
  Chemicals Expense - KR` (KR is the SCP company) so the override fallback and
  the native expense agree.
- Then set `Company.enable_item_wise_inventory_account = 1` for KR, KL, WDL.

## Idempotency

Re-running updates existing `Item Default` rows in place (match on company),
never duplicates; the toggle set is a no-op if already 1. Delivered as
`patches/v1_0/setup_item_wise_inventory_accounts.py` with an idempotent
`execute()`, **run manually via bench execute on kaitet.local** and **NOT added
to `patches.txt`** yet (so no other site auto-runs it). Promote later by adding
the line to `patches.txt`.

## Resulting GL (native, override becomes fallback)

- **Chemical Mixing (Manufacture):** raw `CHEMICALS` consumed + `Chemical Mix`
  produced, both on `Chemicals and sprays` → nets to ~zero (value stays in the
  system, no P&L) — matches "not moving stock, moving within the system."
- **Chemical Spray (Material Issue):** `Chemical Mix` consumed → Cr `Chemicals
  and sprays`, Dr `Chemicals Expense` — the chemical is expensed on issue.
- Non-chemical stock unaffected (posts to `Stock In Hand`, as before).

## Verification

- After setup, re-run the blast-radius check: **0** stocked items would throw
  for KR/KL/WDL (every leaf group has a `default_inventory_account`).
- Live smoke on kaitet.local (toggle ON): post a Chemical Mixing SE (confirm
  Cr/Dr `Chemicals and sprays`, nets ~0, balanced) + a Chemical Spray SE
  (confirm Cr `Chemicals and sprays`, Dr `Chemicals Expense`, balanced) + one
  ordinary non-chemical Material Issue (confirm posts to `Stock In Hand`, no
  throw). Cancel the test SEs.
- Confirm the `SprayStockEntry` override still runs harmlessly (it remaps to the
  configured Settings accounts if set; blank → it leaves the item-group-derived
  accounts) — no double-remap conflict.

## Risks

- **Company-wide toggle:** every future item group that holds stock in KR/KL/WDL
  must have a default (we map all current leaf groups; NEW groups need mapping —
  note for operators).
- **Override interaction:** with the toggle on, ERPNext already posts the right
  accounts; the `get_gl_entries` override (Settings fields blank) is inert. If a
  GM later fills the Settings override fields, the override re-labels on top of
  the item-group accounts — acceptable (fallback/override precedence), but
  document it so the two mechanisms aren't fought against each other.

## Out of scope

- Prod/mona rollout (promote the patch separately).
- Changing the override code (kept as fallback).
- The 5 zero-stock companies.
