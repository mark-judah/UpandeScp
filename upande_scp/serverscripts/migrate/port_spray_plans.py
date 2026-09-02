"""Port Application Floor Plans and their BOMs to the target, for history only.

## What this does and deliberately does not do

Ports the BOMs and the Work Orders. It does NOT port Stock Entries, and it moves
NO STOCK — the target's opening balances are set separately. A BOM insert/submit
and a Work Order insert/submit write no Stock Ledger Entry, so the whole run is
inert as far as the ledger is concerned. That was verified on a pilot before this
was written: after porting one BOM and one Work Order, Stock Ledger Entry was
still 0.

Stock Entries are out of scope because they cannot be back-filled without either
moving stock or disabling the module's own guard. `stock_entry_state.before_validate`
rebuilds every AFP Manufacture from what was actually transferred into the CSU, and
refuses when nothing was — which is always true for a historical import that moves
no stock. That guard protects real spraying and is not worth weakening for history.

## Scope

Approved and not cancelled: workflow_state in APPROVED_STATES and docstatus != 2.
Plans that were never approved carry no history worth reading, and cancelled ones
were explicitly abandoned. That is 4,049 of 4,822 plans (84%).

## Names do not survive, twice over

BOM autonames per item (`BOM-rsm/thp-004` on the source becomes `BOM-rsm/thp-001`
on the target) and Work Order autonames from its own series. So a Work Order's
`bom_no` has to be rewritten to the target's BOM name, and both mappings are
recorded in MAP_FILE. That file is what makes a re-run skip rather than duplicate:
there is no natural key on these documents good enough to dedupe on.

    python3 port_spray_plans.py --plan
    python3 port_spray_plans.py --boms --apply
    python3 port_spray_plans.py --plans --apply
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import sys
import threading
import time
import urllib.parse
import urllib.request

import benchmark_scouting as B

MAP_FILE = "/home/ubuntu/scp_spray_name_map.json"
# Same file the scouting runner publishes to, so /migration shows whichever job is
# live without needing to know which one it is.
STATUS_FILE = "/tmp/scp_migration_status.json"
SCOPE_FILE = "/tmp/spray_scope.json"
# Every failure, with its reason. Printing only the first ten hid the shape of a
# 1,797-failure run behind a sample that turned out to be unrepresentative.
FAIL_LOG = "/home/ubuntu/scp_port_failures.jsonl"

APPROVED_STATES = {"Approved", "Chemical Issued", "Chemicals Issued Direct",
                   "Tank Mix Manufactured", "Spraying In Progress", "Completed"}

# Fields that belong to the source document's identity or its print styling, not
# to its history. Letter heads in particular are links the target does not carry,
# and a print header is not history.
STRIP = {"owner", "creation", "modified", "modified_by", "idx", "docstatus", "doctype",
         "_user_tags", "_comments", "_assign", "_liked_by", "parent", "parentfield",
         "parenttype", "amended_from", "lft", "rgt", "old_parent",
         "letter_head", "print_heading", "select_print_heading"}

_lock = threading.Lock()
_map_lock = threading.Lock()


_fail_lock = threading.Lock()


def record_failure(kind, name, detail):
    """Append every failure to FAIL_LOG so the shape of a bad run is knowable."""
    try:
        import re as _re
        m = _re.search(r'"exception":"([^"]{0,240})', str(detail))
        reason = m.group(1) if m else str(detail)[:240]
        with _fail_lock, open(FAIL_LOG, "a") as fh:
            fh.write(json.dumps({"kind": kind, "name": name, "reason": reason}) + "\n")
    except Exception:
        pass


def say(msg):
    with _lock:
        print(msg, flush=True)


def getdoc(site, doctype, name):
    req = urllib.request.Request(
        f"{site.url}/api/resource/{urllib.parse.quote(doctype)}/{urllib.parse.quote(name)}",
        headers={"Authorization": site.auth})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read())["data"]


def clean(doc, keep_name=False):
    out = {}
    for k, v in doc.items():
        if k in STRIP:
            continue
        if k == "name" and not keep_name:
            continue
        if isinstance(v, list):
            out[k] = [clean(x) for x in v]
        elif v is not None:
            out[k] = v
    return out


def rw(value):
    """The target's spelling of a warehouse. Same remap the scouting port uses."""
    return B.WAREHOUSE_REMAP.get(value, value) if value else value


