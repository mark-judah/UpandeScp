"""DEMO photographed scouting entries for Scouting > Visual findings (local sites only).

    bench --site kaitet.local execute upande_scp.scripts.demo_visual_findings.create
    bench --site kaitet.local execute upande_scp.scripts.demo_visual_findings.remove

``create()`` writes real Scouting Entries (through the doctype, so the cache
invalidation and the realtime "dirty" hooks fire exactly as for a scout's sync)
in the current and the previous ISO week:

* Roses (Chepsito, Kaptumbo, Torongo, Kapkolia, Simotwo for traps; plus Karen for
  general): about 30 trap catches and 30 pest / disease observations;
* Avocado (Lokitela): the same, in blocks / rows / trees.

Coffee (Endebess, Saboti) has no traps, no scouting units, no trees and no
scouting entries on the site, so nothing is invented for it.

Every entry carries a Comments row starting with ``MARK`` ("DEMO ..."), which is
how ``remove()`` finds them. Scouts are existing active Employees with a User who
scouted on that farm in the last weeks; the entry is owned by the scout's user.
Photos are existing site images (the pest / disease reference images under
/files); nothing is downloaded. Safe to re-run: ``create()`` removes first.
"""

import os
import random
from datetime import datetime, time, timedelta

import frappe
from frappe.utils import add_days, get_datetime, getdate, nowdate

MARK = "DEMO"
TRAP_NOTE = "DEMO trap catch - sample entry for Visual findings, safe to delete"
OBS_NOTE = "DEMO observation - sample entry for Visual findings, safe to delete"
COUNTS = [1, 2, 3, 5, 10]  # highest counts: polygon sides = 2 x count

ROSE_TRAP_FARMS = ["Chepsito", "Kaptumbo", "Torongo", "Kapkolia", "Simotwo"]
ROSE_OBS_FARMS = ROSE_TRAP_FARMS + ["Karen"]
TRAPS_PER_ROSE_FARM = 6
OBS_PER_ROSE_FARM = 5
AVOCADO_FARM = "Lokitela"
LURE_PEST = {"Crytrack Lure": "FCM", "Femtrack Lure": "Fruit fly (Ceratitis)"}
ROSE_GENERAL_TRAP_PESTS = ["Duponchella", "Helicoverpa", "Spodoptera", "Unidentified Moth"]


# ── public ────────────────────────────────────────────────────────────

def create():
    remove()
    rng = random.Random(20261013)
    ctx = _Ctx(rng)
    names = []
    names += _rose_traps(ctx)
    names += _rose_observations(ctx)
    names += _avocado_traps(ctx)
    names += _avocado_observations(ctx)
    frappe.db.commit()
    summary = _summary(names)
    print(f"created {len(names)} DEMO entries")
    for k, v in summary.items():
        print(k, v)
    return names


def remove():
    parents = frappe.db.sql(
        "SELECT DISTINCT parent FROM `tabComments Scouting Entry` "
        "WHERE parenttype = 'Scouting Entry' AND comment LIKE %s",
        (MARK + " %",), pluck=True)
    for name in parents:
        frappe.delete_doc("Scouting Entry", name, force=True, ignore_permissions=True)
    frappe.db.commit()
    print(f"removed {len(parents)} DEMO entries")
    return parents


# ── helpers ───────────────────────────────────────────────────────────

