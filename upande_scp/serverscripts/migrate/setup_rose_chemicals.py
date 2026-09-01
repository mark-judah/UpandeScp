"""Put the CHEM PR product list into its own Item Group and register it.

The crop-protection layer classifies a product by its Item Group, not per item:
`crop_protection.product_groups()` feeds an `item_group in (...)` filter that the
scouting product picker, the tank-mix BOM builder and the store dashboards all
sit behind. A `Chemical` sidecar for an item whose group is not configured is
invisible to every one of them. So making this list usable means giving the
items a group of their own and naming that group in the settings.

An Item belongs to exactly one Item Group, so this MOVES the items — they leave
Post Harvest Treatment Chemicals, Disinfectant, Consumables Purchased,
Fertilizer and Biological Control Agents. Anything grouping by those categories
will stop counting them.

    python3 setup_rose_chemicals.py             # dry run
    python3 setup_rose_chemicals.py --apply

Credentials come from ~/.scp_migrate_staging_env. See target.py.
"""

from __future__ import annotations

import argparse
import json
import sys

import target as T

GROUP = "Rose Chemicals"
PARENT_GROUP = "Chemicals"
SETTINGS = "Scouting and Crop Protection Settings"

# Resolved against the target by exact item code, so a rename on either side is
# caught as a miss rather than silently matching the wrong product.
#   (sheet name, target item code, expected item_name, confidence)
PRODUCTS = [
	("Calcium Hypochlorite", "1010100028", "CALCIUM HYPOCHLORITE", "exact"),
	("Aluminum Sulphate", "1116005", "ALUMINIUM SULPHATE", "spelling"),
	("Sporekill", "1117004", "Sporekill", "exact"),
	("Dipnoy 60-B", "1111166010", "Dipnoy", "variant"),
	("TOG 10", "1111166014", "TOG 10", "exact"),
	("TOG L103", "1111166017", "TOG L103", "exact"),
	("TOG 3", "1111166018", "TOG 03", "spelling"),
	("TOG L 101", "1111166015", "TOG L101", "spelling"),
	("Physan 20", "1111155004", "PHYSAN-Disnfectant", "variant"),
	("TOG 75", "1111166016", "TOG-75 (Silver Thiosulfate)", "exact"),
	("Prenoy 600", "1111166013", "Prenoy 600", "exact"),
	("OPTIGYP", "1212100528", "Optigyp (Dextrose)", "exact"),
	("CHRYSAL GVB", "1212100250", "Chrysal AVB 1 Litre - 542274228", "UNCERTAIN"),
	("TOG 6", "1111166021", "TOG 6", "exact"),
	("Evisect", "1111133023", "Evisect", "exact"),
	("BEAUVITECH - Beauveria bassiana 250 Grams", "1111180031", "BEAUVITECH - Beauveria bassiana 250 Grams", "exact"),
]
# In the sheet, on neither site: "Multi Purpose Detergent soap".


def _put(t, doctype, name, payload):
	r = t._request(
		"PUT",
		"/api/resource/{}/{}".format(doctype, str(name).replace("/", "%2F")),
		data=json.dumps(payload),
	)
	return (True, None) if r.ok else (False, r.text[:200])


def _doc(t, doctype, name):
	r = t._request("GET", "/api/resource/{}/{}".format(doctype, str(name).replace("/", "%2F")))
	if not r.ok:
		raise T.TargetError("reading {} {}: HTTP {} {}".format(doctype, name, r.status_code, r.text[:120]))
	return r.json()["data"]