class NameMap:
    """source name -> target name, for BOMs and Work Orders, persisted as we go."""

    def __init__(self, path=MAP_FILE):
        self.path = path
        try:
            self.data = json.load(open(path))
        except Exception:
            self.data = {"bom": {}, "wo": {}, "bom_wo": {}, "log": {}, "log_wo": {}, "log_status": {}}
        self.data.setdefault("bom", {})
        self.data.setdefault("wo", {})
        self.data.setdefault("bom_wo", {})   # source BOM -> source plan, for the backfill
        self.data.setdefault("log", {})
        self.data.setdefault("log_wo", {})
        self.data.setdefault("log_status", {})

    def get(self, kind, src):
        return self.data[kind].get(src)

    def put(self, kind, src, tgt):
        with _map_lock:
            self.data[kind][src] = tgt
            tmp = self.path + ".tmp"
            with open(tmp, "w") as fh:
                json.dump(self.data, fh)
            os.replace(tmp, self.path)


def ensure_masters(src, tgt, apply_it):
    """The one Item and the one Warehouse standing between us and 100%.

    `Bot/Rsm` is disabled on the source. It has to be created enabled — ERPNext
    refuses a disabled item in a transaction — and disabled again once the plans
    that use it are in. Doing that is the caller's job, after the port.
    """
    missing = []
    if not tgt.names_present("Item", {"Bot/Rsm"}):
        missing.append(("Item", "Bot/Rsm"))
    if not tgt.names_present("Warehouse", {"Pasteurization Unit - KR"}):
        missing.append(("Warehouse", "Pasteurization Unit - KR"))
    if not missing:
        say("  masters: all present")
        return True
    for doctype, name in missing:
        say(f"  masters: MISSING {doctype} {name}")
    if not apply_it:
        return False
    for doctype, name in missing:
        doc = clean(getdoc(src, doctype, name), keep_name=True)
        doc["doctype"] = doctype
        if doctype == "Item":
            doc["disabled"] = 0          # re-disabled after the port
        ok, res = tgt.post_json("frappe.client.insert", {"doc": doc})
        say(f"  masters: {'created' if ok else 'FAILED'} {doctype} {name}"
            + ("" if ok else f" — {str(res)[:200]}"))
        if not ok:
            return False
    return True


def port_bom(src, tgt, name, nmap):
    """Insert the BOM WITHOUT its back-link to the plan.

    BOM.custom_work_order points at the Application Floor Plan, while the plan's
    bom_no points back at the BOM — a cycle, so one end has to go in blank. The
    BOM goes first (the plan cannot be inserted without it) and the link is
    backfilled by the `--link` pass once the plans exist.
    """
    if nmap.get("bom", name):
        return "skip", None
    raw = getdoc(src, "BOM", name)
    doc = clean(raw, keep_name=False)
    doc["doctype"] = "BOM"
    if doc.pop("custom_work_order", None):
        nmap.put("bom_wo", name, raw.get("custom_work_order"))
    for row in doc.get("items", []):
        row["doctype"] = "BOM Item"
        if row.get("source_warehouse"):
            row["source_warehouse"] = rw(row["source_warehouse"])
    # BOM autonames as BOM-<item>-<nnn> from a counter that is not safe against
    # two workers inserting for the same item at once — they compute the same
    # number and the second gets a duplicate-key error. Retrying simply takes the
    # next number, so this is a race to ride out, not a failure.
    for attempt in range(5):
        ok, res = tgt.post_json("frappe.client.insert", {"doc": doc})
        if ok:
            break
        if "DuplicateEntryError" not in str(res):
            return "fail", str(res)[:200]
        time.sleep(0.2 * (attempt + 1))
    if not ok:
        return "fail", str(res)[:200]
    made = res["message"]["name"]
    nmap.put("bom", name, made)
    # Submitted so a Work Order can reference it; a BOM submit writes no ledger.
    tgt.post_json("frappe.client.submit", {"doc": getdoc(tgt, "BOM", made)})
    return "ok", made


