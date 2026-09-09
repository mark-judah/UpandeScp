"""Port the spray Stock Entries to the target as DRAFTS, for history only.

## Nothing is submitted, so nothing moves

Every entry goes in with docstatus 0. A draft Stock Entry writes no Stock Ledger
Entry and no GL Entry, which is the whole point: the target's stock position is
set by its own opening balances, not by replaying eight months of movements.

## The three kinds, renamed to the current convention

    Material Transfer for Manufacture  ->  CSU Chemical Transfer
    Manufacture                        ->  Chemical Mixing
    Material Issue                     ->  Chemical Spray

`purpose` is untouched — ERPNext derives it from the type, so anything that
dispatches on purpose still works.

## Finding the sprays

A spray Material Issue carries no `work_order`, so it cannot be found by link.
It carries the *finished-good row* of its Manufacture — the tank-mix item — issued
out of the greenhouse (see auto_material_issue.build_and_submit_material_issue).
So each Issue is paired to a Manufacture on (item_code, qty, greenhouse, date),
and inherits that Manufacture's plan. Pairs that are ambiguous or unmatched are
left alone rather than guessed at.

## Two guards to get past

VALUATION. The target has no valuation for these items, so a row without a rate
is refused with "Valuation Rate for the Item is required". Every row is flagged
`allow_zero_valuation_rate` — correct for a historical record that is not costing
anything.

THE CSU GUARD. `stock_entry_state.before_validate` rebuilds every AFP Manufacture
from the Material Transfer that actually reached the CSU, and throws when none
did — which is always true here, because we submit nothing. It only fires when
`purpose == "Manufacture"` AND `work_order` names an AFP, so a Chemical Mixing
entry is inserted WITHOUT its work_order and carries the plan in `remarks`
instead. Transfers keep their real link; sprays never had one.

That is a real loss of traceability on the Mixing and Spray entries, and it is
the price of moving no stock. Submitting them would restore the link and post
the ledger; that was decided against.

    python3 port_spray_stock.py --plan
    python3 port_spray_stock.py --apply --limit 50
    python3 port_spray_stock.py --apply
"""

from __future__ import annotations

import argparse
import json
import os
import time

import benchmark_scouting as B

MAP_FILE = "/home/ubuntu/scp_spray_name_map.json"
STATUS_FILE = "/tmp/scp_migration_status.json"

RENAME = {
    "Material Transfer for Manufacture": "CSU Chemical Transfer",
    "Manufacture": "Chemical Mixing",
    "Material Issue": "Chemical Spray",
}

HEAD_FIELDS = ["name", "purpose", "stock_entry_type", "company", "posting_date",
               "posting_time", "work_order", "bom_no", "from_warehouse",
               "to_warehouse", "remarks", "fg_completed_qty", "docstatus",
               "cost_center", "project", "farm"]

ITEM_FIELDS = ["parent", "idx", "item_code", "item_name", "description", "item_group",
               "qty", "transfer_qty", "uom", "stock_uom", "conversion_factor",
               "s_warehouse", "t_warehouse", "bom_no", "is_finished_item",
               "expense_account", "cost_center", "batch_no", "serial_no"]

BATCH = 50


def rw(v):
    return B.WAREHOUSE_REMAP.get(v, v) if v else v


def publish(phase, counts, total, started, running=True):
    try:
        el = time.time() - started
        done = counts["ok"] + counts["skip"] + counts["fail"]
        rate = counts["ok"] / max(el, 0.001)
        snap = {"updated": time.strftime("%Y-%m-%dT%H:%M:%S"), "running": running,
                "job": "spray-stock", "phase": phase, "total": total,
                "inserted": counts["ok"], "present": counts["skip"], "blocked": 0,
                "failed": counts["fail"], "rate": round(rate, 1),
                "elapsed_h": round(el / 3600, 3),
                "eta_h": round(max(total - done, 0) / rate / 3600, 2) if rate > 0 else None,
                "days": {}, "active": {},
                "stages": [{"name": phase, "done": done, "total": total}],
                "blocked_scouts": [], "blocked_geo": [], "blocked_geo_count": 0}
        tmp = STATUS_FILE + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(snap, fh)
        os.replace(tmp, STATUS_FILE)
    except Exception:
        pass


def load_plan():
    """Which source Stock Entries to port, and which target plan each belongs to."""
    nmap = json.load(open(MAP_FILE))
    wo_map = nmap["wo"]
    bom_map = nmap["bom"]
    ses = json.load(open("/tmp/afp_ses.json"))          # Transfer + Manufacture, has work_order
    pairing = json.load(open("/tmp/issue_pairing.json"))["issue_to_wo"]

    want = {}
    for s in ses:
        if s.get("docstatus") != 1:
            continue
        tgt_wo = wo_map.get(s.get("work_order"))
        if not tgt_wo:
            continue
        want[s["name"]] = tgt_wo
    for issue, src_wo in pairing.items():
        tgt_wo = wo_map.get(src_wo)
        if tgt_wo:
            want[issue] = tgt_wo
    return want, bom_map, nmap


def fetch(src, names):
    """Headers and item rows for `names`, in bulk — no per-document GETs."""
    heads = {}
    for i in range(0, len(names), 300):
        for h in src.get_list("Stock Entry", HEAD_FIELDS,
                              [["name", "in", names[i:i + 300]]], limit=0) or []:
            heads[h["name"]] = h
    items = {}
    for i in range(0, len(names), 300):
        for r in src.get_list("Stock Entry Detail", ITEM_FIELDS,
                              [["parent", "in", names[i:i + 300]]],
                              parent="Stock Entry", limit=0) or []:
            items.setdefault(r.pop("parent"), []).append(r)
    for rows in items.values():
        rows.sort(key=lambda r: r.get("idx") or 0)
    return heads, items


