"""Mutara demo scouting at scale: ~50,000 Scouting Entries over the previous two months.

    bench --site mutara.local execute upande_scp.serverscripts.migrate.seed_mutara_scouting.run
    bench --site mutara.local execute upande_scp.serverscripts.migrate.seed_mutara_scouting.run \
        --kwargs "{'clear_first': True}"
    bench --site mutara.local execute upande_scp.serverscripts.migrate.seed_mutara_scouting.clear

What it makes, per block that has a crop planted (``common.planting``: the current Production Crop
Cycle, a Production Unit's own crop where it has none yet, never a Retired unit):

* surveyed pivot blocks: every entry sits on one of the block's Triads (3 m hexagons) and its
  Row (Bed); the hexagon is stored in ``Scouting Entry.triad``;
* avocado blocks, which have an outline but no rows or trees yet: entries are points inside the
  block polygon;
* blocks with no surveyed geometry: block-level entries with no coordinates.

Findings come from each crop's own pest / disease / predator catalogue, with stages and severity
bands read from the masters. Each block gets a few hot spots that start on some day, spread
outward, peak with the season and, half of the time, are sprayed and fade, so the maps and trends
look like a real season rather than noise.

Rows go in with ``frappe.db.bulk_insert`` (children included), the ``SCE-YYYY-`` series is
advanced to the last number used, and every row carries the tag ``mutara-demo-scouting`` in
``_user_tags``: that tag is the marker that makes a re-run a no-op and ``clear()`` remove only
these rows (the 50 entries from ``seed_mutara_spray_plan`` are untouched). Caches the maps read
are refreshed at the end.
"""

import datetime
import math
import random
from dataclasses import dataclass, field

import frappe

FARM = "Mutara"
TAG = "mutara-demo-scouting"
SERIES_PREFIX = "SCE-{year}-"
#: 2026-08-29 .. 2026-10-29 when run on 2026-10-29: the two months before today.
WINDOW_DAYS = 61
TOTAL = 50_000
M_PER_DEG = 111_320.0

#: Share of the entries each crop gets, when it has blocks. Crops with no planted block (Corn,
#: today) give their share back to the others.
CROP_WEIGHTS = {"Avocado": 40, "Potato": 18, "Onion": 14, "Cabbage": 14, "Passion Fruit": 10, "Corn": 4}
PESTS_PER_CROP = 7
DISEASES_PER_CROP = 5
DEFAULT_BAND = (3, 10)

_DRY = ("mite", "thrip", "spider", "whitefl", "aphid", "scale", "mealy")
_WET = ()
SEASON = {
	"dry": {4: 0.5, 5: 0.45, 6: 0.7, 7: 0.95, 8: 1.0, 9: 1.0, 10: 0.8, 11: 0.5, 12: 0.4, 1: 0.5, 2: 0.6, 3: 0.55},
	"wet": {4: 1.0, 5: 1.0, 6: 0.75, 7: 0.5, 8: 0.45, 9: 0.55, 10: 0.85, 11: 0.9, 12: 0.7, 1: 0.5, 2: 0.45, 3: 0.7},
	"flat": {m: 0.8 for m in range(1, 13)},
}


def season_of(kind: str, target: str) -> str:
	if kind == "disease":
		return "wet"
	t = target.lower()
	return "dry" if any(k in t for k in _DRY) else "flat"


# ------------------------------------------------------------------ pure model


@dataclass
class Unit:
	block: str
	crop: str
	#: (name, lng, lat, row, number) per scoutable hexagon; empty when the block has none.
	sites: list = field(default_factory=list)
	#: outline ring [(lng, lat), ...] when there are no sites but a surveyed polygon.
	polygon: list | None = None