def port_logsheet(src, tgt, name, nmap):
    """Insert the logsheet as a DRAFT, with its work_order link blank.

    Work Order.custom_spray_application_logsheet points here while this points
    back at the Work Order — the same cycle the BOM has. The logsheet goes in
    first (a plan cannot be inserted without it), stays a draft so the link can
    still be written afterwards, and is submitted by the `--link` pass once the
    plan exists. Its controller is `pass`, so submitting it does nothing beyond
    setting docstatus.
    """
    if nmap.get("log", name):
        return "skip", None
    raw = getdoc(src, "Spray Application Logsheet", name)
    doc = clean(raw, keep_name=False)
    doc["doctype"] = "Spray Application Logsheet"
    if doc.pop("work_order", None):
        nmap.put("log_wo", name, raw.get("work_order"))
    if doc.get("target_gh"):
        doc["target_gh"] = rw(doc["target_gh"])
    for row in doc.get("pesticides", []):
        row["doctype"] = "Spray Application Pesticide"
    for row in doc.get("applicators", []):
        row["doctype"] = "Spray Application Applicator"
    ok, res = tgt.post_json("frappe.client.insert", {"doc": doc})
    if not ok:
        return "fail", str(res)[:200]
    made = res["message"]["name"]
    nmap.put("log", name, made)
    nmap.put("log_status", name, str(raw.get("docstatus")))
    return "ok", made


def port_plan(src, tgt, name, nmap):
    if nmap.get("wo", name):
        return "skip", None
    doc = clean(getdoc(src, "Work Order", name), keep_name=False)
    state, status = doc.get("workflow_state"), doc.get("status")
    doc["doctype"] = "Work Order"
    mapped = nmap.get("bom", doc.get("bom_no"))
    if not mapped:
        return "fail", f"BOM not ported yet: {doc.get('bom_no')}"
    doc["bom_no"] = mapped
    # EVERY Link->Warehouse field on Work Order, not just the ERPNext three.
    # `custom_greenhouse` is SCP's own and holds the same names, so it needs the
    # same correction — 168 in-scope plans reference a greenhouse whose spelling
    # was fixed on the target.
    for f in ("fg_warehouse", "wip_warehouse", "source_warehouse",
              "scrap_warehouse", "custom_greenhouse"):
        if doc.get(f):
            doc[f] = rw(doc[f])
    for row in doc.get("required_items", []):
        row["doctype"] = "Work Order Item"
        for f in ("source_warehouse", "warehouse"):
            if row.get(f):
                row[f] = rw(row[f])
    if doc.get("custom_spray_application_logsheet"):
        mapped_log = nmap.get("log", doc["custom_spray_application_logsheet"])
        if not mapped_log:
            return "fail", f"logsheet not ported yet: {doc['custom_spray_application_logsheet']}"
        doc["custom_spray_application_logsheet"] = mapped_log
    doc.pop("status", None)          # ERPNext derives it; the historic one is stamped below
    ok, res = tgt.post_json("frappe.client.insert", {"doc": doc})
    if not ok:
        return "fail", str(res)[:200]
    made = res["message"]["name"]
    nmap.put("wo", name, made)
    tgt.post_json("frappe.client.submit", {"doc": getdoc(tgt, "Work Order", made)})
    # Stamped after submit: ERPNext owns `status` during submit and would overwrite
    # the historic value, and workflow_state is not part of its lifecycle at all.
    tgt.post_json("frappe.client.set_value",
                  {"doctype": "Work Order", "name": made,
                   "fieldname": {"workflow_state": state, "status": status}})
    return "ok", made