def build(head, rows, tgt_wo, bom_map):
    doc = {k: v for k, v in head.items()
           if k not in ("name", "docstatus") and v is not None}
    doc["doctype"] = "Stock Entry"
    doc["stock_entry_type"] = RENAME[head["purpose"]]
    doc["set_posting_time"] = 1
    if doc.get("bom_no"):
        doc["bom_no"] = bom_map.get(doc["bom_no"], doc["bom_no"])
    for f in ("from_warehouse", "to_warehouse"):
        if doc.get(f):
            doc[f] = rw(doc[f])
    out = []
    for r in rows:
        it = {k: v for k, v in r.items() if k != "idx" and v is not None}
        it["doctype"] = "Stock Entry Detail"
        # Historical rows are not being costed; without this the target refuses
        # them for having no valuation.
        it["allow_zero_valuation_rate"] = 1
        if it.get("bom_no"):
            it["bom_no"] = bom_map.get(it["bom_no"], it["bom_no"])
        for f in ("s_warehouse", "t_warehouse"):
            if it.get(f):
                it[f] = rw(it[f])
        out.append(it)
    doc["items"] = out
    # NO entry carries its work_order, and each names its plan in `remarks` instead.
    #
    #   Manufacture  — a work_order pointing at an AFP trips the CSU guard, which
    #                  rebuilds the consumption from a transfer that never landed.
    #   Transfer     — ERPNext caps a Material Transfer for Manufacture at what the
    #                  work order still needs. These plans are stamped Completed and
    #                  there is no chemical stock, so the cap is 0 and every row is
    #                  refused with "Maximum transferable quantity is 0.0".
    #   Material Issue — never had one on the source.
    #
    # Both caps exist to protect real spraying. Keeping the link would mean
    # submitting these entries and moving stock, which was decided against.
    doc.pop("work_order", None)
    doc["remarks"] = f"Application Floor Plan {tgt_wo} (source {head['name']})"
    return doc


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--apply", action="store_true")
    p.add_argument("--plan", action="store_true")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--batch", type=int, default=BATCH)
    args = p.parse_args()

    se = B.load_env("~/.scp_migrate_from_site_env")
    te = B.load_env("~/.scp_migrate_target_site_env")
    src = B.Site(se["FROM_URL"], se["FROM_API_KEY"], se["FROM_API_SECRET"], "source")
    tgt = B.Site(te["TARGET_URL"], te["TARGET_API_KEY"], te["TARGET_API_SECRET"], "target")
    print(f"source : {src.url}\ntarget : {tgt.url}")
    print(f"mode   : {'APPLY' if args.apply else 'DRY RUN'}  batch={args.batch}")

    want, bom_map, nmap = load_plan()
    done = set(nmap.setdefault("se", {}))
    todo = [n for n in want if n not in done]
    if args.limit:
        todo = todo[:args.limit]
    print(f"\n  in scope        : {len(want):,} stock entries")
    print(f"  already ported  : {len(done):,}")
    print(f"  to port now     : {len(todo):,}")
    if args.plan or not todo:
        return 0

    counts = {"ok": 0, "skip": 0, "fail": 0}
    started = time.time()
    fails = []
    for i in range(0, len(todo), args.batch):
        chunk = todo[i:i + args.batch]
        heads, items = fetch(src, chunk)
        docs, names = [], []
        for n in chunk:
            h = heads.get(n)
            if not h or not items.get(n):
                counts["fail"] += 1
                fails.append((n, "header or items missing on source"))
                continue
            docs.append(build(h, items[n], want[n], bom_map))
            names.append(n)
        if not docs:
            continue
        # insert_many returns the created names in order, which is what lets the
        # map be recorded without a second lookup.
        good, res = tgt.post_json("frappe.client.insert_many", {"docs": docs}, timeout=1800)
        if good:
            made = res.get("message") or []
            for n, m in zip(names, made):
                nmap["se"][n] = m
            counts["ok"] += len(made)
        else:
            # One bad row must not cost the batch; fall back to one at a time.
            for n, d in zip(names, docs):
                g2, r2 = tgt.post_json("frappe.client.insert", {"doc": d}, timeout=900)
                if g2:
                    nmap["se"][n] = r2["message"]["name"]
                    counts["ok"] += 1
                else:
                    counts["fail"] += 1
                    fails.append((n, str(r2)[:200]))
        tmp = MAP_FILE + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(nmap, fh)
        os.replace(tmp, MAP_FILE)
        el = time.time() - started
        d = counts["ok"] + counts["fail"]
        publish("Stock Entries", counts, len(todo), started)
        print(f"    {d:>6,}/{len(todo):,}  ok {counts['ok']:,}  fail {counts['fail']:,}"
              f"  {counts['ok']/max(el,0.001):5.1f}/sec  ETA {(len(todo)-d)/max(counts['ok']/max(el,0.001),0.001)/60:5.1f} min",
              flush=True)
    publish("Stock Entries", counts, len(todo), started, running=False)
    el = time.time() - started
    print(f"\n  ported {counts['ok']:,}, failed {counts['fail']:,} in {el/60:.1f} min"
          f"  ({counts['ok']/max(el,0.001):.1f}/sec)")
    for n, why in fails[:10]:
        print(f"    ! {n}: {why}")
    return 1 if counts["fail"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
