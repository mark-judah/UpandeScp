"""One request per map: the latest entry on every hexagon / visit point for a date range.

The block-grown Scouting Map colours hexagons, blocks and visit points by who scouted them last.
It does not need the raw entries (50k of them for two months on a farm scouted daily), only one
row per mapped unit, so this returns exactly that, shaped like ``getScoutingEntriesChunk`` rows so
the page's own derive functions run on it unchanged.

A unit is the entry's triad (hexagon) or, where a block has an outline but no hexagons, the visit
point gridded to ~22 m so a day's visits to one spot count once. Farms whose entries sit on
orchard trees (Kaitet's avocado) get ``aggregated: false`` and the page keeps its per-week raw
fetch: tree tracks need every entry.
"""

import frappe

from upande_scp.serverscripts.common import crop_catalog
from upande_scp.serverscripts.common.cache_utils import TTL_SHORT, get_or_set, scouting_payload_version

#: Visit points closer than this (degrees, ~22 m) are one unit.
POINT_STEP = 0.0002


def unit_key(triad, block, lat, lng) -> str | None:
	"""The unit an entry colours, or None when it sits nowhere on the map. Pure."""
	if triad:
		return f"h:{triad}"
	try:
		la, lo = float(lat), float(lng)
	except (TypeError, ValueError):
		return None
	if abs(la) < 0.001 and abs(lo) < 0.001:
		return None
	return f"p:{block or ''}:{round(la / POINT_STEP)}:{round(lo / POINT_STEP)}"


def latest_per_unit(rows) -> list:
	"""Newest row of each unit, newest first, each carrying ``visits`` (rows in the unit). Pure.

	``rows`` need ``triad``, ``block``, ``latitude``, ``longitude``, ``date_of_capture`` and
	``time_of_capture``."""
	best: dict = {}
	count: dict = {}
	for r in rows:
		k = unit_key(r.get("triad"), r.get("block"), r.get("latitude"), r.get("longitude"))
		if k is None:
			continue
		count[k] = count.get(k, 0) + 1
		stamp = (str(r.get("date_of_capture")), str(r.get("time_of_capture")))
		cur = best.get(k)
		if cur is None or stamp > cur[0]:
			best[k] = (stamp, r)
	out = []
	for k, (stamp, r) in sorted(best.items(), key=lambda kv: kv[1][0], reverse=True):
		out.append({**r, "visits": count[k]})
	return out


def encode(units) -> dict:
	"""Compact columns for the wire: names once, then one short array per unit. Pure.

	``hex``: [triad, scout, block, visits, date]; ``pts``: [lng, lat, scout, block, visits, date]
	with scout / block as indexes into ``scouts`` / ``blocks`` and coordinates in micro-degrees."""
	scouts: list = []
	blocks: list = []

	def idx(lst, v):
		v = v or ""
		if v not in lst:
			lst.append(v)
		return lst.index(v)

	hexes, pts = [], []
	for u in units:
		sc, bl, d = idx(scouts, u.get("scouts_name")), idx(blocks, u.get("block")), str(u.get("date_of_capture"))[:10]
		if u.get("triad"):
			hexes.append([u["triad"], sc, bl, u["visits"], d])
		else:
			pts.append([round(float(u["longitude"]) * 1e6), round(float(u["latitude"]) * 1e6), sc, bl, u["visits"], d])
	return {"scouts": scouts, "blocks": blocks, "hex": hexes, "pts": pts}


def _build(from_date, to_date, crop, greenhouse) -> dict:
	params = crop_catalog.crop_sql_params(crop)
	params.update({"from_date": from_date, "to_date": to_date})
	# The raw path keeps only entries with a finding (and, for a crop, only its own pests and
	# diseases), so a clean visit colours nothing; the summary has to agree.
	cond = (
		crop_catalog.entry_crop_condition("se")
		+ """ AND (EXISTS (SELECT 1 FROM `tabPests Scouting Entry` p WHERE p.parent = se.name AND p.pest IN %(crop_pests)s)
		        OR EXISTS (SELECT 1 FROM `tabDiseases Scouting Entry` d WHERE d.parent = se.name AND d.disease IN %(crop_diseases)s)
		        OR EXISTS (SELECT 1 FROM `tabTrap Scouting Entry` t WHERE t.parent = se.name))"""
	)
	gh = ""
	if greenhouse:
		gh = " AND (se.greenhouse = %(gh)s OR se.block = %(gh)s)"
		params["gh"] = greenhouse
	if frappe.db.sql(
		f"""SELECT 1 FROM `tabScouting Entry` se
		    WHERE se.date_of_capture BETWEEN %(from_date)s AND %(to_date)s AND IFNULL(se.tree, '') != ''
		      AND {cond}{gh} LIMIT 1""",
		params,
	):
		return {"aggregated": False, "total_entries": 0}
	rows = frappe.db.sql(
		f"""SELECT se.name, se.scouts_name, se.greenhouse, se.block, se.triad,
		           COALESCE(NULLIF(se.crop_scouted, ''), %(crop)s) AS crop_scouted,
		           se.time_of_capture, se.date_of_capture, se.latitude, se.longitude
		    FROM `tabScouting Entry` se
		    WHERE se.date_of_capture BETWEEN %(from_date)s AND %(to_date)s AND {cond}{gh}""",
		params,
		as_dict=True,
	)
	return {"aggregated": True, "total_entries": len(rows), **encode(latest_per_unit(rows))}


@frappe.whitelist()
def get_scouting_unit_summary(from_date=None, to_date=None, crop=None, greenhouse=None):
	"""``{aggregated, total_entries, scouts, blocks, hex, pts}``: one compact row per mapped unit (see ``encode``)."""
	crop = crop_catalog.resolve_crop(crop) or None
	if not from_date or not to_date:
		frappe.throw("from_date and to_date are required")
	if not crop:
		# Unscoped reads keep the raw path: the crop is what makes the slice small and checked.
		return {"aggregated": False, "total_entries": 0}
	greenhouse = (greenhouse or "").strip() or None
	key = f"scp:unit_summary:{scouting_payload_version()}:{crop}:{greenhouse or ''}:{from_date}:{to_date}"
	return get_or_set(key, lambda: _build(str(from_date)[:10], str(to_date)[:10], crop, greenhouse), ttl=TTL_SHORT)