class _Ctx:
    def __init__(self, rng):
        self.rng = rng
        self.today = getdate(nowdate())
        self.now = frappe.utils.now_datetime()
        self.week_start = self.today - timedelta(days=self.today.weekday())
        self.prev_start = self.week_start - timedelta(days=7)
        self._scouts = {}
        self._images = None
        self._i = 0
        self.crop_pests = {}

    # when: alternate previous / current week, never in the future
    def stamp(self, i):
        for _ in range(20):
            week = self.prev_start if i % 2 == 0 else self.week_start
            day = week + timedelta(days=self.rng.randint(0, 5))
            at = time(self.rng.randint(6, 15), self.rng.randint(0, 59), self.rng.randint(0, 59))
            if datetime.combine(day, at) <= self.now - timedelta(minutes=10):
                return day, at
            i += 1
        return self.prev_start, time(7, 30)

    def scouts(self, farm):
        if farm not in self._scouts:
            self._scouts[farm] = frappe.db.sql(
                """SELECT se.scouts_name, e.employee_name, e.user_id
                   FROM `tabScouting Entry` se
                   JOIN `tabWarehouse` w ON w.name = COALESCE(NULLIF(se.block, ''), se.greenhouse)
                   JOIN `tabEmployee` e ON e.name = se.scouts_name
                   WHERE se.date_of_capture >= %s AND w.custom_farm = %s AND e.status = 'Active'
                     AND IFNULL(e.user_id, '') != ''
                   GROUP BY se.scouts_name, e.employee_name, e.user_id ORDER BY COUNT(*) DESC""",
                (add_days(self.today, -75), farm), as_dict=True)
        return self._scouts[farm]

    def images(self):
        if self._images is None:
            self._images = {}
            for dt in ("Pest", "Plant Disease"):
                for r in frappe.get_all(dt, fields=["name", "damage_symptoms"], limit_page_length=0):
                    url = r.damage_symptoms or ""
                    if url.startswith("/files/") and os.path.exists(
                            frappe.get_site_path("public", url.lstrip("/"))):
                        self._images[r.name] = url
        return self._images

    def photo_for(self, subject):
        imgs = self.images()
        if subject in imgs:
            return imgs[subject]
        pool = sorted(imgs.values())
        return pool[self._bump() % len(pool)]

    def _bump(self):
        self._i += 1
        return self._i

    def combos(self, crop):
        """Real (pest, stage, plant_section) / (disease, stage, section) combos for a crop."""
        from upande_scp.serverscripts.common import crop_catalog
        pests, diseases = set(crop_catalog.pests_for_crop(crop)), set(crop_catalog.diseases_for_crop(crop))
        since = add_days(self.today, -60)
        pc = [r for r in frappe.db.sql(
            """SELECT p.pest, p.stage, p.plant_section FROM `tabPests Scouting Entry` p
               WHERE p.parent IN (SELECT name FROM `tabScouting Entry`
                    WHERE date_of_capture >= %s AND crop_scouted = %s)
                 AND IFNULL(p.stage, '') != '' GROUP BY 1, 2, 3 ORDER BY COUNT(*) DESC LIMIT 60""",
            (since, crop)) if r[0] in pests]
        dc = [r for r in frappe.db.sql(
            """SELECT d.disease, d.stage, d.plant_section FROM `tabDiseases Scouting Entry` d
               WHERE d.parent IN (SELECT name FROM `tabScouting Entry`
                    WHERE date_of_capture >= %s AND crop_scouted = %s)
                 AND IFNULL(d.stage, '') != '' GROUP BY 1, 2, 3 ORDER BY COUNT(*) DESC LIMIT 60""",
            (since, crop)) if r[0] in diseases]
        return pc, dc


def _coords(wh, fallback=("0", "0")):
    row = frappe.db.sql(
        """SELECT latitude, longitude FROM `tabScouting Entry`
           WHERE COALESCE(NULLIF(block, ''), greenhouse) = %s AND latitude NOT IN ('', '0')
           ORDER BY date_of_capture DESC LIMIT 1""", (wh,))
    return row[0] if row else fallback


def _insert(ctx, scout, day, at, place, *, crop, children, photo, note):
    """One Scouting Entry. ``place`` are its location columns."""
    lat, lon = _coords(place.get("block") or place.get("greenhouse"))
    doc = frappe.get_doc({
        "doctype": "Scouting Entry",
        "naming_series": "SCE-.YYYY.-",
        "scouts_name": scout["scouts_name"],
        "date_of_capture": day,
        "time_of_capture": at.strftime("%H:%M:%S"),
        "crop_scouted": crop,
        "latitude": str(lat), "longitude": str(lon),
        **place,
        **children,
        "comments_scouting_entry": [{"comment": note}],
        "photos_scouting_entry": [{
            "image": photo["image"], "caption": photo["caption"], "subject": photo["subject"],
            "captured_on": datetime.combine(day, at),
        }],
    })
    doc.owner = scout["user_id"]
    doc.flags.ignore_links = True
    doc.flags.ignore_mandatory = True
    doc.insert(ignore_permissions=True)
    frappe.db.set_value("Scouting Entry", doc.name, {"owner": scout["user_id"], "modified_by": scout["user_id"]},
                        update_modified=False)
    return doc.name


