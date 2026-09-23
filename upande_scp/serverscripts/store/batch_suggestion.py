"""Which batch the store should issue, chosen for the storesman rather than by him.

Since batch tracking was switched on for the chemicals — 533 items now carry
`has_batch_no` — a Material Transfer for Manufacture cannot be submitted until
every outgoing row names a batch, and nothing in SCP ever set one. So the job
landed on the person at the counter: open the draft, open each row, read a list
of batch codes that all look alike, and guess. The transfers that did go out
often carried the wrong batch; the ones that did not are sitting as drafts.

Picking a batch is not a judgement call, though. It is **first-expiry-first-out**:
issue what will go off soonest, and among equals issue the oldest stock. That is
what a store is supposed to do with agrochemicals, and it is exactly the rule a
person is worst at applying across thirty rows at five in the morning.

So the machine proposes and the storesman disposes. Every suggestion is a
default he can change, and each one arrives with the numbers behind it — how much
is in that batch, when it expires, how old it is — so the choice he is being
offered is legible instead of magic.

## The rules, and why each one

* **Expiry first, then age, then batch code.** FEFO is the store's rule. Age
  breaks the tie so two batches expiring the same day still come out in a stable
  order, and the code breaks that one so the same draft always suggests the same
  thing twice running.
* **A batch with no expiry sorts last.** Not first: an undated batch is usually a
  data gap, and preferring it would quietly drain the stock nobody has recorded
  properly while dated stock expires on the shelf.
* **Already expired is never suggested.** It can still be chosen by hand — the
  storesman may be disposing of it deliberately — but nothing here proposes it.
* **Short is reported, not hidden.** When the batches cannot cover the row, the
  suggestion says how much is missing rather than silently filling part of it.
  A row that looks answered but is not is worse than one that is visibly short.
* **A row that already names a batch is left alone.** This fills blanks; it does
  not overrule a person who has already decided.
* **A migration placeholder is proposed only when nothing real is left.** The
  `-PREMIGRATION` batches never run out, so any rule that asks "is there
  enough?" picks them every time — and did, 5,213 rows running. They sort behind
  every real batch and are labelled as what they are, but they are not hidden:
  sometimes the placeholder is genuinely all the store has on the system.

Pure by design: everything here takes plain dicts, so the rule can be read and
tested without a warehouse, a stock ledger or a site.
"""

from __future__ import annotations

# A date far past anything real, so "no expiry" sorts after every dated batch
# without needing a second comparison key or a None-safe comparator.
_NO_EXPIRY = "9999-12-31"

#: Opening-stock batches the v15→v16 migration invented so that nothing would
#: block while the real batches were still being loaded. They are not stock: on
#: live there are 1,971 of them holding 2.87 trillion units between them, and
#: because they never run out they win any rule that merely asks "is there
#: enough?". In the forty-five days before this was written, every transfer row
#: that carried a batch at all carried one of these — 5,213 rows, against not a
#: single real batch — which is what "we have not had the correct batch numbers"
#: turned out to mean.
_PLACEHOLDER_MARKERS = ("PREMIGRATION",)


def is_placeholder(batch_no) -> bool:
	"""A migration opening-stock batch rather than a delivery.

	Matched on the name because that is what the migration stamped and the only
	thing that reliably distinguishes them: the quantity is absurd but not
	uniformly so, and the Batch record otherwise looks ordinary.
	"""
	name = str(batch_no or "").upper()
	return any(marker in name for marker in _PLACEHOLDER_MARKERS)


def _as_date(value) -> str:
	"""A comparable ISO day string, or "" when there is nothing to compare."""
	if not value:
		return ""
	text = str(value)
	return text[:10] if len(text) >= 10 else text


def rank_batches(batches, today: str) -> list:
	"""Available batches, best to issue first.

	`batches` is an iterable of ``{"batch_no", "qty", "expiry_date", "created"}``;
	`qty` is what is actually available in the source warehouse, not what the
	batch once held. Batches with nothing left, and batches already expired, are
	dropped rather than ranked — a suggestion the storesman has to undo is worse
	than no suggestion.
	"""
	live = []
	for b in batches or []:
		if not b or not b.get("batch_no"):
			continue
		try:
			qty = float(b.get("qty") or 0)
		except (TypeError, ValueError):
			continue
		if qty <= 0:
			continue
		expiry = _as_date(b.get("expiry_date"))
		if expiry and today and expiry < today:
			continue  # already expired: choosable by hand, never proposed
		live.append(
			{
				"batch_no": b.get("batch_no"),
				"qty": qty,
				"expiry_date": expiry or None,
				"created": _as_date(b.get("created")),
				"placeholder": is_placeholder(b.get("batch_no")),
			}
		)

	return sorted(
		live,
		key=lambda b: (
			b["placeholder"],                # real stock before migration filler
			b["expiry_date"] or _NO_EXPIRY,  # soonest to go off
			b["created"] or _NO_EXPIRY,      # then oldest stock
			b["batch_no"],                   # then stable
		),
	)


def allocate(required, batches, today: str) -> dict:
	"""Fill one row: which batches, how much from each, and what is missing.

	Returns ``{"picks": [{batch_no, qty, expiry_date}], "allocated", "short"}``.

	A single row on a Stock Entry carries one `batch_no`, so the caller normally
	uses the first pick and splits the row when there is more than one. The whole
	allocation is returned regardless, because the storesman needs to see that
	his 40 litres is coming out of three batches before he agrees to it.
	"""
	try:
		need = float(required or 0)
	except (TypeError, ValueError):
		need = 0.0

	picks = []
	remaining = need
	for b in rank_batches(batches, today):
		if remaining <= 0:
			break
		take = b["qty"] if b["qty"] < remaining else remaining
		picks.append(
			{"batch_no": b["batch_no"], "qty": take, "expiry_date": b["expiry_date"]}
		)
		remaining -= take

	# Float subtraction leaves crumbs; anything under a millilitre is covered.
	short = remaining if remaining > 1e-6 else 0.0
	return {"picks": picks, "allocated": need - short, "short": short}


def days_until(expiry, today: str):
	"""Whole days from `today` to `expiry`, negative when past. None if undated.

	For the info panel: "expires in 12 days" is a number a storesman acts on,
	where a date is one he has to do arithmetic on.
	"""
	from datetime import date

	expiry = _as_date(expiry)
	if not expiry or not today:
		return None
	try:
		a = date.fromisoformat(_as_date(today))
		b = date.fromisoformat(expiry)
	except ValueError:
		return None
	return (b - a).days


def describe(batch, today: str) -> dict:
	"""One batch, in the terms the panel shows it.

	`status` is the single word the row is coloured by. The thresholds are the
	store's, not arithmetic for its own sake: inside thirty days a chemical needs
	using or moving, and that is the point at which the storesman wants to be
	told rather than to work it out.
	"""
	expiry = _as_date(batch.get("expiry_date")) if batch else ""
	days = days_until(expiry, today)
	placeholder = is_placeholder((batch or {}).get("batch_no"))
	if placeholder:
		# Said before anything else, because its expiry and quantity are both
		# fiction and reading them as facts is how it got issued 5,213 times.
		status = "placeholder"
	elif days is None:
		status = "undated"
	elif days < 0:
		status = "expired"
	elif days <= 30:
		status = "expiring"
	else:
		status = "ok"
	return {
		"batch_no": (batch or {}).get("batch_no"),
		"qty": float((batch or {}).get("qty") or 0),
		"expiry_date": expiry or None,
		"days_to_expiry": days,
		"placeholder": placeholder,
		"status": status,
	}
