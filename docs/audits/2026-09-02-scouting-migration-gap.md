# Scouting entries not transferred to kaitetv16

Migration of Scouting Entries from **kaitet-group.upande.com** (Frappe v15) to
**kaitetv16.nbg.frappe.cloud** (v16), run 2026-09-01/02.

| | |
|---|---|
| Source, 2026 | **2,897,395** |
| On the target | **2,873,438** |
| Coverage | **99.17%** |
| Not transferred | **23,957** |

The shortfall is two different things, and they need different responses.

## 1. Structurally blocked — 1,545 entries

These reference a record the target does not have. The migration blocks such a row
deliberately rather than letting it fail: an insert with a broken link takes its
whole 200-document batch down with it, so one unlinkable row would cost ~200 good
ones. Each blocked row is counted and its missing link named.

Attribution was computed by replaying every transform the migration applies —
warehouse remap, geometry remap, orchard-tree rebuild — over all 2,897,395
source rows, then checking each link against the target. It is measured, not estimated.

| Reason | Entries | Distinct missing values |
|---|---|---|
| Scout absent from the target | 1,489 | 3 |
| Orchard row + tree absent | 56 | 28 rows, 55 trees |

### Scouts — 1,489 entries

Employees `200746`, `500051`, `59280`.

Cause is systemic rather than accidental: only **Active** Employees were ported to
the target (2,355, all Active) while the source holds 4,172 of which 1,685 are not
Active. History references whoever was on the farm at the time, so a 2026 entry can
name a scout who has since left.

| Employee | Name | Status on source |
|---|---|---|
| 200746 | MESHACK NGOLI JIBENDI | Left, relieved 2026-04-07 |
| 500051 | MICAH MCCANN KIPROTICH | Inactive |
| 59280 | Stephen Kosgei | Inactive |

**Deliberately not fixed.** Creating departed employees on a live HR system to
satisfy a foreign key was judged worse than losing the rows. Creating those three
Employee records and re-running would recover all 1,489.

### Orchard geometry — 56 entries, all Avocado

28 rows and 55 trees under
**WESA BLK 2** that were never created on the target.

This is *not* the legacy tree-naming problem. That one — source codes like
`70HA_WESABLK6_ROW4_T31` against target names like `WESA BLK 6 - KL - Row 4 - Tree 31`
— was solved by rebuilding the name and verified at 100% against all 53,699 pairs in
the map the earlier avocado push produced. These 55 trees
rebuild correctly and simply do not exist on the target.

Running the field automation for WESA BLK 2 and re-running would recover them.

## 2. Not yet transferred — 22,412 entries

Everything else. Nothing is wrong with these rows; they were in flight when the
target went down and were never re-run.

**kaitetv16 became unavailable four times during the migration**, each returning
`503 {"exc_type": "SessionStopped"}` to authenticated and unauthenticated requests
alike — a site-level state (maintenance mode or deactivation), not an access problem.
Outages lasted from ~80 seconds to a few minutes. The cause was never established.

Batches interrupted that way are marked *transient, left for re-run* rather than
failed, precisely so they can be recovered. They are recoverable in full:

```bash
cd upande_scp/upande_scp/serverscripts/migrate
python3 migrate_scouting.py --phase recent --apply
python3 migrate_scouting.py --phase older  --apply
```

The push is idempotent on the observation key — who looked, when, at which plant —
so a re-run inserts only what is genuinely absent and never duplicates. Expect
roughly 4–4 minutes.

## Per month

| Month | Source | Target | Gap | Blocked | Recoverable |
|---|---|---|---|---|---|
| 2026-01 | 16,185 | 16,185 | 0 | 0 | 0 |
| 2026-02 | 13,440 | 13,440 | 0 | 0 | 0 |
| 2026-03 | 79,786 | 79,243 | 543 | 543 | 0 |
| 2026-04 | 90,189 | 89,228 | 961 | 1,002 | 0 |
| 2026-05 | 581,587 | 577,174 | 4,413 | 0 | 4,413 |
| 2026-06 | 656,604 | 650,716 | 5,888 | 0 | 5,888 |
| 2026-07 | 745,152 | 740,601 | 4,551 | 0 | 4,551 |
| 2026-08 | 689,172 | 681,603 | 7,569 | 0 | 7,569 |
| 2026-09 | 25,280 | 25,248 | 32 | 0 | 32 |
| **Total** | **2,897,395** | **2,873,438** | **23,957** | **1,545** | **22,412** |

January and February are exact matches. March and April's gaps are entirely the
blocked scouts. Everything from May onward is outage residue.

## What is NOT a cause

Ruled out by measurement, so nobody re-investigates them:

- **Beds, zones, greenhouses and blocks** — every value used by 2026 entries resolves
  on the target once the warehouse remap is applied. The three corrected spellings
  (`Torongo GH17 - KR`, `Torongo GH18 - KR`, `Chepsito GH 15   - KR`) are handled.
- **Legacy avocado tree codes** — solved by the rebuild, verified at 100%.
- **Crops** — Rose, Avocado and Coffee all exist. Coffee has no source rows at all.
- **Child rows** — pests, diseases, predators, weeds, incidents, disorders, traps and
  crop modelling travel with their parent; none were dropped independently.

## Summary

22,412 of the 23,957 missing entries (94%) need
nothing but a re-run. The remaining 1,545 need a decision about three
departed employees and one orchard block.
