# General store, store-keeper assignment, and in-app notifications

**Date:** 2026-08-11
**Status:** approved, not yet implemented
**Scope:** phases 0 and 1 of the store/procurement/loaning programme (see
`2026-08-11-chemical-procurement-decisions.md` for the later phases)

## Why this first

The wider request — automated chemical procurement, a reworked loaning flow, and
a budget view — is five subsystems, not one feature. These two are the
foundation the rest leans on, and both are small enough to get right without
guessing:

| # | Piece | Depends on |
| --- | --- | --- |
| **0** | General store + keeper→store assignment | — |
| **1** | Notifications (log, realtime, page) | — |
| 2 | Loaning rework | 0, 1 |
| 3 | Procurement cycle | 0, 1 |
| 4 | Budget / financial view | 2, 3 |

## What already exists

- **`Chemical Transfer Request`** carries `requesting_farm`, `workflow_state`
  (Draft → Pending Approval → Approved → Fulfilled), and a `sources` child with
  per-source `approved` / `approved_by` / `stock_entry`. Loaning is less
  primitive than it feels, but `item_code` / `uom` / `requested_qty` sit on the
  **parent**, so it is structurally single-item.
- **`_notify_user()` in `loaning.py` already writes `Notification Log` rows** —
  the correct doctype for notification *instances*. (`Notification` is the rules
  doctype; we do not want that one.)
- **No procurement code exists** — zero `Material Request` references in the app.
- **No general/central chemical store exists** — 11 per-farm chemical stores,
  each parented under its farm's warehouse group (`Karen - KR`, `Saboti - KL`…),
  with nothing above them.
- **`Farm Store Keeper` is a child of `Farm`** via the `store_keepers` Custom
  Field, so keepers are assigned **per farm, not per store**. Consumed by
  `store_keeper_api._allowed_farms_for` (dashboard scoping) and
  `spray_plan_creator/admin.py` (settings listing).

## Decisions

| Question | Decision |
| --- | --- |
| How many general stores | One per company |
| Keeper → store binding | Add a `warehouse` field to the existing `Farm Store Keeper` row |
| Notification delivery | In-app only, with realtime |

## Phase 0 — Store model

### General chemical store

One `Warehouse` per company, `is_group = 0`, e.g. `General Chemical Store - KR`.

Parented at the **company root** (`All Warehouses - KR`), *not* under a farm
group. Existing chemical stores hang off their farm's group, which is right for
them and wrong here: a shared pool belongs to no farm, and burying it under one
would make it look like that farm's stock in every warehouse-tree report.

It is an ordinary warehouse, so purchase receipts, transfers and the stock ledger
need no special casing. Item-group inventory accounts already resolve per company
(see `setup_item_wise_inventory_accounts`), so it needs no account override.

Created idempotently by patch, for each company in `STOCKED` that has chemical
stores today.

### Keeper → store

`Farm Store Keeper` gains `warehouse` (Link → Warehouse). A row then reads
"this user keeps this store, at this farm". It is an app-owned child doctype, so
this is an ordinary field addition, not a fixture change.

**Backfill** sets `warehouse` from the parent farm's `custom_chemical_store`.
That is the honest default: today's keepers are chemical-store keepers in
practice, since the dashboard they use is the Chemical Dashboard. Some may really
be fertilizer keepers, and the patch cannot know which — so it **prints every row
it touched** for human review rather than implying it inferred correctly.

**Scoping must not regress.** `_allowed_farms_for` keeps deriving farms from the
child row's parent. A new store-level scope narrows on top of it. Where
`warehouse` is null — an unmigrated row, or one added by hand — it falls back to
the farm's mapped chemical/fertilizer stores, so a half-migrated site degrades to
today's behaviour instead of showing an empty dashboard.

### General-store keepers

A `general_store_keepers` child on `Scouting and Crop Protection Settings`,
reusing the `Farm Store Keeper` shape (`user`, `full_name`, `warehouse`). They
belong to no farm, so the Farm form has nowhere to put them.

### Roles

