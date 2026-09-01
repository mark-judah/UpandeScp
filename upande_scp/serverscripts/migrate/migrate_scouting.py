"""Migrate Scouting Entries source -> target, newest months first, two workers.

Straight from one site to the other: no intermediate JSON dumps, so there is
nothing to keep in step and nothing to run out of disk. `push_scouting.py` remains
for pushing dumps that already exist; this is the runner for the bulk move.

## Why two workers and not eight

Measured on 2026-09-01 against the live target:

    1 worker,  batch 200 : 104.7 docs/sec
    2 workers, batch  50 : 116.4 docs/sec
    3 workers, batch 200 : 116.3 docs/sec
    4 workers, batch  50 :  89.8 docs/sec   <- worse

~116 docs/sec is a ceiling, not a slope. Batch latency grows almost linearly with
worker count while throughput stays flat, which is what a serialization point looks
like — most likely the naming-series row lock (`UPDATE tabSeries SET current =
current + 1` for SCE-.YYYY.-), which every insert of this doctype queues behind.
Past two workers you add latency and memory for nothing.

`insert_many` also refuses more than 200 documents per request.

## Why it does not disturb the live site

A control request was probed continuously during those runs. Idle p95 was 77 ms;
with four pushers running and 4.7-second batches it was 75 ms, zero errors. The
site absorbs this load without users noticing, so no maintenance window is needed.

## Order

Newest first at both levels: the recent phase before the older one, and within a
phase the latest day before the earliest. The recent months are what people will
actually open on the morning after a cutover, and they are also the bulk —
June-September is 1.8M of the 2.6M outstanding. Ordering the days the other way
would leave yesterday's data until last, which defeats the point of the phases.
`--oldest-first` reverses it if you ever want a chronological fill.

## Resumability

Idempotent on the observation key (who looked, when, at which plant), never on the
document name — Scouting Entry autonames from a series, so the target's name has no
relation to the source's. Stop it, restart it, re-run a finished phase: it skips
what is already there. The dedupe pre-read is scoped to each day, so it stays a few
MB per worker rather than the 779 MB a whole-table read costs.

## Rows that cannot be moved

Skipped, counted and named, never invented:

  * scouts absent from the target — only Active Employees were ported, but history
    references whoever was on the farm at the time (3 scouts, ~1,489 entries),
  * beds and zones the target does not have (Torongo GH17: 18 beds, 96 zones).

    python3 migrate_scouting.py --plan                  # what it would do
    python3 migrate_scouting.py --phase recent --apply
    python3 migrate_scouting.py --apply                 # every phase, in order
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import queue
import sys
import threading
import time

import benchmark_scouting as B

BATCH = 200          # the API's hard cap
WORKERS = 2          # the measured optimum; see the module docstring
PAGE = 20000         # rows per source fetch
# Parents per child-row lookup. 300 was inherited from a GET query-string limit;
# these are POSTs, so the cap no longer applies. A 30,000-row day was costing
# 8 tables x 100 chunks = 800 round trips just to collect ~34,000 child rows.
KID_CHUNK = 2000

PHASES = [
    ("recent", "2026-06-01", "2026-10-01"),   # last three months — priority
    ("older",  "2026-01-01", "2026-06-01"),
]

STATUS_FILE = "/tmp/scp_migration_status.json"

_print_lock = threading.Lock()


def say(msg):
    with _print_lock:
        print(msg, flush=True)


def days(start, end, newest_first=True):
    """The days in [start, end), newest first by default.

    Order decides how soon the data is *useful*, not just how soon it is complete.
    Oldest-first would land June before September, so on the morning after a cutover
    the most recent week — the one people actually open — would be the last thing to
    arrive. Newest-first inverts that: yesterday is there within minutes.
    """
    d = dt.date.fromisoformat(start)
    last = dt.date.fromisoformat(end)
    out = []
    while d < last:
        out.append(d.isoformat())
        d += dt.timedelta(days=1)
    return list(reversed(out)) if newest_first else out


class Stats:
    """Counters plus a JSON snapshot for the progress page.

    The snapshot is written atomically (temp file + rename) so a reader can never
    catch it half-written, and it is a few KB — writing it on every day completion
    and every progress tick costs nothing measurable against a 200-document insert.
    """

    def __init__(self, status_file=STATUS_FILE, total=0, workers=2, phases=()):
        self.lock = threading.Lock()
        self.inserted = self.skipped = self.failed = self.dropped = 0
        self.started = time.time()
        self.absent_scouts = set()
        self.missing_geo = set()
        self.status_file = status_file
        self.total = total
        self.workers = workers
        self.phases = [{"name": n, "from": a, "to": b} for n, a, b in phases]
        self.phase = ""
        self.days = {}       # day -> {state, rows, inserted, blocked}
        self.active = {}     # worker -> {day, done, of, rate}
        self.running = True

    def add(self, **kw):
        with self.lock:
            for k, v in kw.items():
                if k in ("absent_scouts", "missing_geo"):
                    getattr(self, k).update(v)
                else:
                    setattr(self, k, getattr(self, k) + v)
        self.write()

    def mark(self, day, **fields):
        with self.lock:
            self.days.setdefault(day, {}).update(fields)
        self.write()

    def touch(self, worker, **fields):
        with self.lock:
            if fields:
                self.active[worker] = fields
            else:
                self.active.pop(worker, None)
        self.write()

    def snapshot(self):
        with self.lock:
            el = time.time() - self.started
            rate = self.inserted / max(el, 0.001)
            done = self.inserted + self.skipped + self.dropped
            left = max(self.total - done, 0)
            return {
                "updated": dt.datetime.now().isoformat(timespec="seconds"),
                "running": self.running,
                "workers": self.workers,
                "phase": self.phase,
                "phases": self.phases,
                "total": self.total,
                "inserted": self.inserted,
                "present": self.skipped,
                "blocked": self.dropped,
                "failed": self.failed,
                "rate": round(rate, 1),
                "elapsed_h": round(el / 3600, 3),
                "eta_h": round(left / rate / 3600, 2) if rate > 0 else None,
                "days": dict(self.days),
                "active": dict(self.active),
                "blocked_scouts": sorted(self.absent_scouts),
                "blocked_geo": sorted(self.missing_geo)[:40],
                "blocked_geo_count": len(self.missing_geo),
            }

    def write(self):
        if not self.status_file:
            return
        try:
            tmp = self.status_file + ".tmp"
            with open(tmp, "w") as fh:
                json.dump(self.snapshot(), fh)
            os.replace(tmp, self.status_file)
        except Exception:
            pass  # a progress page is never worth failing a migration over

    def line(self, total):
        el = time.time() - self.started
        rate = self.inserted / max(el, 0.001)
        left = max(total - self.inserted - self.skipped - self.dropped, 0)
        eta = left / rate / 3600 if rate else 0
        return (f"[{self.inserted:>9,} inserted | {self.skipped:>8,} present | "
                f"{self.dropped:>6,} dropped | {self.failed:>4,} failed] "
                f"{rate:6.1f}/sec  elapsed {el/3600:4.2f} h  ETA {eta:4.2f} h")


def fetch_day(src, day, crop=None, progress=None):
    """Every parent row for one day, paginated, with its child rows attached."""
    filters = [["date_of_capture", "=", day]]
    if crop:
        filters.append(["crop_scouted", "=", crop])
    rows, start = [], 0
    while True:
        page = src.call("frappe.client.get_list", doctype="Scouting Entry",
                        fields=json.dumps(B.PARENT_FIELDS), filters=json.dumps(filters),
                        limit_page_length=PAGE, limit_start=start, order_by="name asc")
        if not page:
            break
        rows.extend(page)
        if len(page) < PAGE:
            break
        start += PAGE
    if not rows:
        return [], {}
    names = [r["name"] for r in rows]
    if progress and len(names) > 5000:
        progress(f"{len(names):,} parents, fetching child rows ...")
    kids = {f: {} for f in B.CHILD_TABLES}
    for field, doctype in B.CHILD_TABLES.items():
        slug = doctype.lower().replace(" ", "_")
        try:
            flds = ["parent"] + B.child_fields(slug)
        except FileNotFoundError:
            continue
        for i in range(0, len(names), KID_CHUNK):
            got = src.get_list(doctype, flds,
                               [["parent", "in", names[i:i + KID_CHUNK]]],
                               parent="Scouting Entry")
            for r in got or []:
                parent = r.pop("parent")
                r["doctype"] = doctype
                kids[field].setdefault(parent, []).append(r)
    return rows, kids


def prepare(tgt, rows, kids, cache):
    """Remap, drop what the target cannot link, dedupe. Returns (docs, dropped, why)."""
    for r in rows:
        for f in ("greenhouse", "block"):
            if r.get(f) in B.WAREHOUSE_REMAP:
                r[f] = B.WAREHOUSE_REMAP[r[f]]
        for f in ("bed", "row", "zone"):
            if r.get(f):
                r[f] = B.remap_geometry(r[f])

    # A link the target does not have is BLOCKED, deliberately: the insert would
    # fail on the foreign key and take its whole 200-document batch with it, for a
    # row nobody can fix tonight. Two known causes, both to be dealt with later:
    # scouts who have left (only Active Employees were ported) and Torongo GH17's
    # beds and zones (never created on the target). Both are named in the summary.
    #
    # Absences are cached as well as presences, so a name known to be missing costs
    # one lookup for the whole run rather than one per day.
    why = {"scouts": set(), "geo": set(), "tree": set()}
    for field, doctype, bucket in (("scouts_name", "Employee", "scouts"),
                                   ("bed", "Bed", "geo"),
                                   ("zone", "Zone", "geo"),
                                   ("greenhouse", "Warehouse", "geo"),
                                   ("block", "Warehouse", "geo"),
                                   ("row", "Bed", "geo"),
                                   # Avocado only, ~12,600 entries. The source carries
                                   # legacy import codes (70HA_WESABLK6_ROW4_T31); the
                                   # target's were generated by the field automation
                                   # ("BLOCK BLK 1 - KL - Row 1 - Tree 1").
                                   # push_scouting.py rebuilds the name from row + tree
                                   # number; that map is not ported here yet, so these
                                   # are blocked rather than crashing their batch.
                                   ("tree", "Orchard Tree", "tree")):
        good = cache.setdefault(doctype, set())
        bad_known = cache.setdefault(doctype + "!", set())
        used = {r[field] for r in rows if r.get(field)}
        unknown = used - good - bad_known
        if unknown:
            found = tgt.names_present(doctype, unknown)
            good |= found
            bad_known |= (unknown - found)
        why[bucket] |= (used & bad_known)
    bad = why["scouts"] | why["geo"] | why["tree"]

    keep, dropped = [], 0
    LINKED = ("scouts_name", "bed", "zone", "greenhouse", "block", "row", "tree")
    for r in rows:
        if any(r.get(f) in bad for f in LINKED if r.get(f)):
            dropped += 1
            continue
        keep.append(r)

    # Scoped to this day only — an entry can only collide with one from the same day.
    day = rows[0]["date_of_capture"]
    present = {B.natural_key(r) for r in tgt.get_list(
        "Scouting Entry", list(B.KEY_FIELDS), [["date_of_capture", "=", day]], limit=0)}

    docs, skipped = [], 0
    for r in keep:
        k = B.natural_key(r)
        if k in present:
            skipped += 1
            continue
        present.add(k)
        d = {kk: vv for kk, vv in r.items() if kk != "name" and vv is not None}
        d["doctype"] = "Scouting Entry"
        for f in B.CHILD_TABLES:
            ch = kids[f].get(r["name"])
            if ch:
                d[f] = ch
        docs.append(d)
    return docs, dropped, skipped, why


def _insert_isolating(tgt, chunk, _depth=0):
    """Insert `chunk`, halving on failure so one bad row cannot sink good ones.

    Returns (inserted, failed, first_error). A single document that still fails is
    genuinely unlinkable and is reported rather than retried further.
    """
    good, res = tgt.post_json("frappe.client.insert_many", {"docs": chunk}, timeout=1800)
    if good:
        return len(chunk), 0, ""
    if len(chunk) == 1:
        return 0, 1, str(res)
    mid = len(chunk) // 2
    g1, b1, m1 = _insert_isolating(tgt, chunk[:mid], _depth + 1)
    g2, b2, m2 = _insert_isolating(tgt, chunk[mid:], _depth + 1)
    return g1 + g2, b1 + b2, m1 or m2


def worker(idx, jobs, src, tgt, stats, total, args):
    cache = {}
    while True:
        try:
            day = jobs.get_nowait()
        except queue.Empty:
            return
        try:
            stats.touch(f"w{idx}", day=day, stage="fetching", done=0, of=0, rate=0)
            rows, kids = fetch_day(src, day, args.crop,
                                   progress=lambda m: say(f"  w{idx} {day}    {m}"))
            if not rows:
                # Said out loud: a silent day is indistinguishable from a day the
                # runner never picked up, which is exactly what you want to know.
                say(f"  w{idx} {day}       0 rows -> nothing on the source")
                stats.mark(day, state="empty", rows=0, inserted=0, blocked=0)
                stats.touch(f"w{idx}")
                continue
            docs, dropped, skipped, why = prepare(tgt, rows, kids, cache)
            stats.add(skipped=skipped, dropped=dropped,
                      absent_scouts=why["scouts"], missing_geo=why["geo"] | why["tree"])
            if not docs:
                say(f"  w{idx} {day}  {len(rows):>6,} rows -> nothing to do "
                    f"({skipped:,} present, {dropped:,} dropped)")
                stats.mark(day, state="done", rows=len(rows), inserted=0, blocked=dropped)
                stats.touch(f"w{idx}")
                continue
            if not args.apply:
                say(f"  w{idx} {day}  {len(rows):>6,} rows -> WOULD push {len(docs):,} "
                    f"({skipped:,} present, {dropped:,} dropped)")
                continue

            ok = fail = 0
            t0 = time.time()
            nbatch = (len(docs) + args.batch - 1) // args.batch
            for i in range(0, len(docs), args.batch):
                chunk = docs[i:i + args.batch]
                good, res = tgt.post_json("frappe.client.insert_many", {"docs": chunk}, timeout=1800)
                if good:
                    ok += len(chunk)
                else:
                    # One unlinkable row used to take all 200 with it. Halve the
                    # chunk and retry: the bad rows are isolated in ~log2(n) extra
                    # requests instead of losing everything around them.
                    g, b, msg = _insert_isolating(tgt, chunk)
                    ok += g
                    fail += b
                    say(f"  w{idx} {day}  ! batch of {len(chunk)} partly failed: "
                        f"{g} saved, {b} unlinkable — {msg[:150]}")
                # Every ~4,000 docs. Without this a big day is silent for minutes,
                # which reads exactly like a hang to whoever is watching.
                bno = i // args.batch + 1
                stats.touch(f"w{idx}", day=day, stage="pushing", done=ok, of=len(docs),
                            rate=round(ok / max(time.time() - t0, 0.001), 1))
                if nbatch > 25 and bno % 20 == 0:
                    say(f"  w{idx} {day}    .. {ok:>6,}/{len(docs):,} "
                        f"({ok/max(time.time()-t0,0.001):5.1f}/sec)")
            stats.add(inserted=ok, failed=fail)
            blocked = ""
            if dropped:
                bits = []
                if why["scouts"]: bits.append(f"{len(why['scouts'])} scout")
                if why["geo"]: bits.append(f"{len(why['geo'])} geo")
                if why["tree"]: bits.append(f"{len(why['tree'])} tree")
                blocked = f", {dropped:,} BLOCKED ({'+'.join(bits)})"
            say(f"  w{idx} {day}  {len(rows):>6,} rows -> {ok:>6,} inserted "
                f"({skipped:,} present{blocked}) in {time.time()-t0:5.1f}s   {stats.line(total)}")
            stats.mark(day, state="done", rows=len(rows), inserted=ok, blocked=dropped)
            stats.touch(f"w{idx}")
        except Exception as e:
            stats.add(failed=1)
            stats.mark(day, state="error", rows=0, inserted=0, blocked=0)
            stats.touch(f"w{idx}")
            say(f"  w{idx} {day}  ! {type(e).__name__}: {str(e)[:200]}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--phase", choices=[n for n, _, _ in PHASES], help="one phase only")
    p.add_argument("--from-date"); p.add_argument("--to-date")
    p.add_argument("--crop")
    p.add_argument("--workers", type=int, default=WORKERS)
    p.add_argument("--batch", type=int, default=BATCH)
    p.add_argument("--apply", action="store_true")
    p.add_argument("--plan", action="store_true", help="counts per phase, then stop")
    p.add_argument("--status-file", default=STATUS_FILE,
                   help="JSON snapshot the progress page reads; '' to disable")
    p.add_argument("--oldest-first", action="store_true",
                   help="process each phase oldest day first (default is newest first)")
    args = p.parse_args()
    if args.batch > 200:
        sys.exit("insert_many refuses more than 200 documents per request")

    se = B.load_env("~/.scp_migrate_from_site_env")
    te = B.load_env("~/.scp_migrate_target_site_env")
    src = B.Site(se["FROM_URL"], se["FROM_API_KEY"], se["FROM_API_SECRET"], "source")
    tgt = B.Site(te["TARGET_URL"], te["TARGET_API_KEY"], te["TARGET_API_SECRET"], "target")
    print(f"source : {src.url}")
    print(f"target : {tgt.url}")
    print(f"mode   : {'APPLY' if args.apply else 'DRY RUN'}   workers={args.workers} batch={args.batch}"
          + (f" crop={args.crop}" if args.crop else ""))

    if args.from_date and args.to_date:
        phases = [("custom", args.from_date, args.to_date)]
    elif args.phase:
        phases = [ph for ph in PHASES if ph[0] == args.phase]
    else:
        phases = PHASES

    print("\nplan:")
    grand = 0
    for name, a, b in phases:
        n_src = src.call("frappe.client.get_count", doctype="Scouting Entry",
                         filters=json.dumps([["date_of_capture", ">=", a], ["date_of_capture", "<", b]]))
        n_tgt = tgt.call("frappe.client.get_count", doctype="Scouting Entry",
                         filters=json.dumps([["date_of_capture", ">=", a], ["date_of_capture", "<", b]]))
        todo = max(n_src - n_tgt, 0); grand += todo
        print(f"  {name:8} {a} .. {b}   source {n_src:>9,}  target {n_tgt:>9,}  todo {todo:>9,}"
              f"   ~{todo/116.4/3600:4.1f} h")
    print(f"  {'TOTAL':8} {'':24}{'':32} {grand:>9,}   ~{grand/116.4/3600:4.1f} h")
    if args.plan:
        return 0

    stats = Stats(status_file=args.status_file, total=grand,
                  workers=args.workers, phases=phases)
    for name, a, b in phases:
        day_list = days(a, b, newest_first=not args.oldest_first)
        stats.phase = name
        for d in day_list:
            stats.days.setdefault(d, {"state": "pending"})
        stats.write()
        print(f"\n=== phase {name}: {a} .. {b}  ({len(day_list)} days, "
              f"{'oldest' if args.oldest_first else 'newest'} first: "
              f"{day_list[0]} -> {day_list[-1]})")
        # Only get_nowait() and thread joins are used, never jobs.join(), so
        # task_done() is deliberately not called — calling it from both the
        # early-continue branches and a finally block double-counted and raised
        # "task_done() called too many times" mid-run.
        jobs = queue.Queue()
        for d in day_list:
            jobs.put(d)
        threads = [threading.Thread(target=worker, args=(i + 1, jobs, src, tgt, stats, grand, args))
                   for i in range(args.workers)]
        for t in threads: t.start()
        for t in threads: t.join()
        print(f"--- phase {name} done: {stats.line(grand)}")

    stats.running = False
    stats.write()
    print("\n" + "=" * 78)
    print(stats.line(grand))
    if stats.absent_scouts:
        print(f"scouts absent from the target ({len(stats.absent_scouts)}): {', '.join(sorted(stats.absent_scouts))}")
    if stats.missing_geo:
        g = sorted(stats.missing_geo)
        print(f"geometry absent from the target ({len(g)}): {', '.join(g[:6])}"
              + (f" ... +{len(g)-6} more" if len(g) > 6 else ""))
    return 1 if stats.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
