"""Re-link avocado Scouting Entries (visit points / triads) to their nearest generated Orchard Tree.

After ``generate_orchard_grid`` gives an avocado block trees, its older entries still carry only a
GPS point (they colour a loose "pt:" dot). Lokitela's entries carry ``block``, ``row`` and ``tree``
(``<block> - Row r`` / ``<block> - Row r - Tree t``); this sets the same on those entries.

* only blocks that have outline + trees and sit under a Phase (avocado); pivots are untouched;
* position = the entry's GPS, else the centre of its triad; the tree must be in the SAME block and
  within ``max_m`` metres, otherwise the entry is skipped and counted;
* entries that already have a ``tree`` are left alone (idempotent);
* ``triad`` is left as is: the map keys an entry by tree first, then triad, then point, so a tree
  link never draws twice;
* plain batched UPDATEs, no document save; ``modified`` is not bumped;
* the previous tree/row values go to ``backup_path`` (JSON) before anything is written;
  ``revert(backup_path)`` restores them.

    bench --site mutara.local execute upande_scp.serverscripts.geo.relink_avocado_entries.run \
        --kwargs '{"dry_run": 1}'
"""

import json
import math
import re
import statistics

import frappe

from upande_scp.serverscripts.geo.generate_orchard_grid import M_PER_DEG, avocado_blocks

CELL_M = 8.0
BATCH = 500
_ROW = re.compile(r"^(.*) - Tree \d+$")


class TreeIndex:
	"""Per-block grid of tree positions in local metres; nearest lookup."""

	def __init__(self, names, lnglats):
		self.lng0 = sum(p[0] for p in lnglats) / len(lnglats)
		self.lat0 = sum(p[1] for p in lnglats) / len(lnglats)
		self.k = M_PER_DEG * math.cos(math.radians(self.lat0))
		self.cells = {}
		for n, p in zip(names, lnglats):
			x, y = self.xy(p)
			self.cells.setdefault((int(x // CELL_M), int(y // CELL_M)), []).append((x, y, n))

	def xy(self, p):
		return ((p[0] - self.lng0) * self.k, (p[1] - self.lat0) * M_PER_DEG)

	def nearest(self, lng, lat, max_m=60.0):
		"""(tree name, metres) or None when no tree within max_m."""
		x, y = self.xy((lng, lat))
		cx, cy = int(x // CELL_M), int(y // CELL_M)
		best, bd = None, float("inf")
		ring = 0
		while ring * CELL_M <= min(bd, max_m) + CELL_M:
			for i in range(cx - ring, cx + ring + 1):
				for j in range(cy - ring, cy + ring + 1):
					if max(abs(i - cx), abs(j - cy)) != ring:
						continue
					for tx, ty, n in self.cells.get((i, j), ()):
						d = math.hypot(tx - x, ty - y)
						if d < bd:
							best, bd = n, d
			ring += 1
		return (best, bd) if best is not None and bd <= max_m else None


def _tree_index(block):
	rows = frappe.db.sql("select name, geojson from `tabOrchard Tree` where block=%s and geojson is not null", block)
	names, pts = [], []
	for n, g in rows:
		try:
			c = json.loads(g)["geometry"]["coordinates"]
		except (TypeError, ValueError, KeyError):
			continue
		names.append(n)
		pts.append((c[0], c[1]))
	return TreeIndex(names, pts) if names else None


def _triad_centre(triad):
	g = frappe.db.get_value("Triad", triad, "geojson")
	try:
		f = json.loads(g)
		ring = f["geometry"]["coordinates"][0]
		return (sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring))
	except (TypeError, ValueError, KeyError, ZeroDivisionError):
		return None


def _position(e):
	try:
		lat, lng = float(e.latitude or 0), float(e.longitude or 0)
	except (TypeError, ValueError):
		lat = lng = 0.0
	if abs(lat) >= 0.001 or abs(lng) >= 0.001:
		return lng, lat
	return _triad_centre(e.triad) if e.triad else None


def _pct(v, q):
	v = sorted(v)
	return v[min(len(v) - 1, int(q * len(v)))]


def run(farm=None, block=None, max_m=60, dry_run=1, backup_path=None):
	max_m, dry_run = float(max_m), int(dry_run)
	moves, summary = [], []
	for w in avocado_blocks(farm, block):
		idx = _tree_index(w.name)
		if idx is None:
			continue
		ents = frappe.get_all(
			"Scouting Entry",
			filters={"block": w.name, "tree": ["in", ["", None]]},
			fields=["name", "latitude", "longitude", "triad", "row", "tree"],
			limit_page_length=0,
		)
		dists, nopos, notree = [], 0, 0
		for e in ents:
			pos = _position(e)
			if pos is None:
				nopos += 1
				continue
			hit = idx.nearest(pos[0], pos[1], max_m)
			if hit is None:
				notree += 1
				continue
			tree, d = hit
			row = _ROW.match(tree).group(1)
			dists.append(d)
			moves.append({"name": e.name, "block": w.name, "old_tree": e.tree, "old_row": e.row, "tree": tree, "row": row})
		summary.append(
			f"{w.name}: {len(dists)} to move, {nopos} without position, {notree} with no tree within {max_m:.0f} m"
			+ (f"; distance median {statistics.median(dists):.1f} p95 {_pct(dists, .95):.1f} max {max(dists):.1f} m" if dists else "")
		)
	for s in summary:
		print(s)
	print(f"{'DRY RUN' if dry_run else 'APPLIED'}: {len(moves)} entries")
	if dry_run or not moves:
		return {"entries": len(moves)}
	if not backup_path:
		backup_path = frappe.get_site_path("private", "files", "relink_avocado_entries_backup.json")
	with open(backup_path, "w") as f:
		json.dump(moves, f)
	print("backup written:", backup_path)
	_apply(moves, "tree", "row")
	frappe.db.commit()
	_clear(set(m["block"] for m in moves))
	return {"entries": len(moves), "backup": backup_path}


def _apply(moves, tree_key, row_key):
	for i in range(0, len(moves), BATCH):
		chunk = moves[i : i + BATCH]
		names = [m["name"] for m in chunk]
		when_t = " ".join("WHEN %s THEN %s" for _ in chunk)
		args = []
		for m in chunk:
			args += [m["name"], m[tree_key]]
		args_r = []
		for m in chunk:
			args_r += [m["name"], m[row_key]]
		frappe.db.sql(
			f"update `tabScouting Entry` set tree = CASE name {when_t} END, `row` = CASE name {when_t} END "
			f"where name in ({', '.join(['%s'] * len(names))})",
			args + args_r + names,
		)


def revert(backup_path):
	"""Restore the tree/row values saved before ``run`` (only entries still on the generated tree)."""
	moves = json.load(open(backup_path))
	cur = {}
	for i in range(0, len(moves), 2000):
		ns = [m["name"] for m in moves[i : i + 2000]]
		cur.update(dict(frappe.db.sql(f"select name, tree from `tabScouting Entry` where name in ({', '.join(['%s'] * len(ns))})", ns)))
	todo = [{"name": m["name"], "t": m["old_tree"], "r": m["old_row"]} for m in moves if cur.get(m["name"]) == m["tree"]]
	_apply(todo, "t", "r")
	frappe.db.commit()
	_clear(set(m["block"] for m in moves))
	print("reverted", len(todo))
	return len(todo)


def _clear(blocks):
	from upande_scp.serverscripts.common import cache_utils as cu

	for b in blocks:
		cu.invalidate_orchard_trees_for_block(b)
	cu.invalidate_scouting_payload()
