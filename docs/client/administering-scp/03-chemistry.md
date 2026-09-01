---
title: Chemistry
route: scp/admin/chemistry
order: 4
---

# Chemistry

**Sidebar → Chemistry.**

## Where a chemical's properties live

This is the single most important thing to know in this chapter, and the sidebar
does not tell you.

The sidebar's **Chemicals** entry opens the `Item` list. But a chemical's
agronomic properties are **not on the Item** — they live on a separate
**`Chemical`** record, one per Item, named after the Item.

The properties used to be custom fields on Item and were moved off deliberately.
Looking for `custom_toxicity` on an Item will find nothing.

### The Chemical record

| Field | Purpose |
|---|---|
| `item` | The Item this describes. It is the record's name |
| `chemical_name` | |
| `type` | Insecticide, Fungicide, Adjuvant, pH and so on |
| `active_ingredients` | An **Active Ingredient** child table |
| `toxicity` | I / II / III / IV |
| `reentry_interval_hrs` | How long before people may re-enter |
| `phi_days` | Pre-harvest interval |
| `formulation`, `registration_no`, `mrl` | Regulatory detail |
| `irac`, `irac_moa` | IRAC codes and mode of action |
| `frac`, `frac_moa` | FRAC codes and mode of action |
| `ghs`, `ghs_description` | Hazard classification |
| `low_stock_threshold` | Per-chemical, drives the Chemical Dashboard warning |
| `default_lower_rate_limit`, `default_upper_rate_limit` | The rate guard on spray plans |

### Foliar is the parallel record

**`Foliar`** is the same shape for foliar feeds — same 1:1-with-Item pattern,
same fields. It was previously called Fertilizer.

Both are created automatically when an Item lands in the relevant crop-protection
item group, so you do not normally create them by hand. The item groups that
trigger this are configured in **Scouting and Crop Protection Settings →
Chemicals**.

### The two fields that bite

**`default_lower_rate_limit` / `default_upper_rate_limit`** are what refuse an
out-of-range rate when a spray plan is built. Set them wrong and either a plan
that should pass is refused, or a mistyped decimal goes through.

**`low_stock_threshold`** is per chemical, so a product measured in litres and
one measured in grams can both warn sensibly. There is no global default worth
relying on.

### Per-crop overrides

`Chemical Crop Profile` and `Foliar Crop Profile` hold per-crop overrides, so a
product used differently on roses and avocado does not need two Items.

## Resistance codes

Three code masters, each a simple list:

| DocType | Field of note |
|---|---|
| `FRAC Code` | `risk_level` (Low … High), `mode_of_action`, `notes` |
| `IRAC Code` | Same shape, for insecticide resistance |
| `GHS Code` | Hazard classification |

A chemical links to as many of each as apply, through multi-select tables.

These are what drive the **resistance warnings** an approver sees: when the same
IRAC or FRAC mode of action has been used on the same greenhouse inside the
rotation window, the approval page says so.

The windows are set in **Scouting and Crop Protection Settings → Spray Plan**:

| Setting | Typical |
|---|---|
| `irac_rotation_window_days` | 14 |
| `frac_rotation_window_days` | 21 |

**They warn; they do not block.** Repeating a mode of action is sometimes right.
Doing it unknowingly is not.

## Guidelines

`FRAC Guideline` and `IRAC Guideline` are rules expressed as data rather than
code:

| Field | Purpose |
|---|---|
| `guideline_name` | The record name |
| `category` | Rotation Rules, Application Limits, and so on |
| `description` | What the rule is, in words |
| `enabled` | Turn a rule off without deleting it |
| `parameter_coding`, `parameters` | The rule's parameters, as code |
| `frac_code_filter` | Which codes it applies to |
| `error_message` | What the user is told when it trips |

Because the parameters are data, a guideline can be adjusted without a
deployment. Because they are *code*, get them wrong and the rule misfires —
change one, then test it against a real plan before trusting it.
