"""The traceable chemical label code: a 33-digit numeric string.

Encodes *which transfer, of what, how much, for which plan* so a scan can be taken
apart segment by segment — and so the server can refuse a label that belongs to a
different plan, or to a transfer that was cancelled.

    1 26 2562406 0347 00225 005200 84915177
    │  │     │     │     │     │       └──── 8  random
    │  │     │     │     │     └──────────── 6  Work Order numeric tail
    │  │     │     │     └────────────────── 5  quantity × 100
    │  │     │     └──────────────────────── 4  item surrogate
    │  │     └────────────────────────────── 7  Stock Entry numeric tail
    │  └──────────────────────────────────── 2  year (YY)
    └─────────────────────────────────────── 1  format version

**Why 33 digits, and why numeric.** QR numeric mode packs three digits into ten bits,
so 33 digits fits a **version-1 (21×21)** symbol at **ECC-M**, whose capacity is 34.
Today's text payload also lands at v1 but at ECC-L, the weakest error correction. Same
module count, double the damage tolerance — and what ruins a label in a chemical store
is smudging, not resolution. At the smallest label tier (18 mm) a v1 symbol prints
6.9 printer dots per module on a 203 dpi ZQ520.

The one spare digit is not the future-proofing; the leading **format version** is. A
later layout may use all 34 digits or change shape entirely, and old codes stay
readable because their first digit says which layout they are.

**What is deliberately absent.** No Stock Entry naming series (two are live on kaitet,
``MAT-STE-…`` and ``SE-…``), no amendment suffix, no line index, and no HMAC. Each code
is stored as a ``Chemical QR Label`` row named by the code itself, so the digits only
have to be *informative* — the row names the exact document. That also replaces the
HMAC: forging a code means producing one that exists as a row, which is the same
property a random token has, with no key to distribute or leave on a mobile device.

Pure functions: no Frappe, no database. Randomness is injected so the caller can make
it deterministic in tests.
"""
from __future__ import annotations

import random
from dataclasses import dataclass

#: Bump when the layout changes. Old codes keep their own version digit, so a reader
#: can always tell which layout it is looking at.
VERSION = 1

#: (name, width) in order. The sum is the code length; keep it ≤ 34 or every label
#: tips from QR v1 to v2 at ECC-M.
LAYOUT: tuple[tuple[str, int], ...] = (
	("version", 1),
	("year", 2),
	("se_tail", 7),
	("item_id", 4),
	("qty_x100", 5),
	("wo_tail", 6),
	("random", 8),
)

CODE_LENGTH = sum(width for _, width in LAYOUT)

#: v1 at ECC-M holds 34 numeric digits. Asserted at import: a layout edit that
#: silently costs every label its error correction should not be possible.
_V1_ECC_M_NUMERIC_CAPACITY = 34
assert CODE_LENGTH <= _V1_ECC_M_NUMERIC_CAPACITY, (
	f"code is {CODE_LENGTH} digits; over {_V1_ECC_M_NUMERIC_CAPACITY} every label "
	"drops to QR v2 at ECC-M"
)

#: Quantities are carried at two decimals: of 1051 chemical stock-entry lines on
#: kaitet, none needed a third.
QTY_SCALE = 100

#: Written into `qty_x100` when the real quantity will not fit five digits (over
#: 9,999.99). Means "read it from the document" — safe, because the document is the
#: authority on scan regardless. A transfer that large is not a real case; the
#: sentinel exists so an unexpected one degrades instead of encoding a wrong number.
QTY_OVERFLOW = 99999

_WIDTHS = dict(LAYOUT)


class CodeError(ValueError):
	"""A code that cannot be read as this layout."""


@dataclass(frozen=True)
class ChemicalCode:
	"""One decoded label code."""

	version: int
	year: int
	se_tail: int
	item_id: int
	qty_x100: int
	wo_tail: int
	random: int

	@property
	def code(self) -> str:
		"""Re-encode exactly, without a second rounding pass over the quantity."""
		return encode(
			year=self.year,
			se_tail=self.se_tail,
			item_id=self.item_id,
			qty_x100=self.qty_x100,
			wo_tail=self.wo_tail,
			rand=self.random,
		)

	@property
	def qty(self) -> float:
		"""The encoded quantity, or -1.0 when it overflowed the field."""
		if self.qty_overflowed:
			return -1.0
		return self.qty_x100 / QTY_SCALE

	@property
	def qty_overflowed(self) -> bool:
		return self.qty_x100 == QTY_OVERFLOW

	def describe(self) -> str:
		"""Human-readable breakdown — what the operator sees when a scan is refused."""
		qty = "see document" if self.qty_overflowed else f"{self.qty:g}"
		return (
			f"v{self.version} · year 20{self.year:02d} · stock entry …{self.se_tail} · "
			f"item #{self.item_id} · qty {qty} · work order …{self.wo_tail}"
		)


