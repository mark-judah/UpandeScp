"""Splitting a chemical quantity back to the farms that asked for it.

A purchase arrives and has to be divided in proportion to what each farm requested,
in amounts a store keeper can physically measure. Those two requirements fight: the
proportional answer is usually a recurring decimal, and nobody can weigh out
33.333… g.

There are **two modes**, and which one runs is the General Manager's choice: the
``allocation_balancing_enabled`` setting ("Balance allocations and carry credits
forward").

## SIMPLE — the default

Each farm's proportional share, rounded **down** to a measurable step. Whatever
will not divide evenly stays in the general store.

    three farms each asking for 100 kg, 100 kg arrives, step 0.1
      → 33.3 each (33.333… rounded down), 0.1 left in the general store

That is the modulus, and it is the whole rule. Its virtue is that anyone can check
it by hand: divide, round down, and the leftover is visible in one place.

Its limit is worth knowing. When a farm's share is smaller than one step it gets
**nothing**, and the shortfall is not remembered — five farms each entitled to 4.5 g
of a 10 g step all get zero, and the full 22.5 g waits in the store. In simple mode
that is accepted: the keeper sees the leftover and hands it out on their own
judgement.

## BALANCED — opt-in

Two additions, both aimed at the case simple mode handles poorly.

**Largest-remainder (Hamilton) apportionment.** The leftover whole steps are handed
out one at a time to the farms with the largest fractional parts, so the 22.5 g above
reaches two farms instead of nobody. Deterministic: ties break on the larger basis,
then farm name, so re-running can never reshuffle a published allocation.

**Carry-forward.** The gap between a farm's exact share and what it actually got is
remembered as a credit and added to its request next cycle. Without it, a farm that
repeatedly lands just under a step is shorted every single cycle — the same
starvation, arriving more slowly. Measured on a 95/5 split with a 10 g step, the
small farm goes from never served to served every other cycle.

Two properties keep the credits honest:

* **They conserve.** Credits sum to exactly the part of the leftover that was
  *owed*, so the pool always has an owner-by-owner explanation. A farm the Hamilton
  pass rounded UP carries a negative credit — a debit — because it was paid ahead;
  forgiving that would mint entitlement and the pool would stop reconciling. Stock
  bought *beyond* total demand also sits in the pool but is owed to nobody, so it is
  credited to nobody.
* **A budget cut is not a credit.** If a farm asks for 10 and the GM's reduction
  leaves it 9, the missing 1 is a financial decision, not an unmeasurable fraction.
  Only the rounding residue carries; otherwise every cut would silently return as
  next cycle's entitlement and the reduction would mean nothing.

A farm that requests nothing keeps its credit untouched rather than being pushed
stock it did not ask for.

Both modes share everything else: never over-allocate, never exceed what was asked
for, every allocation a whole number of steps.

Pure functions: no Frappe, no database. The mode, step sizes and carried credits all
come from the caller.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

#: Credits below this (in stock UOM) are treated as settled. Floating-point
#: residue like 1e-16 is not a debt, and carrying it forever would litter the
#: keeper's view with rows that mean nothing.
CREDIT_EPSILON = 1e-9

#: Tolerance for "how many whole steps fit", relative so it holds at any scale.
_STEP_TOL = 1e-9


def _steps_in(qty: float, step: float) -> int:
	"""How many whole `step`s fit in `qty`, tolerant of binary float error.

	Plain ``qty // step`` is wrong here, and wrong in the most common case: 0.1 has
	no exact binary representation, so ``3 // 0.1`` is **29**, not 30. With the
	default 0.1 step for kg and litres that stranded one step of every clean
	quantity in the general store — 100 kg allocated as 99.9 with 0.1 unexplained.
	"""
	if step <= 0:
		return 0
	raw = qty / step
	return max(0, int(math.floor(raw + max(_STEP_TOL, abs(raw) * _STEP_TOL))))


#: Proportional share, rounded down to a measurable step, remainder to the general
#: store. No redistribution, no credits. The default.
MODE_SIMPLE = "simple"

#: Hamilton redistribution of the leftover steps, plus carry-forward credits.
MODE_BALANCED = "balanced"

MODES = (MODE_SIMPLE, MODE_BALANCED)

#: What runs when nobody says otherwise. Simple, because an allocation an operator
#: can verify by hand is worth more than one that is marginally fairer.
DEFAULT_MODE = MODE_SIMPLE


@dataclass(frozen=True)
class Allocation:
	farm: str
	requested: float
	#: What this farm gets, always a whole multiple of the step.
	allocated: float
	#: Whole steps allocated — handy for explaining the result in the UI.
	steps: int
	#: This cycle's request plus any credit carried in. The apportionment is
	#: proportional to THIS, not to `requested`.
	basis: float = 0.0
	#: Credit carried into this cycle (negative = paid ahead previously).
	credit_in: float = 0.0
	#: Exact share minus what was actually allocated — carried to the next cycle.
	credit_out: float = 0.0


@dataclass(frozen=True)
class Apportionment:
	allocations: tuple[Allocation, ...]
	#: Left in the general store: the part of the reduced total that cannot be
	#: expressed in whole steps.
	remainder: float
	step: float
	#: The total actually handed out (sum of allocations).
	distributed: float
	#: farm -> credit for the NEXT cycle, including farms that sat this one out.
	#: Complete: persist this map wholesale rather than merging it by hand.
	carried_forward: dict[str, float] = field(default_factory=dict)


def _carry(carried: dict[str, float] | None) -> dict[str, float]:
	return {
		f: float(q)
		for f, q in (carried or {}).items()
		if abs(float(q)) > CREDIT_EPSILON
	}


def apportion(
	requests: dict[str, float],
	reduced_total: float,
	step: float,
	carried: dict[str, float] | None = None,
	mode: str = DEFAULT_MODE,
) -> Apportionment:
	"""Split `reduced_total` across `requests` in whole multiples of `step`.

	`requests` maps farm -> quantity requested this cycle. Farms requesting zero
	or less are ignored: they asked for nothing, so they get nothing now.

	`mode` is ``"simple"`` (the default) or ``"balanced"``:

	* **simple** — each share rounded down to a step; the indivisible remainder
	  stays in the general store; no redistribution and no credits. `carried` is
	  ignored, so existing credit rows are left untouched and resume if balancing is
	  switched back on.
	* **balanced** — leftover steps go to the largest fractions, and each farm's
	  shortfall is returned in `carried_forward` to be added to its next request.

	`carried` maps farm -> credit owed from previous cycles and is ADDED to the
	request to form the basis the split is proportional to (balanced mode only).
	Negative values are debits and are honoured the same way.

	Raises ValueError on a non-positive step, because "distribute in units of
	zero" has no meaning and silently defaulting would hide a config mistake, and
	on an unknown mode, because guessing which policy the user meant is worse than
	stopping.
	"""
	if step <= 0:
		raise ValueError("step must be positive")
	if mode not in MODES:
		raise ValueError(f"mode must be one of {MODES}, got {mode!r}")

	balanced = mode == MODE_BALANCED
	carry_in = _carry(carried) if balanced else {}
	asked = {f: float(q) for f, q in (requests or {}).items() if float(q) > 0}
	reduced_total = max(0.0, float(reduced_total))

	# Basis = this cycle's ask + credit carried in, floored at zero. A debit
	# larger than the new request cannot make an allocation negative; the unspent
	# part of that debit stays outstanding rather than being written off.
	basis = {}
	unspent_debt = {}
	for farm, q in asked.items():
		b = q + carry_in.get(farm, 0.0)
		if b > 0:
			basis[farm] = b
		else:
			basis[farm] = 0.0
			unspent_debt[farm] = b  # ≤ 0

	participating = {f: b for f, b in basis.items() if b > 0}
	total_basis = sum(participating.values())

	def _result(allocs, remainder, distributed, credit_out):
		# Farms that did not participate keep their credit exactly as it was.
		forward = {f: c for f, c in carry_in.items() if f not in asked}
		forward.update(unspent_debt)
		forward.update(credit_out)
		return Apportionment(
			allocations=allocs,
			remainder=round(remainder, 9),
			step=step,
			distributed=distributed,
			carried_forward={
				f: round(c, 9) for f, c in forward.items()
				if abs(c) > CREDIT_EPSILON
			},
		)

	if not participating or total_basis <= 0 or reduced_total <= 0:
		# Nothing to split, or nobody with a positive basis. Credits stand.
		return _result((), reduced_total if participating else 0.0, 0.0, {})

	# Never hand out more than was asked for, however generous the budget. The
	# ask here is the basis, so a carried credit can be paid out on top of the
	# new request — that is the whole point of carrying it.
	distributable = min(reduced_total, total_basis)
	total_steps = _steps_in(distributable, step)

	if total_steps <= 0:
		# The whole amount is smaller than one measurable step. Nobody can be given a
		# measurable share, so it all waits in the general store — and in balanced
		# mode each farm's full share is owed forward.
		#
		# Rows are still returned, at zero. Every farm that asked appears in the
		# result, always: this is the case where the ENTIRE quantity is stranded, so
		# it is the case where "who asked, and what did they get?" most needs an
		# answer — and in simple mode there is no credit to carry that fact instead.
		credit_out = (
			{f: b / total_basis * distributable for f, b in participating.items()}
			if balanced
			else {}
		)
		empty = tuple(
			Allocation(
				farm=f,
				requested=asked[f],
				allocated=0.0,
				steps=0,
				basis=participating[f],
				credit_in=carry_in.get(f, 0.0),
				credit_out=round(credit_out.get(f, 0.0), 9),
			)
			for f in sorted(participating, key=lambda f: (-participating[f], f))
		)
		return _result(empty, reduced_total, 0.0, credit_out)

	exact = {f: total_steps * (b / total_basis) for f, b in participating.items()}
	# Tolerant floor again: an exact share of 10.0 can arrive as 9.999999999999998,
	# and truncating that would quietly cost the farm a whole step.
	whole = {
		f: int(math.floor(v + max(_STEP_TOL, abs(v) * _STEP_TOL)))
		for f, v in exact.items()
	}
	leftover = total_steps - sum(whole.values())

	if balanced and leftover > 0:
		# Hamilton: the biggest fractional parts get the spare steps. Ties go to
		# the larger basis, then alphabetically — deterministic, so the same
		# inputs always yield the same split and a rerun cannot reshuffle it.
		order = sorted(
			participating,
			key=lambda f: (-(exact[f] - whole[f]), -participating[f], f),
		)
		for farm in order[:leftover]:
			whole[farm] += 1

	# In simple mode nothing is owed: what did not divide evenly is simply left in
	# the general store, which is the entire promise of that mode.
	#
	# In balanced mode the credit is measured against the exact share of what was
	# DISTRIBUTABLE, not of the original request: the difference between those is
	# the GM's reduction, which is a decision and not a debt.
	credit_out = (
		{
			f: b / total_basis * distributable - whole[f] * step
			for f, b in participating.items()
		}
		if balanced
		else {}
	)

	allocations = tuple(
		Allocation(
			farm=f,
			requested=asked[f],
			# Rounded because `whole * step` accumulates float dust — 2.9000000000000004
			# would travel into a Stock Entry and a keeper's screen otherwise.
			allocated=round(whole[f] * step, 9),
			steps=whole[f],
			basis=participating[f],
			credit_in=carry_in.get(f, 0.0),
			credit_out=round(credit_out.get(f, 0.0), 9),
		)
		for f in sorted(participating, key=lambda f: (-participating[f], f))
	)
	distributed = sum(a.allocated for a in allocations)
	return _result(allocations, reduced_total - distributed, distributed, credit_out)


#: Sensible default allocation steps by UOM, in the item's stock UOM.
#:
#: The principle is physical: a store keeper can measure 10 g far more easily than
#: 1 g, and cannot split a bottle at all. These are defaults — a site should be
#: able to override them, and per-item overrides matter for anything packaged.
DEFAULT_STEPS = {
	"gram": 10.0,
	"g": 10.0,
	"ml": 10.0,
	"millilitre": 10.0,
	"milliliter": 10.0,
	"kg": 0.1,
	"kilogram": 0.1,
	"litre": 0.1,
	"liter": 0.1,
	"l": 0.1,
}

#: Anything countable rather than measurable is handed over whole.
WHOLE_UNIT_STEP = 1.0


def default_step_for_uom(uom: str | None) -> float:
	"""The allocation step for a UOM, falling back to whole units.

	Whole units are the safe fallback: handing over one of something is always
	possible, whereas guessing a fractional step for an unknown UOM could produce
	an allocation nobody can physically measure out.
	"""
	return DEFAULT_STEPS.get((uom or "").strip().lower(), WHOLE_UNIT_STEP)