def link_boms(tgt, nmap, apply_it):
    """Close the cycle: set each ported BOM's custom_work_order to the ported plan."""
    pending = []
    for src_bom, src_wo in nmap.data.get("bom_wo", {}).items():
        t_bom, t_wo = nmap.get("bom", src_bom), nmap.get("wo", src_wo)
        if t_bom and t_wo:
            pending.append((t_bom, t_wo))
    say(f"  {len(pending):,} BOM->plan link(s) to restore")
    if not apply_it:
        return
    ok = fail = 0
    for t_bom, t_wo in pending:
        good, res = tgt.post_json("frappe.client.set_value",
            {"doctype": "BOM", "name": t_bom,
             "fieldname": {"custom_work_order": t_wo}})
        if good:
            ok += 1
        else:
            fail += 1
            if fail <= 5:
                say(f"    ! {t_bom}: {str(res)[:150]}")
    say(f"  BOM links restored: {ok:,} ok, {fail:,} failed")

    # Close the logsheet cycle, then submit. Order matters: work_order can only be
    # written while the logsheet is still a draft.
    ok = fail = sub = 0
    for src_log, src_wo in nmap.data.get("log_wo", {}).items():
        t_log, t_wo = nmap.get("log", src_log), nmap.get("wo", src_wo)
        if not (t_log and t_wo):
            continue
        good, res = tgt.post_json("frappe.client.set_value",
            {"doctype": "Spray Application Logsheet", "name": t_log,
             "fieldname": {"work_order": t_wo}})
        ok += 1 if good else 0
        fail += 0 if good else 1
    say(f"  logsheet links restored: {ok:,} ok, {fail:,} failed")
    for src_log, t_log in nmap.data.get("log", {}).items():
        if nmap.data.get("log_status", {}).get(src_log) != "1":
            continue
        good, _ = tgt.post_json("frappe.client.submit",
                                {"doc": getdoc(tgt, "Spray Application Logsheet", t_log)})
        sub += 1 if good else 0
    say(f"  logsheets submitted: {sub:,}")


def publish(job, phase, counts, total, started, running=True):
    """Write the snapshot /migration reads. Best-effort — a progress page is never
    worth failing a migration over."""
    try:
        el = time.time() - started
        done = counts["ok"] + counts["skip"] + counts["fail"]
        rate = counts["ok"] / max(el, 0.001)
        left = max(total - done, 0)
        snap = {
            "updated": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "running": running, "job": job, "phase": phase,
            "total": total, "inserted": counts["ok"], "present": counts["skip"],
            "blocked": 0, "failed": counts["fail"],
            "rate": round(rate, 1), "elapsed_h": round(el / 3600, 3),
            "eta_h": round(left / rate / 3600, 2) if rate > 0 else None,
            "days": {}, "active": {},
            "stages": [{"name": phase, "done": done, "total": total}],
            "blocked_scouts": [], "blocked_geo": [], "blocked_geo_count": 0,
        }
        tmp = STATUS_FILE + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(snap, fh)
        os.replace(tmp, STATUS_FILE)
    except Exception:
        pass