def _trap_entry(ctx, trap, pest, count, scout, day, at, place, crop):
    return _insert(
        ctx, scout, day, at, place, crop=crop,
        children={"trap_scouting_entry": [{
            "trap": trap.name, "pest": pest, "location": trap.location or "Indoor", "count": count}]},
        photo={"image": ctx.photo_for(pest),
               "caption": f"DEMO - {pest} on trap {trap.name}, highest count {count}", "subject": pest},
        note=TRAP_NOTE)


def _pick_traps(ctx, farms, per_farm, only_fixed=True):
    out = []
    for farm in farms:
        traps = frappe.get_all(
            "Trap", filters={"farm": farm}, fields=["name", "greenhouse", "type", "location", "geojson"],
            order_by="name", limit_page_length=0)
        fixed = [t for t in traps if t.geojson] if only_fixed else traps
        pool = fixed or traps
        ctx.rng.shuffle(pool)
        seen, picked = set(), []
        for t in pool:  # spread over greenhouses / blocks first
            if t.greenhouse not in seen:
                seen.add(t.greenhouse)
                picked.append(t)
        for t in pool:
            if t not in picked:
                picked.append(t)
        out.append((farm, picked[:per_farm]))
    return out


# ── roses ─────────────────────────────────────────────────────────────

def _rose_traps(ctx):
    names, n = [], 0
    for farm, traps in _pick_traps(ctx, ROSE_TRAP_FARMS, TRAPS_PER_ROSE_FARM):
        scouts = ctx.scouts(farm)
        for k, t in enumerate(traps):
            pest = "FCM" if t.type == "FCM" else ROSE_GENERAL_TRAP_PESTS[(n + k) % 4]
            day, at = ctx.stamp(n)
            names.append(_trap_entry(ctx, t, pest, COUNTS[n % 5], scouts[(k + n) % len(scouts)], day, at,
                                     {"greenhouse": t.greenhouse}, None))
            n += 1
        if farm == ROSE_TRAP_FARMS[0] and traps and len(scouts) > 1:
            # Carousel: one trap, 3 photographed catches, 2 scouts, one week (this one).
            t = traps[0]
            pest = "FCM" if t.type == "FCM" else ROSE_GENERAL_TRAP_PESTS[0]
            for j, (d_off, hh, who, cnt) in enumerate(
                    [(0, 7, 0, 3), (0, 14, 1, 5), (1, 6, 0, 10)]):
                day = ctx.week_start + timedelta(days=d_off)
                if day > ctx.today:
                    day = ctx.week_start
                at = time(hh, 5 + j * 11, 0)
                if datetime.combine(day, at) > ctx.now - timedelta(minutes=10):
                    at = time(5, 40 + j, 0)
                names.append(_trap_entry(ctx, t, pest, cnt, scouts[who], day, at,
                                         {"greenhouse": t.greenhouse}, None))
    return names


def _rose_places(farm):
    """(greenhouse, bed, zone) triples that exist for a farm's greenhouses."""
    ghs = frappe.get_all("Warehouse", filters={"custom_farm": farm, "warehouse_type": "Greenhouse", "is_group": 0},
                         pluck="name", limit_page_length=0)
    out = []
    for gh in ghs:
        for z in frappe.get_all("Zone", filters={"name": ["like", gh + " - Bed %"]}, pluck="name",
                                limit_page_length=0):
            out.append((gh, z.rsplit(" - Zone ", 1)[0], z))
    return out


def _rose_observations(ctx):
    pc, dc = ctx.combos("Rose")
    names, n = [], 0
    for farm in ROSE_OBS_FARMS:
        places, scouts = _rose_places(farm), ctx.scouts(farm)
        if not places or not scouts:
            continue
        for k in range(OBS_PER_ROSE_FARM):
            gh, bed, zone = ctx.rng.choice(places)
            day, at = ctx.stamp(n)
            names.append(_observation(ctx, scouts[(k + n) % len(scouts)], day, at,
                                      {"greenhouse": gh, "bed": bed, "zone": zone}, "Rose", pc, dc, n))
            n += 1
    return names


def _observation(ctx, scout, day, at, place, crop, pc, dc, n):
    """A pest (about 3 in 5) or a disease observation with one photo."""
    if n % 5 < 3 and pc or not dc:
        pest, stage, section = pc[(n * 7) % len(pc)]
        count = [1, 2, 3, 4, 6, 8, 12][n % 7]
        children = {"pests_scouting_entry": [{"pest": pest, "stage": stage, "plant_section": section,
                                             "count": count}]}
        subject, what = pest, f"{pest} ({stage}), count {count}"
    else:
        dis, stage, section = dc[(n * 5) % len(dc)]
        children = {"diseases_scouting_entry": [{"disease": dis, "stage": stage, "plant_section": section}]}
        subject, what = dis, f"{dis} ({stage})"
    return _insert(ctx, scout, day, at, place, crop=crop, children=children,
                   photo={"image": ctx.photo_for(subject), "caption": f"DEMO - {what}", "subject": subject},
                   note=OBS_NOTE)