@dataclass
class Hotspot:
	kind: str
	target: str
	x: float  # metres east of the unit origin
	y: float
	onset: int  # day of the window it starts
	sigma0: float  # metres at onset
	growth: float  # metres per day the footprint widens
	peak: float
	treated: int | None  # day it is sprayed; None when left to run
	season: str

	def strength(self, day: int, dist_m: float, month: int) -> float:
		if day < self.onset:
			return 0.0
		ramp = 1.0 / (1.0 + math.exp(-(day - self.onset - 8) / 6.0))
		sigma = self.sigma0 + self.growth * (day - self.onset)
		fade = 1.0
		if self.treated is not None and day > self.treated:
			fade = 0.5 ** ((day - self.treated) / 18.0)
		return self.peak * SEASON[self.season].get(month, 0.8) * ramp * fade * math.exp(-(dist_m**2) / (2 * sigma**2))


def sce_name(year: int, n: int) -> str:
	return f"{SERIES_PREFIX.format(year=year)}{n:05d}"


def allocate(blocks_by_crop: dict, total: int, weights: dict | None = None) -> dict:
	"""``{crop: entries}`` summing to ``total``; crops without blocks get nothing."""
	weights = weights or CROP_WEIGHTS
	live = {c: weights.get(c, 5) for c, n in blocks_by_crop.items() if n}
	if not live:
		return {}
	s = sum(live.values())
	out = {c: int(total * w / s) for c, w in live.items()}
	biggest = max(live, key=live.get)
	out[biggest] += total - sum(out.values())
	return out


def random_point_in(ring, rng) -> tuple:
	xs = [p[0] for p in ring]
	ys = [p[1] for p in ring]
	for _ in range(500):
		x = rng.uniform(min(xs), max(xs))
		y = rng.uniform(min(ys), max(ys))
		if _inside(x, y, ring):
			return x, y
	return sum(xs) / len(xs), sum(ys) / len(ys)


def _inside(x, y, ring) -> bool:
	inside = False
	j = len(ring) - 1
	for i in range(len(ring)):
		xi, yi = ring[i][0], ring[i][1]
		xj, yj = ring[j][0], ring[j][1]
		if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
			inside = not inside
		j = i
	return inside


def _band_count(strength: float, band: tuple, rng) -> int:
	low, mod = band
	if strength < 0.25:
		return rng.randint(1, max(1, low))
	if strength < 0.6:
		return rng.randint(low + 1, max(low + 1, mod))
	return rng.randint(mod + 1, max(mod + 2, mod * 2))