def main():
	p = argparse.ArgumentParser()
	p.add_argument("--apply", action="store_true", help="write; without it this only reports")
	args = p.parse_args()

	t = T.Target()
	print(t.describe())
	print("mode:", "APPLY — this writes" if args.apply else "dry run — nothing is written")
	print()

	# ---- 1. verify every item resolves, and show what it is leaving --------
	print("[items] resolving the sheet against the target")
	resolved, problems = [], []
	for sheet_name, code, expect, confidence in PRODUCTS:
		rows = t.get_list("Item", fields=["name", "item_name", "item_group", "disabled"],
		                  filters={"name": code}, limit=1)
		if not rows:
			problems.append((sheet_name, code, "no such item"))
			print("    ! {:<30} {:<14} NOT FOUND".format(sheet_name[:30], code))
			continue
		it = rows[0]
		flag = "  <-- CONFIRM" if confidence == "UNCERTAIN" else ""
		print("    {:<30} {:<14} {:<34} from {}{}".format(
			sheet_name[:30], code, (it["item_name"] or "")[:34], it["item_group"], flag))
		if (it["item_name"] or "").strip() != expect.strip():
			problems.append((sheet_name, code, "name is {!r}, expected {!r}".format(it["item_name"], expect)))
		resolved.append(it)

    # A rename on the target would otherwise move the wrong product.
	if problems:
		print("\n    ! {} item(s) did not match as expected:".format(len(problems)))
		for n, c, why in problems:
			print("        {} ({}): {}".format(n, c, why))
		print("    Refusing to move anything until these are resolved.")
		return 1

	from collections import Counter
	print("\n    groups these items are leaving:")
	for g, n in Counter(i["item_group"] for i in resolved).most_common():
		total = t.count("Item", {"item_group": g}) or 0
		print("        {:<50} {} of {} item(s)".format(g[:50], n, total))

	# ---- 2. the group ------------------------------------------------------
	print("\n[group] {}".format(GROUP))
	exists = t.get_list("Item Group", fields=["name", "parent_item_group", "is_group"],
	                    filters={"name": GROUP}, limit=1)
	if exists:
		print("    · already exists (parent {})".format(exists[0].get("parent_item_group")))
	elif not args.apply:
		print("    ~ would create under {}".format(PARENT_GROUP))
	else:
		ok, res = t.insert("Item Group", {
			"doctype": "Item Group",
			"item_group_name": GROUP,
			"parent_item_group": PARENT_GROUP,
			"is_group": 0,
		})
		print("    {} {}".format("+ created" if ok else "! failed:", res))
		if not ok:
			return 1

	# ---- 3. move the items -------------------------------------------------
	print("\n[move] {} item(s) -> {}".format(len(resolved), GROUP))
	moved = failed = already = 0
	for it in resolved:
		if it["item_group"] == GROUP:
			already += 1
			continue
		if not args.apply:
			print("    ~ would move {:<14} {}".format(it["name"], (it["item_name"] or "")[:40]))
			moved += 1
			continue
		ok, err = _put(t, "Item", it["name"], {"item_group": GROUP})
		if ok:
			moved += 1
			print("    + {:<14} {}".format(it["name"], (it["item_name"] or "")[:40]))
		else:
			failed += 1
			print("    ! {:<14} {}".format(it["name"], err))
	print("    {} moved, {} already there, {} failed".format(moved, already, failed))

	# ---- 4. register the group so the app can see it ------------------------
	print("\n[settings] register {} as a chemical group".format(GROUP))
	s = _doc(t, SETTINGS, SETTINGS)
	current = [r.get("item_group") for r in (s.get("chemical_item_groups") or [])]
	print("    chemical groups now: {}".format(current or "— none configured"))
	if GROUP in current:
		print("    · {} already registered".format(GROUP))
	elif not args.apply:
		print("    ~ would add {} -> {}".format(GROUP, current + [GROUP]))
	else:
		rows = [{"item_group": g} for g in current + [GROUP]]
		ok, err = _put(t, SETTINGS, SETTINGS, {"chemical_item_groups": rows})
		print("    {} {}".format("+ registered" if ok else "! failed:", err or GROUP))
		if not ok:
			return 1

	print("\n" + "=" * 66)
	print("After applying, {} Item(s) classify as chemical and the Chemical".format(len(resolved)))
	print("sidecars can be seeded (crop_protection.ensure_product_record).")
	return 0


if __name__ == "__main__":
	sys.exit(main())