# ── avocado ───────────────────────────────────────────────────────────

def _avocado_traps(ctx):
    scouts = ctx.scouts(AVOCADO_FARM)
    traps = frappe.get_all("Trap", filters={"farm": AVOCADO_FARM}, order_by="name",
                           fields=["name", "greenhouse", "type", "location"], limit_page_length=0)
    ctx.rng.shuffle(traps)
    seen, picked = set(), []
    for t in traps:
        if t.greenhouse not in seen and t.type in LURE_PEST:
            seen.add(t.greenhouse)
            picked.append(t)
    rest = [t for t in traps if t not in picked and t.type in LURE_PEST]
    picked = (picked + rest)[:30]
    names = []
    for n, t in enumerate(picked):
        day, at = ctx.stamp(n)
        names.append(_trap_entry(ctx, t, LURE_PEST[t.type], COUNTS[n % 5], scouts[n % len(scouts)], day, at,
                                 {"block": t.greenhouse}, "Avocado"))
    # Carousel: one more trap, 3 photographed catches by 2 scouts in the current week.
    t = next((x for x in picked if x.type == "Crytrack Lure"), picked[0])
    for j, (d_off, hh, who, cnt) in enumerate([(0, 7, 0, 2), (0, 13, 1, 5), (1, 6, 0, 10)]):
        day = ctx.week_start + timedelta(days=d_off)
        at = time(hh, 8 + j * 9, 0)
        if datetime.combine(day, at) > ctx.now - timedelta(minutes=10):
            at = time(5, 45 + j, 0)
        names.append(_trap_entry(ctx, t, LURE_PEST[t.type], cnt, scouts[who % len(scouts)], day, at,
                                 {"block": t.greenhouse}, "Avocado"))
    return names


def _avocado_observations(ctx):
    pc, dc = ctx.combos("Avocado")
    scouts = ctx.scouts(AVOCADO_FARM)
    trees = frappe.db.sql(
        """SELECT t.block, t.row, t.tree_number FROM `tabOrchard Tree` t
           JOIN `tabWarehouse` w ON w.name = t.block
           WHERE w.custom_farm = %s AND t.is_model = 0 ORDER BY RAND(7) LIMIT 400""", (AVOCADO_FARM,))
    names = []
    seen_blocks = {}
    ordered = sorted(trees, key=lambda r: seen_blocks.setdefault(r[0], len(seen_blocks)))  # stable, then spread
    spread = []
    by_block = {}
    for r in trees:
        by_block.setdefault(r[0], []).append(r)
    while len(spread) < 30 and by_block:
        for b in list(by_block):
            spread.append(by_block[b].pop())
            if not by_block[b]:
                del by_block[b]
            if len(spread) >= 30:
                break
    for n, (block, row, num) in enumerate(spread):
        day, at = ctx.stamp(n)
        names.append(_observation(ctx, scouts[n % len(scouts)], day, at,
                                  {"block": block, "row": row, "tree": f"{row} - Tree {num}"},
                                  "Avocado", pc, dc, n))
    return names


# ── report ────────────────────────────────────────────────────────────

def _summary(names):
    rows = frappe.db.sql(
        """SELECT COALESCE(se.crop_scouted, 'Rose') crop, w.custom_farm, se.scouts_name, e.employee_name,
                  (SELECT COUNT(*) FROM `tabTrap Scouting Entry` t WHERE t.parent = se.name) is_trap
           FROM `tabScouting Entry` se
           JOIN `tabWarehouse` w ON w.name = COALESCE(NULLIF(se.block, ''), se.greenhouse)
           JOIN `tabEmployee` e ON e.name = se.scouts_name WHERE se.name IN %s""",
        (tuple(names),), as_dict=True) if names else []
    from collections import Counter
    return {
        "per crop/farm/kind": dict(Counter((r.crop, r.custom_farm, "trap" if r.is_trap else "obs") for r in rows)),
        "per scout": dict(Counter(f"{r.scouts_name} {r.employee_name}" for r in rows)),
    }
