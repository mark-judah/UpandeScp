import frappe


def dump_recent():
    rows = frappe.get_all(
        "Error Log",
        fields=["name", "creation", "method", "error"],
        order_by="creation desc",
        limit=10,
    )
    out = []
    for r in rows:
        out.append(f"--- {r.creation} | {r.method}\n{(r.error or '')[:2000]}\n")
    print("\n".join(out))


def backfill_wo_item_codes(apply: bool = False):
    """Scan AFP Work Orders for required_items rows whose ``item_code`` is
    not a real Item, resolve via ``item_name`` -> ``Item.name``, and patch.

    ``apply=False`` (default) — print what would happen, change nothing.
    ``apply=True`` — perform the writes inside a transaction.
    """
    rows = frappe.db.sql(
        """SELECT woi.name AS row_name,
                  woi.parent AS wo,
                  woi.item_code,
                  woi.item_name
             FROM `tabWork Order Item` woi
             JOIN `tabWork Order` wo ON wo.name = woi.parent
            WHERE wo.custom_type = 'Application Floor Plan'
              AND wo.docstatus < 2
              AND NOT EXISTS (SELECT 1 FROM `tabItem` i WHERE i.name = woi.item_code)
            ORDER BY woi.parent, woi.idx""",
        as_dict=True,
    )
    print(f"Found {len(rows)} broken required_items rows.")

    def resolve(value):
        value = (value or "").strip()
        if not value:
            return None
        if frappe.db.exists("Item", value):
            return value
        matches = frappe.get_all(
            "Item", filters={"item_name": value}, fields=["name"], limit=2
        )
        if len(matches) == 1:
            return matches[0]["name"]
        return None

    patched = 0
    ambiguous: list[tuple[str, str, int]] = []
    missing: list[tuple[str, str]] = []
    for row in rows:
        real = resolve(row.item_code) or (
            resolve(row.item_name) if row.item_name != row.item_code else None
        )
        if real is None:
            n = frappe.db.count("Item", {"item_name": row.item_code or ""})
            if n > 1:
                ambiguous.append((row.wo, row.item_code, n))
            else:
                missing.append((row.wo, row.item_code))
            continue
        print(f"  {row.wo}: '{row.item_code}' -> {real}")
        if apply:
            frappe.db.set_value(
                "Work Order Item",
                row.row_name,
                {
                    "item_code": real,
                    "item_name": frappe.db.get_value("Item", real, "item_name") or real,
                },
                update_modified=False,
            )
        patched += 1

    if ambiguous:
        print(f"\nAmbiguous ({len(ambiguous)}):")
        for wo, code, n in ambiguous:
            print(f"  {wo}: '{code}' matches {n} Items")
    if missing:
        print(f"\nMissing ({len(missing)}):")
        for wo, code in missing:
            print(f"  {wo}: '{code}'")
    if apply:
        frappe.db.commit()
    print(f"\n{'APPLIED' if apply else 'DRY RUN'}: patched={patched} ambiguous={len(ambiguous)} missing={len(missing)}")


def inspect_bom(bom_name: str = "BOM-pm-286"):
    """Show the BOM's exploded items + whether their item_code resolves."""
    rows = frappe.db.sql(
        """SELECT item_code, item_name, qty, stock_uom
             FROM `tabBOM Item`
            WHERE parent=%s
            ORDER BY idx""",
        (bom_name,),
        as_dict=True,
    )
    print(f"BOM {bom_name} items:")
    for r in rows:
        exists = frappe.db.exists("Item", r.item_code)
        by_name = frappe.db.get_value("Item", {"item_name": r.item_code}, "name") if not exists else None
        print(f"  item_code={r.item_code!r:35s} exists={bool(exists)} also_known_as_item_id={by_name!r}")


def find_item(needle: str = "SECURE"):
    """Find Item rows that look like the missing chemical so we can see
    the actual name, casing, and any trailing whitespace."""
    rows = frappe.db.sql(
        """SELECT name, item_name, item_group, disabled, CHAR_LENGTH(name) AS len
             FROM `tabItem`
            WHERE name LIKE %s
               OR item_name LIKE %s
               OR name LIKE %s
            ORDER BY name
            LIMIT 20""",
        (f"%{needle}%", f"%{needle}%", f"%{needle.lower()}%"),
        as_dict=True,
    )
    if not rows:
        print(f"No Item rows matching '{needle}'.")
        return
    for r in rows:
        print(f"  name={r.name!r:40s} item_name={r.item_name!r:30s} group={r.item_group!r:25s} disabled={r.disabled} chars={r.len}")


