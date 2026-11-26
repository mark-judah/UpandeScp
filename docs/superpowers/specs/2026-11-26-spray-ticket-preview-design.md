# Spray ticket preview (MOLFM27 layout) on Spray Plan Transfers

Status: approach approved in conversation 2026-11-26 ("we are using our existing process to fill this form").
First site: mutara. Reference: github.com/0nserio/Upande-Production-Customizations (fertilizer-requisition-molfm27) —
used only for the paper layout and field list, nothing from it is installed.

## Why

Mutara's paper ticket (MOLFM27 Fertilizer Advice / Field/FSQM/2) is the record farm audits ask for. Our spray
process already captures nearly every line of it, spread over the plan, its block, the crop cycle, the
approval, the transfer, the supervisor's scan and the logsheet. Stores on Spray Plan Transfers need to see
those details before pushing chemicals to the mixing area, and the farm needs the full ticket printable once
the session is done.

## Goals

1. **Preview button per plan** on Spray Plan Transfers. Read-only. Opens a ticket card.
2. **The ticket is worked out, never stored.** One whitelisted call builds it from existing records; nothing is
   entered twice, and no Material Request is created.
3. **Progressive, with a percentage.** Each ticket line is filled or missing (with where it comes from / who
   fills it). A progress ring shows % complete; missing lines show as blanks like the paper form.
4. **Print unlocks at 100%.** A Work Order print format in the MOLFM27 layout (with the Field/FSQM/2 footer).
   Below 100% the Print button is disabled and says what is still missing.
5. **Method of application** becomes a field on the spray plan, prefilled from the kit (knapsack / boom → Spraying
   (foliar)), editable on the Application Floor Plan.

## Ticket lines (all count toward 100%)

Details: block, farm, location (Phase/Section above the block), area (ha), crop, variety, crop stage (live
Production Crop Cycle `current_stage`), application week (ISO week of the scheduled date), operator (spray team
supervisor + members), products with rate per unit (stock UOM per amount + UOM) and quantity, active
ingredients/composition, equipment (kit), method of application, water volume + dilution line.

Sign-offs: prepared by (plan owner, time), technical authorization (Approvals page approver, time), issued by
(stores: transfer stock entry submitted, user, time), collected by (supervisor's scan at session start),
actual date of application (logsheet application start/stop).

Sprays-only lines shown but not on the paper form: targets, Preventive/Curative + reason, re-entry, PHI.

## Non-goals

- "Type of application" (base/top dressing, marking): fertilizer-only, left off.
- Fertilizer applications through the floor plan; the production repo's Material Request ticket.
- Editing anything from the preview.

## Anti-goals

- A ticket line that disagrees with the plan (a copied value going stale).
- Printing an incomplete ticket.
- Hard-coded crop, farm, product or kit names in logic (kit → method by the kit/sprayer type field).

## Constraints

- Same visibility as the transfers page (Store Keeper roles and above); no new permission.
- SCP styling: Poppins, black and white, pills, no vertical accent strips; skeleton while loading.
- Crop stage blank on a cycle keeps the ticket below 100% (31 of 74 live mutara cycles today) — that is a data
  gap for production, shown as such.

## Approaches considered

- **A. Compute the ticket from existing records (chosen).**
- B. Copy ticket fields onto the Work Order at each step — duplicate writes, can go stale.
- C. Apply the production patch and make a Material Request per plan — rejected by the user.

## Left to the builder

Card layout, exact wording of "missing" hints, the print format's CSS, where the logic lives
(`spray_plan_ops/` next to the transfers endpoints), test structure.
