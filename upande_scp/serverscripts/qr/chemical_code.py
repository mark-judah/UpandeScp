"""The traceable chemical label code: a 33-digit numeric string.

Encodes *which label, of what, how much, for which plan* so a scan can be taken
apart segment by segment — and so the server can refuse a label that belongs to a
different plan, or to a transfer that was cancelled.

    2 26 0002406 0347 00225 005200 84915177
    │  │     │     │     │     │       └──── 8  random
    │  │     │     │     │     └──────────── 6  Work Order numeric tail
    │  │     │     │     └────────────────── 5  quantity × 100
    │  │     │     └──────────────────────── 4  item surrogate
    │  │     └────────────────────────────── 7  label serial (v2) / SE tail (v1)
    │  └──────────────────────────────────── 2  year (YY)
    └─────────────────────────────────────── 1  format version

**Why 33 digits, and why numeric.** QR numeric mode packs three digits into ten bits,
so 33 digits fits a **version-1 (21×21)** symbol at **ECC-M**, whose capacity is 34.
Today's text payload also lands at v1 but at ECC-L, the weakest error correction. Same
module count, double the damage tolerance — and what ruins a label in a chemical store
is smudging, not resolution. At the smallest label tier (18 mm) a v1 symbol prints
6.9 printer dots per module on a 203 dpi ZQ520.

**Why slot 3 is a serial we allocate (v2).** It used to be the Stock Entry's numeric
tail. That number belongs to Frappe's naming counter, which nobody here controls: when
the `MAT-STE-2026-` series was repaired by jumping it to 100,000,000, every new entry
got a nine-digit tail, the seven-digit slot overflowed, and every label was silently
skipped. A borrowed number can move by a hundred million overnight. Ours cannot — it
is dense, starts at 1, and only advances when a label is actually minted. Seven digits
of a counter we own is ten million labels; at the site's rate that is millennia, where
seven digits of a counter we borrow lasted eight months.

The slot was always only *informative* — see "what is deliberately absent" below — so
nothing that verifies a scan changed. Only the number in it, and what it is called.

**Layouts are versioned, and old codes keep working.** `LAYOUTS` maps a format version
to its segments, and `decode` picks the layout from the code's own first digit. A
sticker printed under v1 is still readable after v2 ships, which is the whole reason
the version digit is first. Every layout is the same length: the physical symbol must
not change size under a label that is already on a shelf.

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

#: The current layout. `decode` reads any version in LAYOUTS; `encode` writes this one.
CURRENT_VERSION = 2

#: Format version -> (name, width) in order. The sum is the code length.
#:
#: v1 carried the Stock Entry's numeric tail in slot 3. v2 carries a label serial we
#: allocate ourselves, because that tail is Frappe's number and it moved by a hundred
#: million when a naming series was repaired. Same widths, same length: a v2 sticker is
#: physically identical to a v1 one, so nothing about printing or scanning changes.
LAYOUTS: dict[int, tuple[tuple[str, int], ...]] = {
	1: (
		("version", 1), ("year", 2), ("ref", 7), ("item_id", 4),
		("qty_x100", 5), ("wo_tail", 6), ("random", 8),
	),
	2: (
		("version", 1), ("year", 2), ("ref", 7), ("item_id", 4),
		("qty_x100", 5), ("wo_tail", 6), ("random", 8),
	),
}

#: What slot 3 means, per version — so a refused scan can name it correctly instead of
#: calling a label serial a stock entry.
REF_KIND: dict[int, str] = {1: "stock entry", 2: "label"}

LAYOUT = LAYOUTS[CURRENT_VERSION]

#: Kept as the name callers already import. It is the version we *write*;
#: `decode` reads every version in LAYOUTS.
VERSION = CURRENT_VERSION
CODE_LENGTH = sum(width for _, width in LAYOUT)

#: v1 at ECC-M holds 34 numeric digits. Asserted at import: a layout edit that
#: silently costs every label its error correction should not be possible.
_V1_ECC_M_NUMERIC_CAPACITY = 34
assert CODE_LENGTH <= _V1_ECC_M_NUMERIC_CAPACITY, (
	f"code is {CODE_LENGTH} digits; over {_V1_ECC_M_NUMERIC_CAPACITY} every label "
	"drops to QR v2 at ECC-M"
)

#: Every layout must be the same length. A shorter or longer one would change the
#: symbol size, and `looks_like_code` could no longer tell our codes from anything else
#: by length alone — so an old sticker would stop scanning the day a new layout shipped.
for _v, _layout in LAYOUTS.items():
	assert sum(w for _, w in _layout) == CODE_LENGTH, (
		f"layout v{_v} is {sum(w for _, w in _layout)} digits, not {CODE_LENGTH}"
	)
	assert _layout[0] == ("version", 1), f"layout v{_v} must open with the version digit"

#: How full slot 3 may get before we start saying so. The whole point of owning the
#: counter is that this should never fire; if it does, the layout needs a wider slot
#: and that is a new version, not a surprise at print time.
REF_HEADROOM_WARN_AT = 0.9

#: Quantities are carried at two decimals: of 1051 chemical stock-entry lines on
#: kaitet, none needed a third.
QTY_SCALE = 100

#: Written into `qty_x100` when the real quantity will not fit five digits (over
#: 9,999.99). Means "read it from the document" — safe, because the document is the
#: authority on scan regardless. A transfer that large is not a real case; the
#: sentinel exists so an unexpected one degrades instead of encoding a wrong number.
QTY_OVERFLOW = 99999

_WIDTHS = dict(LAYOUT)


def widths(version: int = CURRENT_VERSION) -> dict[str, int]:
	"""Segment widths for a layout, so a caller can size a value before minting it."""
	return dict(LAYOUTS[version])


def ref_capacity(version: int = CURRENT_VERSION) -> int:
	"""How many distinct values slot 3 can hold in this layout."""
	return 10 ** dict(LAYOUTS[version])["ref"]


class CodeError(ValueError):
	"""A code that cannot be read as this layout."""


@dataclass(frozen=True)
class ChemicalCode:
	"""One decoded label code."""

	version: int
	year: int
	#: Slot 3. A label serial from v2 on; the Stock Entry's numeric tail in v1.
	#: Read `ref_kind` before showing it to anyone.
	ref: int
	item_id: int
	qty_x100: int
	wo_tail: int
	random: int

	@property
	def ref_kind(self) -> str:
		"""What slot 3 holds in this code's own layout."""
		return REF_KIND.get(self.version, "reference")

	@property
	def serial(self) -> int | None:
		"""The label serial, or None for a layout that did not carry one."""
		return self.ref if self.ref_kind == "label" else None

	@property
	def se_tail(self) -> int | None:
		"""The Stock Entry tail, or None for a layout that did not carry one.

		v1 only. The row named by the code is the authority on which Stock Entry a
		label belongs to, in every layout.
		"""
		return self.ref if self.ref_kind == "stock entry" else None

	@property
	def code(self) -> str:
		"""Re-encode exactly, without a second rounding pass over the quantity."""
		return encode(
			year=self.year,
			ref=self.ref,
			item_id=self.item_id,
			qty_x100=self.qty_x100,
			wo_tail=self.wo_tail,
			rand=self.random,
			version=self.version,
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
		ref = (
			f"label #{self.ref}" if self.ref_kind == "label"
			else f"stock entry …{self.ref}"
		)
		return (
			f"v{self.version} · year 20{self.year:02d} · {ref} · "
			f"item #{self.item_id} · qty {qty} · work order …{self.wo_tail}"
		)


def _fit(name: str, value: int, layout_widths: dict[str, int] | None = None) -> str:
	width = (layout_widths or _WIDTHS)[name]
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
	ref: int,
	item_id: int,
	wo_tail: int,
	qty=None,
	qty_x100: int | None = None,
	rand: int | None = None,
	rng: random.Random | None = None,
	version: int = CURRENT_VERSION,
) -> str:
	"""Build a code. Pass `rand` (or an `rng`) to make it reproducible.

	`ref` is slot 3 — the label serial. `qty` is the real quantity and is scaled here;
	`qty_x100` sets the field directly and wins when both are given, which is how a
	decoded code re-encodes itself without a second rounding pass.

	`version` exists so a decoded v1 code can rebuild itself byte for byte. New codes
	should take the default.
	"""
	try:
		layout = LAYOUTS[version]
	except KeyError:
		raise CodeError(f"there is no layout v{version}") from None
	layout_widths = dict(layout)

	if qty_x100 is None:
		qty_x100 = encode_qty(qty)
	if rand is None:
		source = rng or random.SystemRandom()
		rand = source.randrange(10 ** layout_widths["random"])

	parts = {
		"version": version,
		"year": int(year) % 100,
		"ref": ref,
		"item_id": item_id,
		"qty_x100": qty_x100,
		"wo_tail": wo_tail,
		"random": rand,
	}
	return "".join(_fit(name, parts[name], layout_widths) for name, _ in layout)


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
		# Any layout we can read. A sticker printed under an older version is still
		# one of ours, and refusing it would strand labels already on the shelf.
		and int(text[0]) in LAYOUTS
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

	# The version digit comes first precisely so it can be read before anything else
	# is assumed about the layout. That is what lets a v1 sticker keep scanning after
	# v2 ships.
	version = int(text[0])
	layout = LAYOUTS.get(version)
	if layout is None:
		raise CodeError(
			f"code format v{version} is not one this app can read "
			f"(it knows {', '.join('v%d' % v for v in sorted(LAYOUTS))}); it was made "
			"by a newer version of the app"
		)

	values: dict[str, int] = {}
	at = 0
	for name, width in layout:
		values[name] = int(text[at : at + width])
		at += width
	return ChemicalCode(**values)


