import gzip, json, time, frappe
from upande_scp.serverscripts import dashboard_aggregates as DA

W = {"from_date": "2026-07-01", "to_date": "2026-07-13"}
GH = "Torongo GH 16 - KR"

def run():
    print("=== A. REAL gzip ratios at nginx's level 5 ===")
    cases = [("overview", {}), ("pests", {}), ("trends", {}),
             ("heatmaps_grid", {}), ("application_plan_diagnose", {"greenhouse": GH})]
    tot_raw = tot_gz = 0
    for name, extra in cases:
        out = getattr(DA, name)(**W, **extra, crop="Rose", force=1)
        raw = json.dumps(out, default=str).encode()
        gz = gzip.compress(raw, 5)
        tot_raw += len(raw); tot_gz += len(gz)
        print(f"  {name:28s} {len(raw)/1024:9.1f} KB -> {len(gz)/1024:8.1f} KB  {len(raw)/len(gz):5.1f}x")

    # the big one: geometry
    from upande_scp.serverscripts.geo import get_beds_and_zones as G
    frappe.local.response = frappe._dict()
    G.getBedsAndZones()
    geo = frappe.local.response.get("data") or frappe.local.response.get("message")
    if geo is not None:
        raw = json.dumps(geo, default=str).encode(); gz = gzip.compress(raw, 5)
        tot_raw += len(raw); tot_gz += len(gz)
        print(f"  {'getBedsAndZones':28s} {len(raw)/1048576:9.1f} MB -> {len(gz)/1048576:8.2f} MB  {len(raw)/len(gz):5.1f}x")
    print(f"  {'TOTAL':28s} {tot_raw/1048576:9.1f} MB -> {tot_gz/1048576:8.2f} MB  {tot_raw/max(tot_gz,1):5.1f}x")

    print("\n=== B. is the aggregate cache SHARED between users? ===")
    from upande_scp.serverscripts.dashboard_aggregates import _common as C
    k = C._build_key("overview", {"a": 1})
    print(f"  cache key shape: {k}")
    print(f"  contains a user id? {'YES - per-user' if frappe.session.user in k else 'NO - shared across all users'}")
    print(f"  backing store   : {type(frappe.cache()).__name__} (Redis, shared per-site)")
    print(f"  TTL             : {C.DASH_AGG_TTL}s")

    print("\n=== C. scaling: cost per 1000 parent rows ===")
    for lbl, w in [("1 day  (~22k rows)", {"from_date":"2026-07-13","to_date":"2026-07-13"}),
                   ("13 days (291k rows)", W)]:
        n = frappe.db.sql("SELECT COUNT(*) FROM `tabScouting Entry` WHERE date_of_capture BETWEEN %(from_date)s AND %(to_date)s", w)[0][0]
        t = time.time(); DA.overview(**w, crop="Rose", force=1); e1 = time.time()-t
        t = time.time(); DA.heatmaps_grid(**w, crop="Rose", force=1); e2 = time.time()-t
        print(f"  {lbl:22s} rows={n:7d}  overview={e1*1000:7.0f}ms ({e1*1e6/max(n,1):5.1f}us/row)"
              f"  heatmaps={e2*1000:7.0f}ms ({e2*1e6/max(n,1):5.1f}us/row)")