def find_required_in_wo(wo_name: str = "MFG-WO-2026-02355"):
    """Show the required_items rows for a WO + whether each Item exists."""
    rows = frappe.db.sql(
        """SELECT item_code, item_name, source_warehouse
             FROM `tabWork Order Item`
            WHERE parent=%s
            ORDER BY idx""",
        (wo_name,),
        as_dict=True,
    )
    print(f"Required items for {wo_name}:")
    for r in rows:
        exists = frappe.db.exists("Item", r.item_code)
        print(f"  item_code={r.item_code!r:40s} exists={bool(exists)} source_wh={r.source_warehouse}")


def dump_recent_approval_errors():
    """Latest 24h Spray Approval errors with full traceback context."""
    rows = frappe.db.sql(
        """SELECT creation, method, error
             FROM `tabError Log`
            WHERE creation >= NOW() - INTERVAL 24 HOUR
              AND (method LIKE %s OR method LIKE %s OR error LIKE %s)
            ORDER BY creation DESC
            LIMIT 8""",
        ("%Spray Approval%", "%spray_plan_approval%", "%approve_single_work_order%"),
        as_dict=True,
    )
    if not rows:
        print("No spray-plan approval errors in the last 24 hours.")
        return
    for r in rows:
        print(f"\n--- {r.creation} | {r.method}")
        print((r.error or "")[:3500])


def dump_user_state(email: str = "stephene@upande.com"):
    """Print roles + recent approval attempts for a given user."""
    print(f"=== User: {email}")
    if not frappe.db.exists("User", email):
        print("  (User does not exist on this site)")
        return
    roles = frappe.db.sql(
        "SELECT role FROM `tabHas Role` WHERE parent=%s ORDER BY role",
        (email,),
        as_dict=True,
    )
    role_names = [r.role for r in roles]
    print(f"  Roles ({len(role_names)}):")
    for r in role_names:
        marker = "  *" if r in ("General Manager", "System Manager", "Spray Plan Approver", "Spray Plan Creator") else "   "
        print(f"  {marker} {r}")
    print()

    # Recent approval-related activity log (the last 10 calls to spray_plan_approval)
    recent_logs = frappe.db.sql(
        """SELECT creation, status, error
             FROM `tabActivity Log`
            WHERE owner=%s
              AND creation >= NOW() - INTERVAL 1 DAY
            ORDER BY creation DESC
            LIMIT 5""",
        (email,),
        as_dict=True,
    )
    print(f"  Recent activity (last 24h, latest 5):")
    for log in recent_logs:
        print(f"    {log.creation} | status={log.status}")


def dump_approval_errors():
    """Find the actual Spray Approval failures — these get logged under
    titles like 'Spray Approval – create SE: <WO>' or 'Rate patch'."""
    rows = frappe.db.sql(
        """SELECT name, creation, method, error
             FROM `tabError Log`
            WHERE creation >= NOW() - INTERVAL 3 DAY
              AND (method LIKE %s OR method LIKE %s OR method LIKE %s
                   OR error LIKE %s)
            ORDER BY creation DESC
            LIMIT 10""",
        (
            "%Spray Approval%",
            "%QR gen%",
            "%Rate patch%",
            "%approve_single_work_order%",
        ),
        as_dict=True,
    )
    if not rows:
        print("No 'Spray Approval' errors logged in the last 3 days.")
        return
    for r in rows:
        print(f"\n--- {r.creation} | {r.method}")
        print((r.error or "")[:3500])


def dump_spray_plan_errors():
    """Find Error Log entries whose traceback mentions spray_plan_approval
    or approve_drafts_bulk. Filters by error body since `method` only
    captures the immediate caller, not the dispatch target."""
    rows = frappe.db.sql(
        """SELECT name, creation, method, error
             FROM `tabError Log`
            WHERE creation >= NOW() - INTERVAL 2 DAY
              AND (error LIKE %s OR error LIKE %s OR error LIKE %s
                   OR method LIKE %s OR method LIKE %s)
            ORDER BY creation DESC
            LIMIT 10""",
        (
            "%spray_plan_approval%",
            "%approve_drafts_bulk%",
            "%approve_single_work_order%",
            "%spray_plan_approval%",
            "%spray_plan_creator%",
        ),
        as_dict=True,
    )
    if not rows:
        print("No spray-plan approval errors in the last 48 hours.")
        return
    for r in rows:
        print(f"--- {r.creation} | {r.method}")
        print((r.error or "")[:3000])
        print()
