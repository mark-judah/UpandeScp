"""Filing a capture under the greenhouse that actually has the beds.

One physical greenhouse can exist twice in `tabWarehouse` under names that differ
only by whitespace — `Torongo GH18 - KR` and `Torongo GH 18 - KR`. On the live
site the spaced record holds 558 beds and 73,159 scouting entries; the other was
created later so stock could be posted against it, and has no beds at all.

A handset that cached the empty one cannot save anything. The `bed` field is a
Link whose name embeds the greenhouse, so every capture dies on Frappe's own
validation — `Could not find Bed: Torongo GH18 - KR - Bed 250` — and the scout
watches six days of work refuse to go. Both Warehouse records have to stay, since
one of them carries stock, so the pairing is recognised here instead.

Then the v15→v16 migration carried over only the spaced, bedded record and left
the stock-only one behind — and the repair stopped working exactly where it was
needed, because it was written to recognise a *pair* and there was no longer a
pair to recognise. Handsets holding the unspaced name kept posting it at a
greenhouse that no longer existed in any form: 1,600 rejections in three days,
and the trap counts inside them thrown away.

## What it will and will not do

A submitted name is redirected when it resolves to **exactly one** real
greenhouse, comparing without spaces or case. Exactly one record under that name
has beds — use it. No beds anywhere but only one record — use that, so an empty
greenhouse fails on its own missing beds rather than being sent somewhere
inventive. Two populated twins — refuse, and go on refusing. A capture filed
under the wrong physical house is worse than one that is refused, and a refusal
is at least visible.

## Why it costs nothing per entry

The map is built once from two cheap queries and cached, then applied in memory
to a whole posted batch. A 30-entry upload does not make 30 lookups — it makes
none, because the map is already in Redis. That matters: this runs on the path a
scout waits on with a phone in their hand at the edge of coverage.

This is a repair for a data fault, not a feature. Every redirect is logged so the
duplicate records can eventually be merged, the handsets re-cached, and this
deleted.
"""

from __future__ import annotations

import re

import frappe

#: An hour is long enough to spare the queries and short enough that merging the
#: duplicate records shows up the same morning.
_CACHE_KEY = "scp:greenhouse_resolution_index_v2"
_CACHE_TTL = 3600


def squash(name) -> str:
	"""The comparison key: no whitespace, no case.

	`Torongo GH18 - KR`, `Torongo GH 18 - KR` and `TORONGO gh18 - kr` are one
	greenhouse typed three ways.
	"""
	return re.sub(r"\s+", "", str(name or "")).lower()


def build_alias_map(rows) -> dict:
	"""`{bedless_name: bedded_name}` for every unambiguous pair.

	Pure — `rows` is an iterable of `{"name", "beds"}`, so the rule can be read
	and tested without a database.
	"""
	by_key: dict[str, list] = {}
	for row in rows or []:
		key = squash(row.get("name"))
		if key:
			by_key.setdefault(key, []).append(row)

	out: dict[str, str] = {}
	for group in by_key.values():
		if len(group) < 2:
			continue
		bedded = [g for g in group if (g.get("beds") or 0) > 0]
		# Exactly one home for the beds, or we do not guess.
		if len(bedded) != 1:
			continue
		target = bedded[0].get("name")
		for g in group:
			if (g.get("beds") or 0) == 0 and g.get("name") != target:
				out[g["name"]] = target
	return out


def build_resolution_index(rows) -> dict:
	"""`{squash_key: the one greenhouse that key may mean}`.

	A generalisation of `build_alias_map`, and the one that actually fires on the
	live site. The pairing rule needed BOTH records present in `tabWarehouse` to
	recognise a twin — and the v15→v16 migration carried over only the bedded
	`Torongo GH 18 - KR`, leaving the stock-only `Torongo GH18 - KR` behind. So
	the map built nothing, while handsets that had cached the unspaced name went
	on posting it into a void: 1,600 rejections in three days, around thirty-seven
	real trap captures with FCM counts in them, refused over one space.

	Requiring the twin was never the point. The point is that a submitted name
	must land on **exactly one** real greenhouse. Keying by the squashed name says
	that directly, and covers the vanished-twin case more safely than the paired
	one, because there is nothing left to be ambiguous with.

	The rule, in order:

	* exactly one record under this key has beds — that one, whatever the others;
	* otherwise exactly one record exists at all — that one, even with no beds,
	  because inventing a different target for an empty greenhouse would hide a
	  separate fault behind this one;
	* otherwise nothing. Two populated twins stay ambiguous and stay refused.

	Pure: `rows` is an iterable of `{"name", "beds"}`.
	"""
	by_key: dict[str, list] = {}
	for row in rows or []:
		key = squash(row.get("name"))
		if key:
			by_key.setdefault(key, []).append(row)

	out: dict[str, str] = {}
	for key, group in by_key.items():
		bedded = [g for g in group if (g.get("beds") or 0) > 0]
		if len(bedded) == 1:
			out[key] = bedded[0].get("name")
		elif len(group) == 1:
			out[key] = group[0].get("name")
		# Several bedded twins, or several empty ones: we do not guess.
	return out


