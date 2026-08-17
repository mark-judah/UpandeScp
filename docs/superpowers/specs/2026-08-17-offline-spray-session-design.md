# Offline spray sessions — design

**Date:** 2026-08-17
**Status:** designed, not built
**Grounded in:** `test_offline_sequence_feasibility.py` (8 cases),
`test_offline_token_mechanics.py` (11 cases), and the proven pattern in
`doc references/fixes/spray_plan_issue/redate_chain_to_transfer_console.py`

## What the tests established

Every claim below was checked against real Stock Entries on kaitet, not reasoned from
code. The site was left clean: zero submitted entries, zero bin balance.

| # | Claim | Result |
| --- | --- | --- |
| 1 | An Issue cannot be created without a Manufacture | **Blocked by the state machine.** `start_spray_session` requires `Tank Mix Manufactured`; `end_spray_session` requires `Spraying In Progress` and looks up a submitted Manufacture SE |
| 2 | An Issue posted *earlier in the ledger* than its Manufacture | **Refused** — `NegativeStockError`. The real risk, and the ledger catches it |
| 3 | Nothing can be consumed before the transfer that delivered it | **Refused.** The transfer is a genuine anchor floor, exactly as the remediation header claims |
| 4 | A backdated pair, ordered, posts cleanly with cost intact | **Yes** |
| 5 | Is the one-second gap load-bearing? | **No — same-second also posts.** Keep it anyway as belt-and-braces, but the design does not depend on it |
| 6 | Backdating blocks the submit while valuation recalculates | **No** — it queues a `Repost Item Valuation`. A bulk sync will not hang |
| 7 | The ledger orders on posting moment, not creation | **Confirmed** — created first, dated later, ordered later |
| 8 | Idempotency can reuse `custom_original_stock_entry` | **No** — that field does not exist on this site |
| 9 | A zero valuation would let anything post | **True, and rejected as an option** (see below) |

Two of those overturned my own assumptions, which is why they were tested:

* I read the `NegativeStockError` message wrongly at first and briefly concluded ERPNext
  *allowed* an out-of-order Issue. It does not. The message — "10.0 units of item X needed
  in warehouse Y to complete this transaction" — contains none of the words a keyword
  check looks for, so the test asserts on the exception type.
* I assumed the same-second case would fail and that the remediation script's one-second
  gap was therefore essential. It isn't. Worth knowing before someone treats the constant
  as magic — or drops it as noise.

## The governing principle, borrowed

From `redate_chain_to_transfer_console.py`:

> "The honest, valid anchor is the TRANSFER date: on that date the raw chemicals are
> provably in the CSU, so a manufacture + issue posted that day cannot fail on stock."

**Anchor to a moment when the inputs provably existed** — not to the moment the client
claims. That single rule dissolves most of the device-clock problem: a handset cannot
post a mix before the chemicals reached the CSU no matter how wrong its clock is, because
test 3 shows the ledger refuses it.

## Valuation is never waived

`allow_zero_valuation_rate` makes any of this post — at zero cost. That defeats the entire
purpose, which is that the spray's cost lands in the month it happened. Both remediation
scripts default `ALLOW_ZERO_VALUATION` to False and step 3 *skips* such a candidate rather
than "issuing at a zero value".

**The token does the same: refuse and report, never post a costless spray.** A missing
valuation is a distinct failure from an ordering one and must be reported as itself — it
looks nothing like a stock error and would otherwise be misdiagnosed. (It was, on the
first run of the mechanics tests.)

## The design

### The token

A `Spray Session Token` created on the handset when the scanned QR sequence matches the
plan's required chemicals. It accumulates an ordered event log — each scan with its code
and moment, the mix moment, the spray start, the spray end — and is synced as one unit.

Not four queued calls: **one atomic `sync_spray_session(token)`**, so a session either
lands whole or not at all. Four separately-queued steps can interleave and half-fail,
leaving a plan in a state nobody chose.

### Clock handling

Device time is used, but never trusted blind:

* **while online**, the app records `skew = device_now − server_now` (from
  `timezone.timezone_report`, which already returns both clocks) and stores it;
* **offline**, events are stamped with device time plus the last known skew, so a wrong
  phone clock is *corrected* rather than merely flagged;
* **on the wire**, moments travel as UTC, so the phone's *timezone* setting cannot corrupt
  anything — only its clock can, and skew handles that;
* the app still prompts for automatic time. `expo-intent-launcher` is already a dependency
  so Android deep-links to date settings; iOS exposes no auto-time flag and no date-settings
  link, so it stays advisory there.

This only became meaningful once the site timezone was corrected — a handset sending
Nairobi time to a Kolkata-clocked server was 2h30m out.

### Posting, on sync

```
anchor_floor = the transfer SE's posting datetime   (inputs provably in the CSU)

manufacture_at = max(token.mix_moment, anchor_floor)
issue_at       = max(token.spray_end,  manufacture_at + 1s)
```

The `max()` is what makes a bad clock harmless rather than dangerous: it can only push a
posting *later*, never behind the moment its inputs arrived.

### Pre-flight guard, before anything is written

Lifted from the remediation script's skip list, which was built against real failures:

| Guard | Refusal |
| --- | --- |
| no submitted transfer | no anchor floor exists |
| scanned set ≠ `required_items` | the token does not describe this plan |
| raw short in the CSU at the anchor | names the shortfall, rather than bouncing off `NegativeStockError` mid-flight |
| mix has no valuation | refuse — never post at zero cost |
| times out of order after clamping | the token is internally inconsistent |
| session older than N days | review, not silent posting |

The point is to **fail before touching stock**, so the supervisor gets "these chemicals
were not in the CSU on Tuesday" instead of a stock error naming a warehouse they have
never heard of.

### Idempotency

`custom_original_stock_entry` — the remediation scripts' key — does not exist here, and the
handset's `clientId` lives in its own SQLite, so a reinstall makes a re-synced session look
new. So the token carries its own server-side link: a `Spray Session Token` doctype whose
name is the token id, holding the work order and the documents it created. A re-sync finds
the row and returns what it made rather than making it again.

Note the performance lesson recorded in step 3: an unindexed lookup across ~1.9M Stock
Entries was a full table scan per candidate and timed out the console. Whatever the token
stores must be indexed, or preloaded once per sync batch.

## What must be built, in order

**Server first** — the client has nowhere to put its data until these exist:

1. a posting moment on the Manufacture (the Issue already accepts one via
   `set_posting_time`);
2. client moments on `start_spray_session` / `end_spray_session`, which currently stamp
   `now_datetime()` and accept nothing;
3. Datetime fields on the SAL beside its eight `Time` fields, which carry no date — a
   session crossing midnight is currently unreconstructable;
4. `Spray Session Token` + `sync_spray_session()` with the guard above;
5. the pre-flight as a *read-only* endpoint too, so the handset can warn before syncing.

**Then the client:** the token in SQLite, skew capture at login and sync, the clock gate,
a `"spray_session"` queue type, and a visible per-session sync state.

## Still open

**Does the spray cutoff bind against the reported start time?** A session started offline
at 09:50 and synced at 11:00 — accept it (honest about what happened, but a wrong clock
could walk through the cutoff) or refuse on sync (they should have postponed). The only
remaining policy call; everything else is decided by the tests above.
