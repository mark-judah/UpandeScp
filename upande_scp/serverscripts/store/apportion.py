"""Apportioning a reduced chemical quantity back to the farms that asked for it.

When the General Manager cuts a chemical's total — because that is what the budget
allows — the reduced quantity has to be split across the farms in proportion to
what each originally requested, in amounts a store keeper can physically measure.

Those two requirements fight each other, and the obvious resolution is wrong.
Rounding each farm's share DOWN to a measurable step starves the small ones: a
farm entitled to 4.5 g of a 10 g step gets nothing, and five such farms leave the
entire quantity sitting in the general store while everybody gets zero.

So: **largest-remainder (Hamilton) apportionment in step units.** Convert the
reduced total into whole steps, give each farm the whole steps its share earns,
then hand out the leftover steps one at a time to the farms with the largest
fractional parts. Properties that matter:

* never over-allocates — you cannot ship stock you do not have;
* every allocation is a whole number of steps, so it can be measured out;
* the split stays proportional, and small farms are not wiped out;
* deterministic — ties break on the larger original request, then farm name, so
  the same inputs always produce the same answer.

Whatever cannot be expressed in whole steps stays in the general store, for the
keeper to distribute on their own judgement.

## Carry-forward

That leftover is not written off. Every farm's *exact* share is a real number; its
allocation is a whole number of steps. The gap between the two is what the farm was
owed and could not be measured out, and it is **remembered as a credit** and added
to the farm's basis next cycle. Without it, a farm that repeatedly lands just under
a step is shorted every single cycle — the same small-farm starvation the Hamilton
split exists to prevent, arriving more slowly.

Two properties keep the credits honest:

* **They conserve.** The credits sum to exactly the stock left in the general
  store, so the pool always has an owner-by-owner explanation. A farm that the
  Hamilton pass rounded UP carries a negative credit — a debit — because it was
  paid ahead; forgiving that would mint entitlement out of nothing and the pool
  would stop reconciling.
* **A budget cut is not a credit.** If a farm asks for 10 and the GM's reduction
  leaves it 9, the missing 1 is a financial decision, not an unmeasurable
  fraction. Only the rounding residue carries. Otherwise every cut would silently
  return as next cycle's entitlement and the reduction would mean nothing.

A farm that requests nothing this cycle keeps its credit untouched rather than
being pushed stock it did not ask for.

Pure functions: no Frappe, no database. Step sizes and carried credits come from
the caller.
"""
from __future__ import annotations

from dataclasses import dataclass, field

#: Credits below this (in stock UOM) are treated as settled. Floating-point
#: residue like 1e-16 is not a debt, and carrying it forever would litter the
#: keeper's view with rows that mean nothing.
CREDIT_EPSILON = 1e-9


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
) -> Apportionment:
	"""Split `reduced_total` across `requests` in whole multiples of `step`.

	`requests` maps farm -> quantity requested this cycle. Farms requesting zero
	or less are ignored: they asked for nothing, so they get nothing now (any
	credit they hold is passed through untouched).

	`carried` maps farm -> credit owed from previous cycles, and is ADDED to the
	request to form the basis the split is proportional to. Negative values are
	debits and are honoured the same way.

	Raises ValueError on a non-positive step, because "distribute in units of
	zero" has no meaning and silently defaulting would hide a config mistake.
	"""
	if step <= 0:
		raise ValueError("step must be positive")

	carry_in = _carry(carried)
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
	total_steps = int(distributable // step)

	if total_steps <= 0:
		# The whole amount is smaller than one measurable step. Nobody can be
		# given a measurable share, so it all waits in the general store — and
		# each farm's full share is owed forward.
		credit_out = {
			f: b / total_basis * distributable
			for f, b in participating.items()
		}
		return _result((), reduced_total, 0.0, credit_out)

	exact = {f: total_steps * (b / total_basis) for f, b in participating.items()}
	whole = {f: int(v) for f, v in exact.items()}
	leftover = total_steps - sum(whole.values())

	if leftover > 0:
		# Hamilton: the biggest fractional parts get the spare steps. Ties go to
		# the larger basis, then alphabetically — deterministic, so the same
		# inputs always yield the same split and a rerun cannot reshuffle it.
		order = sorted(
			participating,
			key=lambda f: (-(exact[f] - whole[f]), -participating[f], f),
		)
		for farm in order[:leftover]:
			whole[farm] += 1

	# The credit is measured against the exact share of what was DISTRIBUTABLE,
	# not of the original request: the difference between them is the GM's
	# reduction, which is a decision and not a debt.
	credit_out = {
		f: b / total_basis * distributable - whole[f] * step
		for f, b in participating.items()
	}

	allocations = tuple(
		Allocation(
			farm=f,
			requested=asked[f],
			allocated=whole[f] * step,
			steps=whole[f],
			basis=participating[f],
			credit_in=carry_in.get(f, 0.0),
			credit_out=round(credit_out[f], 9),
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
