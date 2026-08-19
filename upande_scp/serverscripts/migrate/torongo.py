import frappe
from upande_scp.serverscripts.migrate.target import Target


def run():
    t = Target()
    have = sorted(n for n in t.names("Warehouse") if "orongo" in n)
    mine = sorted(frappe.get_all("Warehouse", filters={"custom_farm": "Torongo"}, pluck="name"))
    print("Torongo on TARGET:", have)
    print()
    print("Torongo HERE     :", mine)
    print()
    missing = [m for m in mine if m not in set(have)]
    print("here but not on target:", missing)
    # Does a space-normalised match exist?
    norm = {n.replace(" ", "").upper(): n for n in have}
    for m in missing:
        key = m.replace(" ", "").upper()
        print(f"  {m!r:<26} -> normalised match: {norm.get(key)!r}")
