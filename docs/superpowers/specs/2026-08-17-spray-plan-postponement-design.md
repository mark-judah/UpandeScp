# Postponed spray plans — design

**Date:** 2026-08-17
**Status:** implemented

## The gap

A spray that does not go out on its day is the normal case, and the system had no way
to say so. There were two options and both were wrong:

* **leave it.** `auto_cancel_dormant_plans` eventually Stopped it for being old, which
  records abandonment rather than a move — and the dormancy clock runs from *creation*,
  so the plan was punished for age it could not help.
* **Stop it by hand.** Also records abandonment, and loses the new date entirely.

Nothing captured *why* a plan slipped, and nothing stopped yesterday's plan being
quietly sprayed today as if nothing had happened.

## The flow

```
supervisor declares  →  Pending  →  approver decides
   reason required                    │
   plan keeps its date                ├── approve → both date fields move
                                      └── refuse  → date unchanged, refusal kept
```

Three decisions were taken before building, and each shaped the result:

### Only up to Tank Mix Manufactured

`POSTPONABLE_STATES` is Pending Submission, Awaiting Approval, Approved, Chemical
Issued. Once the mix exists it is not a plan any more, it is mixed chemical with a
short life — moving the *date* would record a spray using something that is no longer
what it was. Past that point the plan is sprayed or Stopped, and both paths already
exist.

The refusal says so in those words, because "state not allowed" would leave the
supervisor guessing.

### A daily cutoff, measured from the plan's own date

`spray_cutoff_time` (default 10:00). After it, on the plan's spray date, no
postponement may be declared **and the spray may not be started** — enforced in
`start_spray_session`, not in the client, because the client is what gets bypassed.

Anchoring the deadline to the plan's date rather than to *today* is the part that
matters: a plan from last week is permanently past its deadline, which is exactly what
stops it being sprayed this morning. `test_a_plan_from_last_week_is_long_past_its_deadline`
pins it.

Two windows, deliberately different widths:

| | window |
| --- | --- |
| declaring a postponement | cutoff **+ `postponement_grace_minutes`** |
| starting a spray | cutoff, hard |

The grace is for the supervisor standing in the field at 10:01 — they should be able to
record the slip properly rather than leave the plan to rot. Starting a late spray gets
no grace, because the whole point of a cutoff is that a late spray is not one anybody
planned for.

### A bound on the move

`postponement_max_days` (default 7). Without it a plan can be deferred indefinitely,
and a plan deferred indefinitely has been abandoned without anybody saying so. The
refusal says that too.

### The plan is re-dated, not re-created

The same Work Order moves and every declaration — approved, refused or withdrawn — is
kept as a `Spray Plan Postponement` row. A new Work Order per slip would double the
records and break the link to chemicals already transferred against the original.

**Both date fields move together.** `custom_scheduled_application_time` is what the
operator sees and `planned_start_date` is what ERPNext's scheduling reads;
`create_application_work_order` writes them as a pair, so updating one alone would make
the plan say two different things about when it happens.

**The date moves on approval, not on declaration.** A pending request must not change
what the store and the sprayers are working to.

### Who decides

The farm's existing `Farm Spray Plan Approver` rows, or the GM. Reusing that list
rather than adding a second one: two lists of approvers drift, and the people who
approved the plan are the ones who should see it slip.

## Auto-cancel had to be taught about this

`auto_cancel_dormant_plans` measured dormancy from creation, so a plan deliberately
moved to next week would have been Stopped today for being old — the exact opposite of
what the postponement said. It now skips any plan with an Approved or Pending
postponement (`_recently_postponed`). A *refused* one stops protecting the plan, which
is right: the answer was no, so the plan is as dormant as it looks.

## Two bugs found while building

**The allocation-mode toggle was never wired.** `save_spray_plan_settings` copies a
**whitelist** of scalar fields, and `allocation_balancing_enabled` — shipped earlier the
same day with a doctype field and a UI checkbox — was not on it. Ticking the box saved
nothing. Now wired, along with the three new fields, and `TestSettingsWiring` round-trips
all four through the editor's own read/write path so the next field cannot ship
half-connected.

**A midnight cutoff locks the entire site out of spraying.** A half-finished save left
`spray_cutoff_time` at `0:00:00` on kaitet, and `value or DEFAULT` did not catch it
because `"0:00:00"` is a truthy string. Every plan was instantly past its deadline.
`cutoff_time()` now treats an all-zero value as unset — no farm wants "the deadline
passed before the day began" as a policy — while still respecting a genuinely early one
like `00:30:00`.

## Not built

**The mobile end.** Supervisors work in the React Native app, and this ships the web
surfaces plus whitelisted endpoints (`declare`, `decide`, `withdraw`,
`postponable_plans`, `postponement_settings`, `history_for`, `cutoff_status`) for it to
adopt. The RN app lives in another repo; the API is deliberately shaped for it —
`postponable_plans` returns each plan's deadline and both can-flags, so a handset can
render the state without recomputing the rule.

**Timezone.** Every deadline here is evaluated in the site timezone, which is still
`Asia/Kolkata` — **2h30m ahead of Kenyan local time**. A 10:00 cutoff currently bites at
07:30 Nairobi. The postponement flow is correct relative to whatever the site says the
time is; it will only *mean* what it says once System Settings is fixed. That is the
first item in the feasibility summary and remains outstanding.

## Tests

`test_postponement.py`, 30 cases:

* the deadline is the plan's own date at the cutoff — including the stale-plan case;
* the state boundary, both from the declaring side and from the "plan moved on while
  the request waited" side;
* the grace window widens declaring but not starting;
* approval moves both date fields; refusal moves neither and keeps the record;
* one pending request at a time; must move later; cannot exceed the bound;
* auto-cancel skips a postponed plan and stops skipping a refused one;
* the settings round-trip, and the midnight-cutoff fallback.

`postponement-api.test.ts`, 13 cases, covering the three-way deadline description that
the screen turns on.