def run(kind, names, src, tgt, nmap, workers, apply_it):
    counts = {"ok": 0, "skip": 0, "fail": 0}
    errors = []
    label = {"bom": "BOMs", "log": "Logsheets"}.get(kind, "Work Orders")
    jobs = queue.Queue()
    for n in names:
        jobs.put(n)
    started = time.time()
    total = len(names)
    publish("spray-plans", label, counts, total, started)

    def worker(idx):
        while True:
            try:
                name = jobs.get_nowait()
            except queue.Empty:
                return
            try:
                if not apply_it:
                    counts["skip" if nmap.get(kind, name) else "ok"] += 1
                    continue
                fn = {"bom": port_bom, "log": port_logsheet}.get(kind, port_plan)
                outcome, detail = fn(src, tgt, name, nmap)
                counts[outcome] += 1
                if outcome == "fail":
                    record_failure(kind, name, detail)
                    if len(errors) < 10:
                        errors.append((name, detail))
                        say(f"    ! {name}: {detail}")
            except Exception as e:
                counts["fail"] += 1
                record_failure(kind, name, f"{type(e).__name__}: {e}")
                if len(errors) < 10:
                    errors.append((name, f"{type(e).__name__}: {e}"))
                    say(f"    ! {name}: {type(e).__name__}: {str(e)[:160]}")
            done = counts["ok"] + counts["skip"] + counts["fail"]
            if done % 25 == 0:
                publish("spray-plans", label, counts, total, started)
            if done % 100 == 0:
                el = time.time() - started
                say(f"    {done:>6,}/{total:,}  ok {counts['ok']:,}  skip {counts['skip']:,}"
                    f"  fail {counts['fail']:,}  {done/max(el,0.001):5.1f}/sec"
                    f"  ETA {(total-done)/max(done/max(el,0.001),0.001)/60:5.1f} min")

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(workers)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    el = time.time() - started
    publish("spray-plans", label, counts, total, started, running=False)
    say(f"  {kind}: {counts['ok']:,} ported, {counts['skip']:,} already there, "
        f"{counts['fail']:,} failed in {el/60:.1f} min")
    return counts, errors


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--boms", action="store_true")
    p.add_argument("--logs", action="store_true", help="port Spray Application Logsheets")
    p.add_argument("--plans", action="store_true")
    p.add_argument("--link", action="store_true",
                   help="restore BOM.custom_work_order after both passes")
    p.add_argument("--apply", action="store_true")
    p.add_argument("--plan", action="store_true", help="counts only")
    p.add_argument("--workers", type=int, default=2)
    p.add_argument("--limit", type=int, default=0)
    args = p.parse_args()

    se = B.load_env("~/.scp_migrate_from_site_env")
    te = B.load_env("~/.scp_migrate_target_site_env")
    src = B.Site(se["FROM_URL"], se["FROM_API_KEY"], se["FROM_API_SECRET"], "source")
    tgt = B.Site(te["TARGET_URL"], te["TARGET_API_KEY"], te["TARGET_API_SECRET"], "target")
    print(f"source : {src.url}")
    print(f"target : {tgt.url}")
    print(f"mode   : {'APPLY' if args.apply else 'DRY RUN'}  workers={args.workers}")

    scope = json.load(open(SCOPE_FILE))
    boms, plans = scope["boms"], scope["plans"]
    if args.limit:
        plans = plans[:args.limit]
        boms = boms[:args.limit]
    nmap = NameMap()
    print(f"\n  in scope : {len(boms):,} BOMs, {len(plans):,} plans")
    print(f"  already mapped: {len(nmap.data['bom']):,} BOMs, {len(nmap.data['wo']):,} plans")
    if args.plan:
        return 0

    if not ensure_masters(src, tgt, args.apply):
        print("  masters missing — 6 plans will fail. Re-run with --apply to create them.")

    if args.logs:
        logs = [r["name"] for r in json.load(open("/tmp/logsheets.json"))]
        if args.limit:
            logs = logs[:args.limit]
        print(f"\n=== Spray Application Logsheets ({len(logs):,})")
        run("log", logs, src, tgt, nmap, args.workers, args.apply)
    if args.boms:
        print(f"\n=== BOMs ({len(boms):,})")
        run("bom", boms, src, tgt, nmap, args.workers, args.apply)
    if args.plans:
        print(f"\n=== Work Orders ({len(plans):,})")
        run("wo", plans, src, tgt, nmap, args.workers, args.apply)
    if args.link:
        print("\n=== restoring BOM -> plan links")
        link_boms(tgt, nmap, args.apply)
    print(f"\n  name map: {MAP_FILE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
