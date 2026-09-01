"""Timed Scouting Entry push, to measure the real insert rate before a bulk run.

Answers one question: how many Scouting Entries per second can the target
actually absorb? Everything else about the migration is minutes; this is the
number that decides whether a 2.6M-row push is 2 hours or 36.

It is a real push of real rows, not a synthetic one — the same
`frappe.client.insert_many` path `push_scouting.py` uses, the same batch size,
the same remaps and the same idempotency key. So the rate it reports is the rate
the migration will get, and the rows it inserts are rows the migration wanted
anyway.

SAFE TO RE-RUN. Idempotent on the observation key (who looked, when, at which
plant), because Scouting Entry autonames from a naming series and the name the
target assigns has nothing to do with the source's — checking by name never
matches and would insert everything twice.

    python3 benchmark_scouting.py --count 2000 --dry-run
    python3 benchmark_scouting.py --count 2000 --apply
"""

from __future__ import annotations

import argparse
import json
import os
import time
import urllib.parse
import urllib.request

DOCTYPE = "Scouting Entry"
BATCH = 50

PARENT_FIELDS = ["name", "scouts_name", "crop_scouted", "greenhouse", "bed", "zone",
                 "block", "row", "tree", "time_of_capture", "date_of_capture",
                 "latitude", "longitude"]

# The observation key. The document name cannot serve — it is regenerated.
KEY_FIELDS = ("date_of_capture", "time_of_capture", "scouts_name", "crop_scouted",
              "greenhouse", "block", "bed", "zone", "tree")

CHILD_TABLES = {
    "pests_scouting_entry": "Pests Scouting Entry",
    "diseases_scouting_entry": "Diseases Scouting Entry",
    "predators_scouting_entry": "Predators Scouting Entry",
    "weeds_scouting_entry": "Weeds Scouting Entry",
    "incidents_scouting_entry": "Incidents Scouting Entry",
    "physiological_disorders_entry": "Physiological Disorders Entry",
    "trap_scouting_entry": "Trap Scouting Entry",
    "crop_modelling_entry": "Crop Modelling Entry",
}

# Corrected on the target; the source still carries the old spelling too.
WAREHOUSE_REMAP = {
    "Torongo GH17 - KR": "Torongo GH 17 - KR",
    "Torongo GH18 - KR": "Torongo GH 18 - KR",
    "Chepsito GH 15   - KR": "Chepsito GH 15 - KR",
}

DOCTYPE_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "upande_scp", "doctype")


def load_env(path):
    env = {}
    with open(os.path.expanduser(path), encoding="utf-8-sig") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:]
            if "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    return env