def resolve_name(name, index: dict):
	"""The real greenhouse this submitted name means, or None to let it fail.

	None is a deliberate outcome, not a gap: a capture filed under the wrong
	physical greenhouse is worse than one that is refused, and a refusal is at
	least visible in the error log.
	"""
	key = squash(name)
	if not key:
		return None
	return (index or {}).get(key)


def _canonical_for(given, mapping: dict):
	"""What `given` should become, or None to leave it alone.

	Reads either shape of map: the original `{bedless_name: bedded_name}` pairing
	and the `{squash_key: name}` index. Their key spaces do not collide — one
	holds real names with spaces, the other holds names with the spaces taken
	out — so a single lookup can serve both and callers need not care which they
	were handed.
	"""
	if not mapping or not given:
		return None
	canonical = mapping.get(given) or mapping.get(squash(given))
	if not canonical or canonical == given:
		return None
	return canonical


def rewrite_entry(entry, mapping: dict):
	"""A capture, filed under the greenhouse that has the beds.

	The greenhouse and the bed move together: the bed's name carries the
	greenhouse's, so redirecting one and not the other only changes which half is
	wrong. A bed that does not start with the greenhouse is left as it is — that
	is a naming convention this code does not know.
	"""
	if not mapping or not isinstance(entry, dict):
		return entry
	given = entry.get("greenhouse")
	canonical = _canonical_for(given, mapping)
	if not canonical:
		return entry

	out = dict(entry)
	out["greenhouse"] = canonical
	bed = entry.get("bed")
	if isinstance(bed, str) and bed.startswith(given):
		out["bed"] = canonical + bed[len(given):]
	return out


def rewrite_batch(batch, mapping: dict):
	"""The whole posted batch in one pass. Returns the original when nothing moves."""
	if not mapping or not batch:
		return batch
	return [rewrite_entry(e, mapping) for e in batch]


def count_redirects(batch, mapping: dict) -> int:
	"""How many entries this map would move — for the log line."""
	if not mapping or not batch:
		return 0
	return sum(
		1
		for e in batch
		if isinstance(e, dict) and _canonical_for(e.get("greenhouse"), mapping)
	)


def _load_rows() -> list:
	"""Every live warehouse, and whether it holds any beds.

	Two flat queries rather than a correlated subquery per warehouse: the bed
	table is large and this runs behind a cache, but it still runs on a request a
	scout is waiting on when the cache is cold.
	"""
	names = frappe.get_all(
		"Warehouse", filters={"disabled": 0}, pluck="name", limit_page_length=0
	)
	bedded = {
		row[0]
		for row in frappe.db.sql("SELECT DISTINCT greenhouse FROM `tabBed`")
		if row and row[0]
	}
	return [{"name": n, "beds": 1 if n in bedded else 0} for n in names]


def alias_map(force: bool = False) -> dict:
	"""The cached map. Empty on a site with no duplicates, which is the norm."""
	cache = frappe.cache()
	if not force:
		cached = cache.get_value(_CACHE_KEY)
		if cached is not None:
			return cached
	mapping = build_resolution_index(_load_rows())
	cache.set_value(_CACHE_KEY, mapping, expires_in_sec=_CACHE_TTL)
	return mapping


def clear_cache() -> None:
	"""Drop the map — called when a Warehouse is created or renamed."""
	frappe.cache().delete_value(_CACHE_KEY)


def apply_to_batch(batch):
	"""Redirect a posted batch, logging what moved. Returns the batch to save.

	Never raises: a capture that could have been saved must not be lost because
	the repair for somebody else's duplicate went wrong.
	"""
	try:
		mapping = alias_map()
		moved = count_redirects(batch, mapping)
		if not moved:
			return batch
		names = sorted({
			e.get("greenhouse") for e in batch
			if isinstance(e, dict) and _canonical_for(e.get("greenhouse"), mapping)
		})
		frappe.logger("scp_greenhouse_alias").info(
			f"redirected {moved} capture(s) from duplicate greenhouse(s) {names} "
			f"to the records holding the beds"
		)
		return rewrite_batch(batch, mapping)
	except Exception:
		frappe.logger("scp_greenhouse_alias").warning(
			"alias resolution failed; posting the batch unchanged", exc_info=True
		)
		return batch


def clear_cache_on_event(doc=None, method=None) -> None:
	"""Doc-event shim: a Warehouse changing can create or resolve a duplicate."""
	clear_cache()