def _fit(name: str, value: int) -> str:
	width = _WIDTHS[name]
	value = int(value)
	if value < 0:
		raise CodeError(f"{name} cannot be negative, got {value}")
	text = str(value)
	if len(text) > width:
		raise CodeError(
			f"{name}={value} needs {len(text)} digits but the layout allows {width}"
		)
	return text.zfill(width)


def encode_qty(qty) -> int:
	"""Quantity → the integer that goes in the field, or the overflow sentinel."""
	try:
		scaled = int(round(float(qty) * QTY_SCALE))
	except (TypeError, ValueError):
		return QTY_OVERFLOW
	if scaled < 0 or scaled >= QTY_OVERFLOW:
		return QTY_OVERFLOW
	return scaled


def encode(
	*,
	year: int,
	se_tail: int,
	item_id: int,
	wo_tail: int,
	qty=None,
	qty_x100: int | None = None,
	rand: int | None = None,
	rng: random.Random | None = None,
) -> str:
	"""Build a code. Pass `rand` (or an `rng`) to make it reproducible.

	`qty` is the real quantity and is scaled here; `qty_x100` sets the field directly
	and wins when both are given, which is how a decoded code re-encodes itself
	without a second rounding pass.
	"""
	if qty_x100 is None:
		qty_x100 = encode_qty(qty)
	if rand is None:
		source = rng or random.SystemRandom()
		rand = source.randrange(10 ** _WIDTHS["random"])

	parts = {
		"version": VERSION,
		"year": int(year) % 100,
		"se_tail": se_tail,
		"item_id": item_id,
		"qty_x100": qty_x100,
		"wo_tail": wo_tail,
		"random": rand,
	}
	return "".join(_fit(name, parts[name]) for name, _ in LAYOUT)


def looks_like_code(payload: str | None) -> bool:
	"""Whether this payload is one of our codes at all.

	Used to tell a new label from a legacy ``"Score 250 EC\\n10 L"`` one, so the old
	ones can be accepted-but-unverified rather than rejected on the day this ships.
	"""
	if not payload:
		return False
	text = str(payload).strip()
	return (
		len(text) == CODE_LENGTH
		and text.isdigit()
		and int(text[0]) == VERSION
	)


def decode(payload: str) -> ChemicalCode:
	"""Read a code apart, segment by segment. Raises CodeError on anything else."""
	if payload is None:
		raise CodeError("no code given")
	text = str(payload).strip()
	if not text.isdigit():
		raise CodeError("a label code is digits only")
	if len(text) != CODE_LENGTH:
		raise CodeError(
			f"a label code is {CODE_LENGTH} digits, got {len(text)}"
		)

	values: dict[str, int] = {}
	at = 0
	for name, width in LAYOUT:
		values[name] = int(text[at : at + width])
		at += width

	if values["version"] != VERSION:
		raise CodeError(
			f"code format v{values['version']} is not v{VERSION}; it was made by a "
			"different version of the app"
		)
	return ChemicalCode(**values)


#: An ERPNext amendment suffix is short (``-1``, ``-2``). Anything this long or
#: shorter at the end of a name, when the name has other numeric parts, is treated as
#: an amendment rather than the serial.
_AMENDMENT_SUFFIX_MAX_DIGITS = 2


def numeric_tail(docname: str | None) -> int:
	"""The serial number in a document name.

	``SE-2026-2562406`` → 2562406, and ``MFG-WO-2026-05200-1`` → **5200**, not 1:
	naively taking the trailing digits would report the amendment counter as the work
	order number, and 14 work orders on kaitet already carry a ``-1``.

	The amendment itself is not encoded — the stored ``Chemical QR Label`` row names
	the exact document, so this segment only has to be readable by a person.
	"""
	if not docname:
		return 0
	parts = [p for p in str(docname).split("-") if p.isdigit()]
	if not parts:
		return 0
	if len(parts) > 1 and len(parts[-1]) <= _AMENDMENT_SUFFIX_MAX_DIGITS:
		parts = parts[:-1]
	return int(parts[-1])


def name_year(docname: str | None) -> int:
	"""The 4-digit year in a document name, as YY. 0 when there is none."""
	if not docname:
		return 0
	import re

	found = re.findall(r"(20\d{2})", str(docname))
	return int(found[0]) % 100 if found else 0
