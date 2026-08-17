### Upande Scp

Scouting & Crop Protection Module

### Installation

You can install this app using the [bench](https://github.com/frappe/bench) CLI:

```bash
cd $PATH_TO_YOUR_BENCH
bench get-app $URL_OF_THIS_REPO --branch develop
bench install-app upande_scp
```

---

## Chemical allocations

When a chemical purchase lands, it has to be divided among the farms that asked for
it. Two things you want are in conflict:

- the split should be **proportional** to what each farm requested;
- every share must be **physically measurable** — your keeper can weigh out 10 g,
  not 4.5 g, and cannot cut a 500 g bottle in half.

The proportional answer is usually a recurring decimal, so something has to give.

There are **two modes**. Which one runs is the General Manager's choice, in
**Settings → Spray Plan → Chemical allocation**.

## Simple split — the default

Each farm's proportional share, rounded **down** to a measurable step. Whatever will
not divide evenly stays in the general store.

```
three farms each asking for 100 kg, 100 kg arrives, step 0.1
  100 / 3         = 33.333…
  rounded down    = 33.3 each
  handed out      = 99.9
  general store   = 0.1
```

That is the whole rule. Its value is that anyone can check it by hand: divide, round
down, and the leftover sits in one visible place.

**Its limit, so it does not surprise you.** When a farm's share is smaller than one
step it gets **nothing**, and the shortfall is not remembered. Five farms each
entitled to 4.5 g with a 10 g step all get zero and the full 22.5 g waits in the
store. In this mode that is accepted — the keeper can see the leftover and hand it out
on their own judgement. Every farm that asked still gets a row showing what it
requested and that it received nothing, so the leftover always has an explanation.

## Balanced split — opt-in

Two additions, both aimed at the case above.

**Leftover steps are redistributed** to the farms with the largest fractional parts
(largest-remainder, or Hamilton, apportionment), so that 22.5 g reaches two farms
instead of nobody. Deterministic — ties break on the larger basis, then farm name — so
re-running an allocation can never reshuffle one you have already published.

**Shortfalls carry forward.** The gap between a farm's exact share and what it
actually got is stored as a credit (`Chemical Allocation Credit`) and added to its
request next cycle:

```
basis = this cycle's request + credit carried in
```

Here is what that buys, on a 95/5 split with 100 arriving each cycle and a 10 g step:

| Cycle | Big farm | Small farm | Ledger after |
| --- | --- | --- | --- |
| 1 | 100 | **0** | Small +5, Big −5 |
| 2 | 90 | **10** | settled |
| 3 | 100 | **0** | Small +5, Big −5 |
| 4 | 90 | **10** | settled |

The small farm goes from *never* served to served every other cycle, and the ledger
clears itself each time it pays out. Fairness a single allocation cannot deliver,
delivered over time.

### Side by side

Two farms asking 30 and 70; the budget cuts the total from 100 to 50; 10 g step.
Exact shares are 15 and 35, neither a multiple of 10:

| Mode | Farm A (asked 30) | Farm B (asked 70) | General store | Carried |
| --- | --- | --- | --- | --- |
| **Simple** | 10 | 30 | **10** | nothing |
| **Balanced** | 10 | 40 | 0 | A +5, B −5 |

Simple leaves the spare step in the store. Balanced gives it to B — whose fraction
was larger — and records that A is owed 5 and B was paid 5 ahead.

When the arithmetic divides evenly the two modes cannot differ. Five farms wanting 10
each, cut from 50 to 45, gives **9 each** either way.

### Switching between them

Switching balancing **off** leaves any credits already earned untouched. They are not
applied and not erased — they simply wait, and resume if it is switched back on. The
general store screen says which state they are in rather than implying they will be
used.

Each allocation records the mode that produced it in the change log, so a past split
stays explicable after the setting changes.

## Rules that hold in balanced mode

**A debit is honoured like a credit.** A farm the redistribution paid ahead carries a
*negative* credit. Forgiving it would mint entitlement out of nothing and the pool
would stop reconciling.

**A budget cut is not a debt.** In the example above, A lost 15 g to the budget and a
further 5 g to the measuring step — and **only the 5 carries**. If cuts carried
forward, every reduction would quietly return as next cycle's entitlement and the
GM's financial decision would mean nothing.

**Credits conserve.** They sum to exactly the part of the leftover that was *owed*, so
the keeper can always answer "why is this 3 kg here, and whose is it?". Narrower than
"credits equal everything in the store": stock bought **beyond** total demand also
sits there, but nobody has a claim on it, so it is credited to nobody.

**A farm that asks for nothing keeps its credit** rather than having stock pushed at
it, and a debit larger than the new request stays outstanding rather than driving an
allocation negative or being quietly forgiven.

## The measuring step

The step is what your store can actually measure, in the item's stock UOM. Defaults
(`apportion.DEFAULT_STEPS`), overridable per cycle line:

| UOM | Step |
| --- | --- |
| Gram, ml | 10 |
| Kg, Litre | 0.1 |
| Bottle, Nos, anything countable or unrecognised | 1 |

Whole units are the fallback on purpose: handing over one of something is always
possible, where a guessed fraction may be unmeasurable.

Conversions between UOMs come from **ERPNext's own** `UOM Conversion Detail` rows on
the Item. This app carries no conversion table, because a "1 bottle = 500 g" constant
in code would drift from whatever you maintain.

One thing worth knowing about the arithmetic: 0.1 has no exact binary representation,
so `3 // 0.1` in Python is **29**, not 30. Before that was accounted for, every clean
kg quantity stranded one step — 100 kg allocated as 99.9 with 0.1 in the store that
nobody could explain. `_steps_in()` handles it with a relative tolerance, and
`TestFloatSafety` keeps it handled.

## Where the leftover goes

What cannot be divided stays in the **general store**, one per company. A farm's
planner can ask the keeper for some of it; the keeper decides each line. Availability
is netted against quantities already approved but not yet moved, so two planners
cannot both be granted the same last kilo.

## Nothing changes silently

Every change to a requirement, an approved total or an allocation is written to
`Chemical Allocation Change` — what changed, from, to, by whom, when — and the
affected farm's planners are notified with the figures. A planner discovering a
changed allocation by noticing the stock did not match is the failure this exists to
prevent.

Once the GM marks a figure **final** it is locked. Re-running consolidation refreshes
what was requested but never moves a settled number; changing it takes an amendment,
not an edit.

## Code and further reading

| What | Where |
| --- | --- |
| Both modes, as pure functions with no database | `upande_scp/serverscripts/store/apportion.py` |
| The cycle, reviews, allocation and the pool | `upande_scp/serverscripts/store/procurement.py` |
| Tests for the maths, incl. every example above | `upande_scp/serverscripts/tests/test_apportion.py` |
| Tests for the flow, against a real site | `upande_scp/serverscripts/tests/test_procurement.py` |
| Design record and the decisions behind it | `docs/superpowers/specs/2026-08-17-chemical-procurement-cycle-design.md`, `docs/superpowers/specs/2026-08-11-chemical-procurement-decisions.md` |

```bash
bench --site <site> run-tests --module upande_scp.serverscripts.tests.test_apportion
bench --site <site> run-tests --module upande_scp.serverscripts.tests.test_procurement
```

---

### Contributing

This app uses `pre-commit` for code formatting and linting. Please [install pre-commit](https://pre-commit.com/#installation) and enable it for this repository:

```bash
cd apps/upande_scp
pre-commit install
```

Pre-commit is configured to use the following tools for checking and formatting your code:

- ruff
- eslint
- prettier
- pyupgrade

### License

mit