class Site:
    def __init__(self, url, key, secret, label):
        self.url = url.rstrip("/")
        self.auth = f"token {key}:{secret}"
        self.label = label

    def call(self, method, **params):
        """POST form-encoded, so a long `in` filter cannot overflow a query string."""
        req = urllib.request.Request(
            f"{self.url}/api/method/{method}",
            data=urllib.parse.urlencode(params).encode(),
            headers={"Authorization": self.auth,
                     "Content-Type": "application/x-www-form-urlencoded"})
        with urllib.request.urlopen(req, timeout=900) as r:
            return json.loads(r.read())["message"]

    def post_json(self, method, payload, timeout=900):
        req = urllib.request.Request(
            f"{self.url}/api/method/{method}",
            data=json.dumps(payload).encode(),
            headers={"Authorization": self.auth, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return True, json.loads(r.read())
        except Exception as e:
            body = ""
            if hasattr(e, "read"):
                try:
                    body = e.read().decode(errors="replace")[:400]
                except Exception:
                    pass
            return False, f"{e} {body}"

    def get_list(self, doctype, fields, filters=None, limit=0, parent=None, order_by=None):
        params = {"doctype": doctype, "fields": json.dumps(fields), "limit_page_length": limit}
        if filters:
            params["filters"] = json.dumps(filters)
        if parent:
            params["parent"] = parent
        if order_by:
            params["order_by"] = order_by
        return self.call("frappe.client.get_list", **params)

    def names_present(self, doctype, names, chunk=300):
        got, names = set(), sorted(n for n in names if n)
        for i in range(0, len(names), chunk):
            got |= {r["name"] for r in self.get_list(
                doctype, ["name"], [["name", "in", names[i:i + chunk]]])}
        return got


def child_fields(doctype_slug):
    path = os.path.join(DOCTYPE_DIR, doctype_slug, doctype_slug + ".json")
    d = json.load(open(path))
    skip = {"Section Break", "Column Break", "Tab Break", "HTML"}
    return [f["fieldname"] for f in d["fields"] if f["fieldtype"] not in skip]


def remap_geometry(value):
    """Bed and Zone names embed their greenhouse, so they move with the rename."""
    if not value:
        return value
    for old, new in WAREHOUSE_REMAP.items():
        if value.startswith(old):
            return new + value[len(old):]
    return value


def natural_key(row):
    return tuple(str(row.get(f) or "") for f in KEY_FIELDS)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--count", type=int, default=2000)
    p.add_argument("--batch", type=int, default=BATCH)
    p.add_argument("--crop", default="Rose")
    p.add_argument("--apply", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    src_env = load_env("~/.scp_migrate_from_site_env")
    tgt_env = load_env("~/.scp_migrate_target_site_env")
    src = Site(src_env["FROM_URL"], src_env["FROM_API_KEY"], src_env["FROM_API_SECRET"], "source")
    tgt = Site(tgt_env["TARGET_URL"], tgt_env["TARGET_API_KEY"], tgt_env["TARGET_API_SECRET"], "target")
    print(f"source : {src.url}")
    print(f"target : {tgt.url}")
    print(f"mode   : {'APPLY' if args.apply else 'DRY RUN'}   crop={args.crop}  count={args.count}  batch={args.batch}\n")

    # ---- 1. pull the slice -------------------------------------------------
    t0 = time.time()
    rows = src.get_list(DOCTYPE, PARENT_FIELDS,
                        [["crop_scouted", "=", args.crop]],
                        limit=args.count, order_by="date_of_capture desc, name desc")
    t_parents = time.time() - t0
    if not rows:
        print("no rows returned from the source"); return 1
    names = [r["name"] for r in rows]
    print(f"1. parents      {len(rows):,} in {t_parents:.1f}s  ({len(rows)/t_parents:,.0f}/sec)"
          f"   dates {min(r['date_of_capture'] for r in rows)} .. {max(r['date_of_capture'] for r in rows)}")

    # ---- 2. pull their children in bulk -----------------------------------
    t0 = time.time()
    kids = {f: {} for f in CHILD_TABLES}
    n_kids = 0
    for field, dt in CHILD_TABLES.items():
        slug = dt.lower().replace(" ", "_")
        try:
            flds = ["parent"] + child_fields(slug)
        except FileNotFoundError:
            continue
        for i in range(0, len(names), 300):
            batch_names = names[i:i + 300]
            got = src.get_list(dt, flds, [["parent", "in", batch_names]], parent=DOCTYPE)
            for r in got or []:
                parent = r.pop("parent")
                r["doctype"] = dt
                kids[field].setdefault(parent, []).append(r)
                n_kids += 1
    t_kids = time.time() - t0
    print(f"2. children     {n_kids:,} rows in {t_kids:.1f}s  ({n_kids/max(t_kids,0.001):,.0f}/sec)"
          f"   avg {n_kids/len(rows):.2f}/doc")

    # ---- 3. remap ----------------------------------------------------------
    remapped = 0
    for r in rows:
        for f in ("greenhouse", "block"):
            if r.get(f) in WAREHOUSE_REMAP:
                r[f] = WAREHOUSE_REMAP[r[f]]; remapped += 1
        for f in ("bed", "row", "zone"):
            if r.get(f):
                new = remap_geometry(r[f])
                if new != r[f]:
                    r[f] = new; remapped += 1
    print(f"3. remapped     {remapped} field value(s)")

    # ---- 4. link integrity on the target ----------------------------------
    checks = (("scouts_name", "Employee"), ("crop_scouted", "Crop Scouted"),
              ("greenhouse", "Warehouse"), ("bed", "Bed"), ("zone", "Zone"))
    missing = {}
    print("4. link check")
    for field, dt in checks:
        used = {r[field] for r in rows if r.get(field)}
        if not used:
            continue
        have = tgt.names_present(dt, used)
        gone = used - have
        if gone:
            missing[field] = gone
        print(f"     {field:12} -> {dt:14} used {len(used):5}  missing {len(gone)}"
              + (f"   e.g. {sorted(gone)[:2]}" if gone else ""))

    droppable = [r for r in rows
                 if any(r.get(f) in s for f, s in missing.items() if r.get(f))]
    if droppable:
        print(f"     dropping {len(droppable)} row(s) with a missing link — they would fail on insert")
    rows = [r for r in rows if r not in droppable]

    # ---- 5. dedupe against the target -------------------------------------
    dates = sorted({r["date_of_capture"] for r in rows if r.get("date_of_capture")})
    t0 = time.time()
    present = {natural_key(r) for r in tgt.get_list(
        DOCTYPE, list(KEY_FIELDS), [["date_of_capture", "in", dates]], limit=0)}
    t_pre = time.time() - t0
    print(f"5. pre-read     {len(present):,} existing observation(s) for these {len(dates)} date(s) in {t_pre:.1f}s")

    todo = []
    for r in rows:
        k = natural_key(r)
        if k in present:
            continue
        present.add(k)
        doc = {kk: vv for kk, vv in r.items() if kk != "name" and vv is not None}
        doc["doctype"] = DOCTYPE
        for field in CHILD_TABLES:
            ch = kids[field].get(r["name"])
            if ch:
                doc[field] = ch
        todo.append(doc)
    print(f"   -> {len(todo):,} to insert, {len(rows)-len(todo):,} already present")

    if not args.apply or not todo:
        print("\ndry run — nothing written.")
        return 0

    # ---- 6. the timed push ------------------------------------------------
    print(f"\n6. pushing {len(todo):,} docs in batches of {args.batch} ...")
    ok = fail = 0
    per_batch = []
    started = time.time()
    for i in range(0, len(todo), args.batch):
        chunk = todo[i:i + args.batch]
        tb = time.time()
        good, res = tgt.post_json("frappe.client.insert_many", {"docs": chunk})
        dt_b = time.time() - tb
        per_batch.append(dt_b)
        if good:
            ok += len(chunk)
        else:
            fail += len(chunk)
            if fail <= args.batch * 2:
                print(f"     ! batch at {i} failed: {str(res)[:220]}")
        done = i + len(chunk)
        el = time.time() - started
        print(f"     {done:>6}/{len(todo)}  batch {dt_b:5.2f}s  cumulative {done/el:6.1f} docs/sec", flush=True)

    el = time.time() - started
    rate = ok / max(el, 0.001)
    per_batch.sort()
    print("\n" + "=" * 64)
    print(f"inserted {ok:,}  failed {fail:,}  in {el:.1f}s")
    print(f"RATE: {rate:.1f} docs/sec   ({rate*3600/1000:.1f}k/hour)")
    if per_batch:
        print(f"batch latency: min {per_batch[0]:.2f}s  median {per_batch[len(per_batch)//2]:.2f}s  max {per_batch[-1]:.2f}s")
    remaining = 2593642
    print(f"\nextrapolated to the remaining {remaining:,} rows:")
    for w in (1, 2, 4, 8):
        print(f"   {w} worker(s): {remaining/(rate*w)/3600:6.1f} h")
    return 1 if fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