**No new role.** Being assigned to a general store *is* the permission to
allocate from it. A separate `SCP General Store Keeper` role would be a second
source of truth that can drift from the assignment — a user could hold the role
with no assignment, or vice versa, and neither state means anything useful. The
existing `SCP Chemical Store Keeper` still gates the dashboard; the GM review in
phase 3 gates on `SCP General Manager`.

## Phase 1 — Notifications

### Server

One helper module, `serverscripts/common/notifications.py`:

```
notify(users, subject, body, ref_doctype=None, ref_name=None, category=None)
users_for_role(role)      -> [user]
users_for_farm(farm)       -> keepers + planners + approvers for that farm
users_for_store(warehouse) -> keepers assigned to that store
```

`notify` writes one `Notification Log` per user and fires
`frappe.publish_realtime("scp:notification", user=<user>)` so the unread badge
updates without polling. It never raises: a notification failing must not roll
back the transaction that triggered it (`loaning._notify_user` already gets this
right and its body moves here).

`loaning._notify_user` is **absorbed**, not left alongside — two notification
paths would drift.

### Category

`Notification Log.type` is a fixed Frappe enum (Alert / Share / Assignment /
Energy Point), so our taxonomy needs a **custom field `scp_category`**: `loan`,
`transfer`, `procurement`, `stock`. That is what the page filters on. Encoding it
in the subject string would make filtering a substring search.

### Endpoints

- `list_notifications(category=None, unread_only=0, limit=50, offset=0)`
- `unread_count()`
- `mark_read(names=None, all=0)`

All three resolve the user from `frappe.session.user` server-side. **The client
never passes `for_user`** — accepting one would let any user read another's
notifications.

### Audience matrix

The helper ships now; each event is wired as its phase lands. Only the loan
events have a producer today.

| Event | Audience | Phase |
| --- | --- | --- |
| Loan requested | the lender farm's keepers + planners, nobody else | 2 |
| Loan approved / rejected | the requesting planner | 2 |
| Request exceeds half the lender's stock | the lender, informational only | 2 |
| Transfer request raised | the general store's keepers | 3 |
| Procurement review due | `SCP General Manager` | 3 |
| Allocation published | each farm's planners + keepers | 3 |

### Frontend

Notifications are **not crop-scoped**, but the SPA sidebar is
(`navForCrop` — rose / avocado / coffee). So:

- a **bell in the header** with a live unread count, subscribed to
  `scp:notification`, reachable from every page;
- a **dedicated route** listing notifications, with a category filter,
  mark-one / mark-all-read, and click-through to the referenced record;
- an empty state that reads as "nothing to see" rather than as a failure.

Not an entry in the crop sidebar — it would appear three times and imply the
notifications were crop-specific.

## Testing

**Python**
- `scout_initials`-style pure helpers: `users_for_role` / `users_for_farm` /
  `users_for_store` resolve the expected users, and exclude Administrator/Guest.
- `notify` writes one row per user, sets `scp_category`, and swallows a failure
  without propagating.
- `list_notifications` / `mark_read` only ever touch the session user's rows —
  asserted by seeding rows for two users and checking isolation.
- The backfill patch is idempotent and leaves an already-set `warehouse` alone.
- Store scoping falls back to the farm's mapped stores when `warehouse` is null.

**Vitest**
- Unread-count reducer and the category filter.
- The bell renders a count, and clears it on mark-all-read.

## Risks

1. **The backfill guesses chemical over fertilizer.** It cannot know, so it
   reports what it did. If a site has fertilizer-store keepers, their rows will
   be wrong until corrected — which is why the patch prints rather than stays
   silent.
2. **Realtime needs the socketio process.** `frappe15-web:frappe15-node-socketio`
   is running under supervisor here, but the badge must still be correct on a
   plain page load, so it reads `unread_count()` on mount and treats realtime as
   an optimisation, not the source of truth.
3. **Notification volume.** A farm's planners and keepers can be several users;
   a busy procurement round could fan out widely. Worth watching before phase 3
   wires the bulk events.

## Out of scope

- Email or SMS delivery.
- Per-event delivery configuration.
- Notification preferences per user.
- Anything in phases 2–4 (see the procurement decisions record).
