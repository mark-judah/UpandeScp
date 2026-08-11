# Spray-plan stock accounting + named Stock Entry Types + Settings flowchart — Design

**Date:** 2026-07-21
**Status:** Draft for review (build on a feature branch; hard-override is a trial)
**Scope:** (1) Give the spray flow's three stock movements their own Stock Entry
Type *names* while keeping ERPNext `purpose` unchanged; (2) let Spray Plan
Settings hard-override the debit/credit accounts for the stock steps, with the
warehouse account as fallback; (3) add a static flowchart to Spray Plan
Settings visualising the flow + accounts.

## Context / why

The spray lifecycle posts three stock entries — Material Transfer for
Manufacture (store→CSU), Manufacture (tank mix), Material Issue (spray). All
downstream logic dispatches on `purpose`, never on the type name
(`stock_entry_state.py`, `store_keeper_api._SE_PURPOSE`), so the type label is
free to change. Perpetual inventory is ON, so each stock entry auto-posts GL
from the warehouse stock accounts. Because several warehouses are used for more
than one purpose, the client wants per-step account control that does **not**
depend on a warehouse being single-purpose — hence a hard-override, with the
warehouse account only as a fallback.

## Part 1 — Named Stock Entry Types

Create three non-standard `Stock Entry Type` records (idempotent, via a migrate
patch — not shipped as reference-data fixtures, matching this app's convention):

| Type name (PLACEHOLDER — rename at review) | purpose (unchanged) | Stage |
|---|---|---|
| **CSU Chemical Transfer** | Material Transfer for Manufacture | store → CSU |
| **Chemical Mixing** | Manufacture | tank mix |
| **Chemical Spray** | Material Issue | application |
| **Chemical Loaning** | Material Transfer | loaning (`loaning.py`) |

> **Names are placeholders.** The client wanted to adjust the wording; final
> names to be confirmed at spec review and swapped in one place (the patch +
> the constants below).

Flow code updated to set `stock_entry_type` to these names (the transfer-SE
creation site, `spray_session` manufacture build ~line 746,
`auto_material_issue.build_material_issue`). `purpose` continues to be set to
the standard value (fetched from the type / set explicitly) so every
`purpose`-based branch keeps working unchanged. The farm-to-farm loaning SE
(`loaning.py`, plain "Material Transfer") is left as-is (optionally renamable).

## Part 2 — Hard-override of stock-step accounts (the trial)

### The three configurable accounts (Spray Plan Settings → new "Stock Accounting" section)

| Field | Role | Fallback when blank |
|---|---|---|
| `spray_raw_chemical_account` | **Credited** on Chemical Mixing (raw chemicals leaving the store) | source warehouse stock account |
| `spray_tank_mix_account` | **Debited** on Mixing (tank mix produced, incl. valuation difference) and **Credited** on Chemical Spray (tank mix consumed) — the shared "middle" account | CSU/WIP warehouse stock account |
| `spray_expense_account` | **Debited** on Chemical Spray (cost hits P&L) | `default_chemical_expense_account` (existing), then item expense account |

**The CSU Chemical Transfer step is NOT account-overridden.** A
warehouse-to-warehouse Material Transfer moves stock value between two stock
accounts (no P&L), so it has no config fields and posts normally. The override
subclass acts ONLY on Manufacture + Material Issue spray SEs (see
`_is_spray_stock_se`).

The Manufacture **difference/valuation** is folded into `spray_tank_mix_account`
(no separate difference field) — i.e. the Mixing SE's difference account is set
to the tank-mix account so any valuation gap lands there too. Existing
`default_chemical_expense_account` / `default_chemical_difference_account`
remain as lower-priority fallbacks.

### Mechanism

`upande_scp` claims `override_doctype_class["Stock Entry"]` (currently unclaimed
by any app; scp's block is commented out — enable it) with a subclass:

```
class SprayStockEntry(StockEntry):
    def get_gl_entries(self, warehouse_account=None):
        gl = super().get_gl_entries(warehouse_account)
        if not _is_spray_stock_se(self):   # AFP work order + our type/purpose
            return gl
        return _remap_spray_accounts(self, gl)   # substitute configured accounts
```

`_remap_spray_accounts` rewrites the stock-in-hand account on each GL row to the
configured Settings account per the table above (leaving the value/qty
untouched), falling back to the warehouse account when a Settings field is
blank. Non-spray Stock Entries are untouched (delegate to `super()`), so the
override is inert for the rest of ERPNext. `doc_events` from scp/upande_ta
(validate/on_submit/before_validate) are unaffected — different mechanism.

### The accepted risk (documented, and the branch go/no-go)

Double-entry still balances, but ERPNext's **Stock↔GL reconciliation report**
maps each warehouse to *its* configured account; posting stock value to a
different account makes that report show the warehouse account short and the
override account with an unexplained balance. The client accepts this because
the multi-purpose warehouses already break the one-warehouse-one-account model.
The branch's verification (below) is the go/no-go: if the override posts the
intended accounts and the P&L/stock totals are correct, keep it; else fall back
to the warehouse-account approach.

## Part 3 — Static flowchart in Spray Plan Settings

An `HTML` custom field (read-only) in a "Flow" section of Spray Plan Settings,
rendering a hand-built inline SVG/HTML diagram: the 7 lifecycle stages, and for
the 3 stock steps, the debit/credit accounts (resolved: configured value or
"(warehouse)" fallback). Static markup — no external JS libs, renders reliably
in Desk. Regenerated by the same code path that knows the account config so it
stays accurate.

## Delivery

- **Feature branch** off `kaitet` (e.g. `scp-spray-stock-accounting`) — do NOT
  build on `kaitet` directly; this is a trial.
- Migrate patch: create the 3 Stock Entry Types (idempotent).
- Spray Plan Settings doctype: new "Stock Accounting" section (3 account Link
  fields) + "Flow" section (HTML field); settings load/save updated.
- `hooks.py`: enable `override_doctype_class["Stock Entry"] = SprayStockEntry`.
- New module (e.g. `serverscripts/store/spray_stock_entry.py`) with the
  subclass + `_is_spray_stock_se` + `_remap_spray_accounts` + account resolvers.
- Flow code: set the new `stock_entry_type` names on the three SEs.

## Verification (branch go/no-go)

1. On the branch site: run a full plan cycle — approve → CSU Chemical Transfer
   (biometric submit) → Chemical Mixing (CSU scans) → Chemical Spray (end
   session).
2. For each SE, inspect its **GL Entries**: confirm the debit/credit accounts
   match the configured Settings accounts (and fall back to warehouse accounts
   when a field is blank).
3. Confirm double-entry balances (sum debits == credits per SE) and the spray
   cost lands in `spray_expense_account`.
4. Note the Stock↔GL reconciliation-report divergence explicitly (expected).
5. Type-name change is transparent: `stock_entry_state` transitions, store-keeper
   listing, and lifecycle timeline all still work (they key on `purpose`).

## Out of scope

- Changing `purpose` values or any purpose-based dispatch.
- Reworking warehouse↔account mappings globally.
- The loaning SE accounting (unless we also rename its type).

## Resolved decisions

- Loaning SE type IS renamed (4th type above).
- CSU Chemical Transfer step has NO accounting override (transfers don't hit
  P&L) — override applies to Mixing + Spray only.
- Difference folded into the tank-mix account (no separate difference field).

## Open items for review

- **Final Stock Entry Type names** — all four are placeholders; rename at will
  (one-place change: the patch + the type-name constants). Proceeding with
  placeholders unless you say otherwise.
