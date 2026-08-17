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

When a chemical purchase lands, it has to be split across the farms that asked for
it. Two requirements pull against each other:

- the split should be **proportional** to what each farm requested;
- every share has to be **physically measurable** — a store keeper can weigh out
  10 g, not 4.5 g, and cannot cut a 500 g bottle in half.

The obvious resolution is wrong, and it is worth seeing why before the rules make
sense.

### Why not just round down

Five farms each entitled to 4.5 g, with a 10 g measuring step. Round each share
down and **every farm gets zero**, while the entire 22.5 g sits in the store. The
split is perfectly proportional and completely useless.

So instead the quantity is converted into whole steps and shared out by
**largest-remainder (Hamilton) apportionment**: each farm gets the whole steps its
share earns, then the leftover steps go one at a time to the farms with the largest
fractional parts.

```
22.5 g available, 10 g step  →  2 whole steps to give out
each farm's exact share = 4.5 g = 0.45 steps
whole steps each          = 0                    ← nobody, if we stopped here
2 spare steps go to the two largest fractions → two farms get 10 g
```

Two farms get something real instead of five farms getting nothing. Which two is
decided deterministically — largest fractional part, then larger original request,
then farm name — so re-running an allocation can never reshuffle a published one.

### Worked examples

All of these are real output from `apportion()`, and each is pinned by a test.

**A clean cut.** Five farms want 10 each; the GM cuts the total from 50 to 45.

| Farm | Requested | Allocated |
| --- | --- | --- |
| F1–F5 | 10 each | **9 each** |

Nothing left over, nobody owed anything. A proportional cut that divides evenly is
the easy case.

**A clean multiple.** Two farms want 30 and 70; 100 arrives, 10 g step.

| Farm | Requested | Allocated | Carried forward |
| --- | --- | --- | --- |
| A | 30 | 30 | — |
| B | 70 | 70 | — |

**A rounding residue.** Same two farms, but the budget cuts 100 → 50.

| Farm | Requested | Exact share | Allocated | Carried forward |
| --- | --- | --- | --- | --- |
| A | 30 | 15 | **10** | **+5 owed** |
| B | 70 | 35 | **40** | **−5 (paid ahead)** |

Neither 15 nor 35 is a multiple of 10, so the split cannot be exact. A is short by
5 and B got 5 more than its share — and both facts are remembered.

### Carry-forward: the credit ledger

That residue is **not written off**. Each farm's unmeasurable fraction is stored as
a credit (`Chemical Allocation Credit`, one row per farm and item) and added to its
request next cycle:

```
basis = this cycle's request + credit carried in
```

The split is proportional to that basis, not to the raw request.

**Why it matters.** Without it, a farm that repeatedly lands just under a step is
shorted *every single cycle*. Here is a 95/5 split, 100 arriving each cycle, 10 g
step:

| Cycle | Big farm | Small farm | Ledger after |
| --- | --- | --- | --- |
| 1 | 100 | **0** | Small +5, Big −5 |
| 2 | 90 | **10** | settled |
| 3 | 100 | **0** | Small +5, Big −5 |
| 4 | 90 | **10** | settled |

The small farm goes from *never* being served to being served every other cycle,
and the ledger clears itself each time it pays out. Fairness that a single
allocation cannot deliver, delivered over time.

**A credit buys real stock once it clears a step.** A carries 1.5 forward, both
farms ask for 10, 22 arrives, 1-unit step:

| Farm | Requested | Credit in | Basis | Allocated |
| --- | --- | --- | --- | --- |
| A | 10 | 1.5 | 11.5 | **11** |
| B | 10 | — | 10 | **10** |

### The rules, and what each one prevents

**A debit is honoured like a credit.** A farm the rounding paid ahead carries a
*negative* credit. Forgiving it would mint entitlement out of nothing, and the pool
would stop reconciling.

**A budget cut is not a debt.** In the 100 → 50 example, farm A lost 15 g to the
budget and a further 5 g to the measuring step — and **only the 5 carries**. If cuts
carried forward, every reduction would quietly return as next cycle's entitlement
and the GM's financial decision would mean nothing.

**Credits conserve.** They sum to exactly the part of the leftover pool that was
*owed* — so the keeper can always answer "why is this 3 kg here, and whose is it?".
Narrower than "credits equal everything in the store": stock bought **beyond** total
demand also sits there, but nobody has a claim on it, so it is credited to nobody.

**A farm that asks for nothing keeps its credit** rather than having stock pushed at
it.

**A debit larger than the new request stays outstanding.** It never drives an
allocation negative, and it is never quietly forgiven.

**Nothing exceeds what was asked for.** However generous the budget, a farm is not
given more than its basis.

### The measuring step

The step is what the store can actually measure, expressed in the item's stock UOM.
Defaults (`apportion.DEFAULT_STEPS`), overridable per cycle line:

| UOM | Step |
| --- | --- |
| Gram, ml | 10 |
| Kg, Litre | 0.1 |
| Bottle, Nos, anything countable or unrecognised | 1 |

Whole units are the fallback on purpose: handing over one of something is always
possible, whereas a guessed fraction may be unmeasurable. Conversions between UOMs
come from **ERPNext's own** `UOM Conversion Detail` rows on the Item — this app
carries no conversion table, because a "1 bottle = 500 g" constant in code would
drift from whatever the user maintains.

### Where the leftover goes

What cannot be expressed in whole steps stays in the **general store**, one per
company. A farm's planner can ask the keeper for some of it; the keeper decides each
line. Availability is netted against quantities already approved but not yet moved,
so two planners cannot both be granted the same last kilo.

### Nothing changes silently

Every change to a requirement, an approved total or an allocation is written to
`Chemical Allocation Change` — what changed, from, to, by whom, when — and the
affected farm's planners are notified with the figures. A planner discovering a
changed allocation by noticing the stock did not match is the failure this exists to
prevent.

Once the GM marks a figure **final** it is locked. Re-running consolidation refreshes
what was requested but never moves a settled number; changing it takes an amendment,
not an edit.

### Code and further reading

| What | Where |
| --- | --- |
| The apportionment maths (pure, no database) | `upande_scp/serverscripts/store/apportion.py` |
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