def make_hotspots(unit: Unit, cat: dict, n: int, window: int, rng) -> list:
	pests, diseases = cat["pests"], cat["diseases"]
	out = []
	for i in range(n):
		is_dis = bool(diseases) and (not pests or rng.random() < 0.35)
		target = rng.choice(diseases if is_dis else pests)
		kind = "disease" if is_dis else "pest"
		if unit.sites:
			s = rng.choice(unit.sites)
			x, y = s[1], s[2]
		elif unit.polygon:
			x, y = random_point_in(unit.polygon, rng)
		else:
			x = y = 0.0
		onset = rng.randint(2, int(window * 0.65))
		treated = onset + rng.randint(max(8, window // 3), max(16, int(window * 0.8))) if rng.random() < 0.5 else None
		out.append(
			Hotspot(
				kind=kind, target=target, x=x, y=y, onset=onset,
				sigma0=rng.uniform(15, 40), growth=rng.uniform(0.3, 0.9),
				peak=rng.uniform(0.7, 1.4), treated=treated, season=season_of(kind, target),
			)
		)
	return out


def _dist_m(x1, y1, x2, y2) -> float:
	k = math.cos(math.radians(y1)) if abs(y1) < 90 else 1.0
	return math.hypot((x1 - x2) * M_PER_DEG * k, (y1 - y2) * M_PER_DEG)


def plan_unit(unit: Unit, cat: dict, n: int, end: datetime.date, window: int, scouts: list, rng) -> list:
	"""``n`` visit dicts for one block, oldest to newest. Pure: no database."""
	hots = make_hotspots(unit, cat, max(3, min(8, n // 1500)), window, rng)
	start = end - datetime.timedelta(days=window)
	days = [d for d in range(window + 1) if (start + datetime.timedelta(days=d)).weekday() != 6]
	# Slightly more scouting later in the window, as a programme ramps up.
	weights = [1.0 + 0.6 * d / window for d in days]
	checkbox = cat.get("checkbox", {})
	located = bool(unit.sites or unit.polygon)
	rows = []
	for _ in range(n):
		d = rng.choices(days, weights)[0]
		date = start + datetime.timedelta(days=d)
		site = None
		if unit.sites:
			site = rng.choice(unit.sites)
			lng, lat, row = site[1], site[2], site[3]
		elif unit.polygon:
			lng, lat = random_point_in(unit.polygon, rng)
			row = None
		else:
			lng = lat = row = None
		strength: dict = {}
		kinds: dict = {}
		for h in hots:
			dist = _dist_m(lng, lat, h.x, h.y) if (located and lng is not None) else 0.0
			s = h.strength(d, dist, date.month)
			if s > 0:
				strength[h.target] = strength.get(h.target, 0.0) + s
				kinds[h.target] = h.kind
		pests, diseases = [], []
		for target, s in sorted(strength.items(), key=lambda kv: -kv[1]):
			if rng.random() >= min(0.97, 0.03 + 0.95 * (1 - math.exp(-1.6 * s))):
				continue
			if kinds[target] == "pest" and len(pests) < 3:
				stage = rng.choice(cat["stages"][target])
				count = 1 if stage in checkbox.get(target, ()) else _band_count(s, cat["bands"].get(target, DEFAULT_BAND), rng)
				pests.append({"pest": target, "stage": stage, "count": count})
			elif kinds[target] == "disease" and len(diseases) < 2:
				diseases.append({"disease": target, "stage": rng.choices(["Fresh", "Latent", "Dry"], [6, 3, 1])[0]})
		# A little ambient background: the odd single insect anywhere.
		if cat["pests"] and rng.random() < 0.04 and len(pests) < 3:
			p = rng.choice(cat["pests"])
			if p not in {x["pest"] for x in pests}:
				pests.append({"pest": p, "stage": rng.choice(cat["stages"][p]), "count": 1})
		predators = []
		if pests and cat["predators"] and rng.random() < 0.25:
			predators.append({"predator": rng.choice(cat["predators"]), "stage": "Adult", "count": rng.randint(1, 6)})
		rows.append(
			{
				"date": date,
				"time": datetime.time(rng.randint(7, 14), rng.choice(range(0, 60, 5)), 0),
				"scout": rng.choice(scouts),
				"block": unit.block,
				"crop": unit.crop,
				"site": site[0] if site else None,
				"row": row,
				"lng": lng,
				"lat": lat,
				"pests": pests,
				"diseases": diseases,
				"predators": predators,
			}
		)
	rows.sort(key=lambda r: (r["date"], r["time"]))
	return rows


# ------------------------------------------------------------------ database side


def is_seeded() -> bool:
	return bool(frappe.db.sql("select 1 from `tabScouting Entry` where _user_tags like %s limit 1", (f"%{TAG}%",)))


def _have_triad_column() -> bool:
	return frappe.db.has_column("Scouting Entry", "triad")


def _ring_centroid(geojson: str):
	import json

	g = json.loads(geojson)["geometry"]["coordinates"][0]
	pts = g[:-1] if len(g) > 1 and g[0] == g[-1] else g
	return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)


def _polygon(raw: str):
	import json

	try:
		feats = json.loads(raw)["features"]
		geom = feats[0]["geometry"]
		ring = geom["coordinates"][0] if geom["type"] == "Polygon" else geom["coordinates"][0][0]
		return [(p[0], p[1]) for p in ring]
	except Exception:
		return None


def load_units(farm: str = FARM) -> list:
	from upande_scp.serverscripts.common import planting

	whs = frappe.get_all(
		"Warehouse",
		filters={"custom_farm": farm, "warehouse_type": "Block", "disabled": 0},
		fields=["name", "custom_raw_geojson", "custom_production_unit"],
		order_by="name",
		limit_page_length=0,
	)
	crops = planting.crops_for_stations([w.name for w in whs])
	triads: dict = {}
	for r in frappe.db.sql(
		"select name, block, row, triad, geojson from `tabTriad` where farm = %s", (farm,), as_dict=True
	):
		triads.setdefault(r.block, []).append(r)
	units = []
	for w in whs:
		crop = crops.get(w.name)
		if not crop:
			continue
		sites = []
		for t in triads.get(w.name, []):
			lng, lat = _ring_centroid(t.geojson)
			sites.append((t.name, lng, lat, t.row, t.triad))
		poly = None if sites else (_polygon(w.custom_raw_geojson) if w.custom_raw_geojson else None)
		units.append(Unit(block=w.name, crop=crop, sites=sites, polygon=poly))
	return units


def load_catalog(crop: str, rng) -> dict:
	from upande_scp.serverscripts.common import crop_catalog

	catalog_pests = crop_catalog.pests_for_crop(crop)
	catalog_diseases = crop_catalog.diseases_for_crop(crop)
	stages: dict = {}
	checkbox: dict = {}
	for r in frappe.db.sql(
		"""select pf.pest, ps.stage, ps.reading_type from `tabPests Stages` ps
		   join `tabPest Filter` pf on pf.name = ps.parent where pf.crop_scouted = %s order by ps.idx""",
		(crop,), as_dict=True,
	):
		stages.setdefault(r.pest, [])
		if r.stage not in stages[r.pest]:
			stages[r.pest].append(r.stage)
		if r.reading_type == "Checkbox":
			checkbox.setdefault(r.pest, set()).add(r.stage)
	pests = [p for p in catalog_pests if stages.get(p)]
	diseases = [d for d in catalog_diseases]
	rng.shuffle(pests)
	rng.shuffle(diseases)
	pests, diseases = pests[:PESTS_PER_CROP], diseases[:DISEASES_PER_CROP]
	bands = {}
	for r in frappe.db.sql(
		"""select parent, severity, `from`, `to` from `tabScouting Severity Scale`
		   where parenttype = 'Pest' and parent in %s""",
		(tuple(pests) or ("",),), as_dict=True,
	):
		b = bands.setdefault(r.parent, [None, None])
		if r.severity == "Low":
			b[0] = r.to
		elif r.severity == "Moderate":
			b[1] = r.to
	bands = {p: (b[0] or DEFAULT_BAND[0], b[1] or DEFAULT_BAND[1]) for p, b in bands.items()}
	predators = frappe.get_all("Predator Filter", filters={"parent": crop}, pluck="predator")
	return {
		"pests": pests, "diseases": diseases, "stages": {p: stages[p] for p in pests},
		"bands": bands, "checkbox": checkbox, "predators": predators,
	}


def _scouts(n=12) -> list:
	taken = set(frappe.get_all("Spray Team Details", pluck="name1"))
	rows = frappe.get_all(
		"Employee", filters={"company": "Mutara", "status": "Active", "designation": ["is", "not set"]},
		pluck="name", order_by="name desc", limit_page_length=0,
	)
	return [r for r in rows if r not in taken][:n]


def _hash(used: set, n=10) -> str:
	import secrets
	import string

	alphabet = string.ascii_lowercase + string.digits
	while True:
		h = "".join(secrets.choice(alphabet) for _ in range(n))
		if h not in used:
			used.add(h)
			return h


def run(total: int = TOTAL, seed: int = 2026, clear_first: bool = False, dry_run: bool = False) -> dict:
	if clear_first:
		clear()
	if is_seeded():
		print("demo scouting already seeded; run clear() or pass clear_first=True to redo")
		return {"status": "already seeded"}
	if not _have_triad_column():
		frappe.reload_doc("upande_scp", "doctype", "scouting_entry")
		frappe.db.commit()
	rng = random.Random(seed)
	units = load_units()
	scouts = _scouts()
	if not units or not scouts:
		print("no planted blocks or no scouts: nothing seeded")
		return {"status": "nothing to seed"}
	by_crop: dict = {}
	for u in units:
		by_crop.setdefault(u.crop, []).append(u)
	alloc = allocate({c: len(v) for c, v in by_crop.items()}, total)
	end = datetime.date.today()
	plan: list = []
	per_crop: dict = {}
	for crop, us in sorted(by_crop.items()):
		cat = load_catalog(crop, rng)
		if not cat["pests"] and not cat["diseases"]:
			continue
		share, extra = divmod(alloc[crop], len(us))
		for i, u in enumerate(us):
			# Each block is covered by two or three scouts, as on a real round.
			team = [scouts[(i + k + len(plan)) % len(scouts)] for k in range(3)]
			rows = plan_unit(u, cat, share + (1 if i < extra else 0), end, WINDOW_DAYS, team, rng)
			plan.extend(rows)
			per_crop[crop] = per_crop.get(crop, 0) + len(rows)
	plan.sort(key=lambda r: (r["date"], r["time"], r["block"]))
	summary = {"status": "dry run" if dry_run else "seeded", "entries": len(plan), "per_crop": per_crop}
	print(summary)
	if dry_run:
		return summary
	names = _insert(plan)
	summary["photos"] = _photos(plan, names, rng)
	refresh_caches(plan)
	return summary


def _insert(plan: list) -> list:
	year = datetime.date.today().year
	prefix = SERIES_PREFIX.format(year=year)
	cur = frappe.db.sql("select current from tabSeries where name = %s", (prefix,))
	start = int(cur[0][0]) if cur else 0
	if not cur:
		frappe.db.sql("insert into tabSeries (name, current) values (%s, 0)", (prefix,))
	pe_fields = ["name", "creation", "modified", "modified_by", "owner", "docstatus", "idx", "parent", "parentfield", "parenttype"]
	entries, pests, diseases, predators = [], [], [], []
	used: set = set()
	tag = f",{TAG}"
	for i, r in enumerate(plan, start=1):
		name = sce_name(year, start + i)
		ts = datetime.datetime.combine(r["date"], r["time"])
		base = (ts, ts, "Administrator", "Administrator", 0)
		entries.append(
			(
				name, *base, 0, "SCE-.YYYY.-", r["scout"], r["crop"], None, None, None,
				r["block"], r["row"], None, r["time"].strftime("%H:%M:%S"), r["date"],
				"" if r["lat"] is None else f"{r['lat']:.6f}", "" if r["lng"] is None else f"{r['lng']:.6f}",
				r["site"], tag,
			)
		)
		for idx, p in enumerate(r["pests"], start=1):
			pests.append((_hash(used), ts, ts, "Administrator", "Administrator", 0, idx, name, "pests_scouting_entry",
			              "Scouting Entry", None, p["pest"], p["stage"], p["count"]))
		for idx, d in enumerate(r["diseases"], start=1):
			diseases.append((_hash(used), ts, ts, "Administrator", "Administrator", 0, idx, name, "diseases_scouting_entry",
			                 "Scouting Entry", None, d["disease"], d["stage"]))
		for idx, q in enumerate(r["predators"], start=1):
			predators.append((_hash(used), ts, ts, "Administrator", "Administrator", 0, idx, name, "predators_scouting_entry",
			                  "Scouting Entry", None, q["predator"], q["stage"], q["count"]))
	frappe.db.bulk_insert(
		"Scouting Entry",
		["name", "creation", "modified", "modified_by", "owner", "docstatus", "idx", "naming_series", "scouts_name",
		 "crop_scouted", "greenhouse", "bed", "zone", "block", "row", "tree", "time_of_capture", "date_of_capture",
		 "latitude", "longitude", "triad", "_user_tags"],
		entries,
	)
	frappe.db.bulk_insert("Pests Scouting Entry", pe_fields + ["plant_section", "pest", "stage", "count"], pests)
	frappe.db.bulk_insert("Diseases Scouting Entry", pe_fields + ["plant_section", "disease", "stage"], diseases)
	frappe.db.bulk_insert("Predators Scouting Entry", pe_fields + ["plant_section", "predator", "stage", "count"], predators)
	frappe.db.sql("update tabSeries set current = %s where name = %s", (start + len(plan), prefix))
	frappe.db.commit()
	return [e[0] for e in entries]


# ---------------------------------------------------------------- visual findings


PHOTOS_PER_CROP = 24


#: Reference photographs, read-only (never written to). Kaitet keeps one per pest / disease,
#: named after it (``aphids.jpeg``, ``powdery_mildew.jpg``).
REFERENCE_DIRS = (
	"/home/ubuntu/stive/code/frappe15/sites/kaitet.local/public/files",
)
_IMAGE_EXT = (".jpg", ".jpeg", ".png")
#: Names that differ between this site's masters and the reference files.
_ALIASES = {
	"leafminers": "leaf_miner", "fcm": "fcm", "mosquito_bugs": "mosquito_bugs", "unidentified_insects": "caterpillars",
	"diamondback_moth": "caterpillars", "cabbage_webworm": "caterpillars", "cabbage_looper": "loopers",
	"fall_armyworm": "spodoptera", "potato_tuber_moth": "caterpillars", "cutworms": "caterpillars",
	"onion_fly": "fruit_fly_(ceratitis)", "persea_mite": "spidermites", "broad_mites": "spidermites",
	"leaf_footed_bug": "stinkbug", "potato_cyst_nematode": "weevils", "red_spider_mite": "spidermites",
}
#: Stand-ins by kind when nothing matches, so a finding always has a real photograph.
_FALLBACK = {
	"pest": ("caterpillars", "thrips", "aphids", "whiteflies", "mealybugs", "spodoptera"),
	"disease": ("powdery_mildew", "downy_mildew", "botrytis", "rust", "anthracnose", "brown_eye_spot"),
}


def reference_images(dirs=REFERENCE_DIRS) -> dict:
	"""``{stem: path}`` of the reference images that exist (hash-suffixed duplicates and thumbnails left out)."""
	import os
	import re

	out: dict = {}
	for d in dirs:
		if not os.path.isdir(d):
			continue
		for fn in sorted(os.listdir(d)):
			stem, ext = os.path.splitext(fn)
			if ext.lower() not in _IMAGE_EXT or fn.startswith(("QR_", "zz-", "loadtest")) or "thumb" in stem:
				continue
			if re.search(r"[0-9a-f]{6}$", stem) and stem[:-6] in out:
				continue
			out.setdefault(stem, os.path.join(d, fn))
	return out


def pick_reference(subject: str, kind: str, images: dict, rng) -> str | None:
	"""Path of the reference photo for ``subject``: its own, its alias, else a stand-in for its kind."""
	key = frappe.scrub(subject)
	for k in (key, _ALIASES.get(key)):
		if k and k in images:
			return images[k]
	pool = [images[k] for k in _FALLBACK.get(kind, ()) if k in images] or list(images.values())
	return rng.choice(pool) if pool else None


def _photos(plan: list, names: list, rng) -> int:
	"""A few photographed findings per crop (real reference photographs copied from Kaitet, read-only)
	so Visual findings and its location map have something to show. Picks the worst finding on each
	chosen visit."""

	images = reference_images()
	if not images:
		print("no reference images found: no photos attached")
		return 0
	by_crop: dict = {}
	for i, r in enumerate(plan):
		if not (r["pests"] or r["diseases"]):
			continue
		by_crop.setdefault(r["crop"], []).append(i)
	files: dict = {}
	rows = []
	now = frappe.utils.now()
	for crop, idxs in by_crop.items():
		rng.shuffle(idxs)
		for i in idxs[:PHOTOS_PER_CROP]:
			r = plan[i]
			is_pest = bool(r["pests"])
			worst = max(r["pests"], key=lambda p: p["count"])["pest"] if is_pest else r["diseases"][0]["disease"]
			if worst not in files:
				path = pick_reference(worst, "pest" if is_pest else "disease", images, rng)
				with open(path, "rb") as fh:
					content = fh.read()
				ext = path.rsplit(".", 1)[-1].lower()
				# Private: this bench has no nginx /files location, but Frappe serves /private/files
				# to a signed-in user, so the gallery and Visual findings can open them.
				doc = frappe.get_doc({
					"doctype": "File", "file_name": f"demo-finding-{frappe.scrub(worst)}.{ext}", "is_private": 1,
					"content": content,
				}).insert(ignore_permissions=True)
				files[worst] = doc.file_url
			ts = datetime.datetime.combine(r["date"], r["time"])
			rows.append((frappe.generate_hash(length=10), ts, ts, "Administrator", "Administrator", 0, 1, names[i],
			             "photos_scouting_entry", "Scouting Entry", files[worst], f"Demo photo: {worst}", worst, ts))
	if rows:
		frappe.db.bulk_insert(
			"Scouting Entry Photo",
			["name", "creation", "modified", "modified_by", "owner", "docstatus", "idx", "parent", "parentfield",
			 "parenttype", "image", "caption", "subject", "captured_on"],
			rows,
		)
		frappe.db.commit()
	return len(rows)


def clear() -> dict:
	"""Delete the seeded entries (and their child rows) and nothing else."""
	names = frappe.db.sql_list("select name from `tabScouting Entry` where _user_tags like %s", (f"%{TAG}%",))
	if not names:
		return {"deleted": 0}
	for child in ("Pests Scouting Entry", "Diseases Scouting Entry", "Predators Scouting Entry", "Scouting Entry Photo"):
		frappe.db.sql(
			f"delete c from `tab{child}` c join `tabScouting Entry` se on se.name = c.parent where se.`_user_tags` like %s",
			(f"%{TAG}%",),
		)
	frappe.db.sql("delete from `tabScouting Entry` where _user_tags like %s", (f"%{TAG}%",))
	for f in frappe.get_all("File", filters={"file_name": ["like", "demo-finding-%"]}, pluck="name"):
		frappe.delete_doc("File", f, ignore_permissions=True, force=True)
	prefix = SERIES_PREFIX.format(year=datetime.date.today().year)
	rest = frappe.db.sql(
		"select max(cast(substring(name, %s) as unsigned)) from `tabScouting Entry` where name like %s",
		(len(prefix) + 1, prefix + "%"),
	)
	frappe.db.sql("update tabSeries set current = %s where name = %s", (int((rest[0][0] if rest else 0) or 0), prefix))
	frappe.db.commit()
	refresh_caches()
	print(f"cleared {len(names)} seeded entries")
	return {"deleted": len(names)}


def refresh_caches(plan: list | None = None) -> None:
	"""Entries went in under the hooks, so every cache the maps and dashboards read is stale."""
	from upande_scp.serverscripts.common import cache_utils
	from upande_scp.serverscripts.dashboard_aggregates import _common

	cache_utils.invalidate_scouting_payload()
	days = {str(r["date"]) for r in plan} if plan else {
		str(d) for d in frappe.db.sql_list("select distinct date_of_capture from `tabScouting Entry`")
	}
	cache_utils.invalidate_quality_days(*days)
	_common.bump_dash_agg_version()
	try:
		from upande_scp.serverscripts.geo.field_geo import bump_geo_version

		bump_geo_version()
	except Exception:
		pass
