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

## What it will and will not do

A name is redirected only when it has **no beds of its own** and **exactly one**
same-name twin has them. Two populated twins, or none, are left alone: a capture
filed under the wrong physical house is worse than one that is refused, and a
refusal is at least visible.

## Why it costs nothing per entry

The map is built once from two cheap queries and cached, then applied in memory
to a whole posted batch. A 30-entry upload does not make 30 lookups — it makes
none, because the map is already in Redis. That matters: this runs on the path a
scout waits on with a phone in their hand at the edge of coverage.

This is a repair for a data fault, not a feature. Every redirect is logged so the
duplicate records can eventually be merged and this can be deleted.
"""

from __future__ import annotations

import re

import frappe

#: An hour is long enough to spare the queries and short enough that merging the
#: duplicate records shows up the same morning.
_CACHE_KEY = "scp:greenhouse_alias_map"
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
	canonical = mapping.get(given)
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
		if isinstance(e, dict) and mapping.get(e.get("greenhouse"))
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
	mapping = build_alias_map(_load_rows())
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
			if isinstance(e, dict) and mapping.get(e.get("greenhouse"))
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
