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

Pure functions: no Frappe, no database. Step sizes come from the caller.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Allocation:
	farm: str
	requested: float
	#: What this farm gets, always a whole multiple of the step.
	allocated: float
	#: Whole steps allocated — handy for explaining the result in the UI.
	steps: int


@dataclass(frozen=True)
class Apportionment:
	allocations: tuple[Allocation, ...]
	#: Left in the general store: the part of the reduced total that cannot be
	#: expressed in whole steps.
	remainder: float
	step: float
	#: The total actually handed out (sum of allocations).
	distributed: float


def apportion(
	requests: dict[str, float],
	reduced_total: float,
	step: float,
) -> Apportionment:
	"""Split `reduced_total` across `requests` in whole multiples of `step`.

	`requests` maps farm -> originally requested quantity. Farms requesting zero
	or less are ignored: they asked for nothing, so they are owed nothing.

	Raises ValueError on a non-positive step, because "distribute in units of
	zero" has no meaning and silently defaulting would hide a config mistake.
	"""
	if step <= 0:
		raise ValueError("step must be positive")

	wanted = {f: float(q) for f, q in (requests or {}).items() if float(q) > 0}
	total_requested = sum(wanted.values())
	reduced_total = max(0.0, float(reduced_total))

	if not wanted or total_requested <= 0 or reduced_total <= 0:
		return Apportionment((), reduced_total if wanted else 0.0, step, 0.0)

	# Never hand out more than was asked for, however generous the budget.
	distributable = min(reduced_total, total_requested)
	total_steps = int(distributable // step)

	if total_steps <= 0:
		# The whole amount is smaller than one measurable step. Nobody can be
		# given a measurable share, so it all waits in the general store.
		return Apportionment((), reduced_total, step, 0.0)

	exact = {f: total_steps * (q / total_requested) for f, q in wanted.items()}
	whole = {f: int(v) for f, v in exact.items()}
	leftover = total_steps - sum(whole.values())

	if leftover > 0:
		# Hamilton: the biggest fractional parts get the spare steps. Ties go to
		# the larger original request, then alphabetically — deterministic, so the
		# same inputs always yield the same split and a rerun cannot reshuffle it.
		order = sorted(
			wanted,
			key=lambda f: (-(exact[f] - whole[f]), -wanted[f], f),
		)
		for farm in order[:leftover]:
			whole[farm] += 1

	allocations = tuple(
		Allocation(farm=f, requested=wanted[f], allocated=whole[f] * step, steps=whole[f])
		for f in sorted(wanted, key=lambda f: (-wanted[f], f))
	)
	distributed = sum(a.allocated for a in allocations)
	return Apportionment(
		allocations=allocations,
		remainder=round(reduced_total - distributed, 9),
		step=step,
		distributed=distributed,
	)


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