#: An ERPNext amendment suffix is short (``-1``, ``-2``). Anything this long or
#: shorter at the end of a name, when the name has other numeric parts, is treated as
#: an amendment rather than the serial.
_AMENDMENT_SUFFIX_MAX_DIGITS = 2


def numeric_tail(docname: str | None, width: int | None = None) -> int:
	"""The serial number in a document name, optionally kept to `width` digits.

	``SE-2026-2562406`` → 2562406, and ``MFG-WO-2026-05200-1`` → **5200**, not 1:
	naively taking the trailing digits would report the amendment counter as the work
	order number, and 14 work orders on kaitet already carry a ``-1``.

	The amendment itself is not encoded — the stored ``Chemical QR Label`` row names
	the exact document, so this segment only has to be readable by a person.

	Pass `width` for a segment that must fit no matter what the number does. A document
	number is not ours: the ``MAT-STE-2026-`` counter was repaired by jumping it to
	100,000,000, and a seven-digit slot that had held every name for years began
	refusing all of them overnight — which silently cost every transfer its label.
	Keeping the low-order digits is what the label already claims to show, since it
	renders as ``work order …5200``, and a wrong-looking hint on a sticker is far
	cheaper than no sticker at all. The row is the authority either way.
	"""
	if not docname:
		return 0
	parts = [p for p in str(docname).split("-") if p.isdigit()]
	if not parts:
		return 0
	if len(parts) > 1 and len(parts[-1]) <= _AMENDMENT_SUFFIX_MAX_DIGITS:
		parts = parts[:-1]
	value = int(parts[-1])
	return value % (10 ** width) if width else value


def name_year(docname: str | None) -> int:
	"""The 4-digit year in a document name, as YY. 0 when there is none."""
	if not docname:
		return 0
	import re

	found = re.findall(r"(20\d{2})", str(docname))
	return int(found[0]) % 100 if found else 0
