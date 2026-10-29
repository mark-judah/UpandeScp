"""Seed what Mutara's open-field spray plan needs to be usable end to end (demo data).

    bench --site mutara.local execute \
        upande_scp.serverscripts.migrate.seed_mutara_spray_plan.run

    bench --site mutara.local execute \
        upande_scp.serverscripts.migrate.seed_mutara_spray_plan.run --kwargs "{'dry_run': True}"

Idempotent and re-runnable: every record is looked up before it is made, existing records are
never overwritten, so a second run creates nothing (it picks up the Saitoti user once he exists).

What it seeds, for farm Mutara:

* Farm "Spray Plan Creators" roster: Administrator and saitoti@mutaraorchards.com (when the user
  exists), who also get the SCP creator / approver / general-manager roles;
* two Spray Teams named after the farm, with demo members from the farm's employees;
* registered targets on every pest-control Spray Product that has none (Kaitet's registrations for
  the same products, mapped onto Mutara's pests and diseases, plus agronomic ones);
* a spray kit (Spray Equipment) pointing at the "Work In Progress" warehouse, which gets the farm;
* tank-mix BOMs (Item Group "Chemical Mix") built from the chemicals, adjuvants and foliars in stock;
* an area on the two demo avocado blocks (a plan needs one for its water volume);
* the demo scout Stephene (user with SCP Scout, plus Stock User which is what lets the handset read the
  Farm and Warehouse lists its farm picker uses - Scout alone cannot, as on Kaitet; an Employee of the company, which is what
  scopes his scouting to Mutara); the password is read from the MUTARA_SCOUT_PASSWORD environment
  variable and never lives in code - without it the user is made with a random password;
* a few weeks of scouting on avocado and pivot blocks with findings that fit each block's crop.

Never touched: the production blocks' warehouses, cost centres and budgets.
"""
import random

import frappe
from frappe.utils import add_days, nowdate

FARM = "Mutara"
COMPANY = "Mutara"
ROSTER_USERS = ["Administrator", "saitoti@mutaraorchards.com"]
DEMO_SCOUT = {"email": "stephene@mutaraorchards.com", "first_name": "Stephene", "designation": "Scout",
              "roles": ["SCP Scout", "Stock User"], "password_env": "MUTARA_SCOUT_PASSWORD"}
ROSTER_ROLES = ["SCP Spray Plan Creator", "SCP Spray Plan Approver", "SCP General Manager"]
WIP_WAREHOUSE = "Work In Progress - MUT"
TANK_MIX_UOM = "Tank Mix (1000L)"
TANK_MIX_GROUP = "Chemical Mix"
SEED_NOTE = "Demo scouting round (seed_mutara_spray_plan)"

TEAMS = ["Mutara Spray Team A", "Mutara Spray Team B"]
MEMBER_ROLES = ["Supervisor", "Sprayer", "Sprayer", "Pump Operator"]

KITS = ["Mutara Knapsack Kit 1", "Mutara Knapsack Kit 2", "Mutara Boom Sprayer Kit"]

#: Area for the demo avocado blocks that have none (ha).
AVOCADO_AREAS = {"Avocado Block A - MUT": 4.2, "Avocado Block B - MUT": 3.6}

# --------------------------------------------------------------------------
# Registered targets: Spray Product item -> (pests, diseases). Only names that exist on the site
# are added. Kaitet-derived: Dagonis, Meltatox, Nimrod, Thiovit, Metaprop, Orvego, Revus, Scala,
# Switch (mildews and Botrytis, mildews mapped to the onion ones), Levo, Nemguard, Sivanto,
# Emmaron, Gladius, Thuricide, Mospilan, Amisil. The rest is agronomic.
# --------------------------------------------------------------------------
TARGETS = {
	# fungicides
	"1111101043": ([], ["Anthracnose", "Cercospora Spot", "Avocado Scab", "Alternaria Leaf Spot",
	                    "Purple Blotch", "Onion Powdery Mildew"]),  # Dagonis 125SC
	"1110003": ([], ["Avocado Scab", "Cercospora Spot", "Onion Powdery Mildew"]),  # Meltatox EC
	"1111112055": ([], ["Late Blight", "Early Blight", "Onion Downy Mildew", "Cabbage Downy Mildew",
	                    "Alternaria Leaf Spot"]),  # Metaprop
	"1110005": ([], ["Onion Powdery Mildew"]),  # Nimrod 25EC
	"1111112053": ([], ["Late Blight", "Onion Downy Mildew", "Cabbage Downy Mildew"]),  # Orvego
	"1111111027": ([], ["Late Blight", "Onion Downy Mildew", "Cabbage Downy Mildew"]),  # Revus 250sc
	"1114003": ([], ["Botrytis", "Avocado Scab", "Leaf Spot"]),  # Scala 40SC
	"1114001": ([], ["Botrytis", "Anthracnose", "Stemphylium Leaf Blight", "Purple Blotch",
	                 "Leaf Spot"]),  # Switch 62.5 WG
	"1110013": ([], ["Onion Powdery Mildew", "Avocado Scab"]),  # Thiovit Jet
	# insecticides and miticides
	"1111122044": (["Aphids", "Thrips", "Spidermites"], []),  # Levo 2.4SL
	"1111133061": (["Thrips", "Caterpillars"], []),  # Nemguard
	"1111133073": (["Thrips", "Mealybugs", "Aphids", "Whiteflies", "Scale Insects"], []),  # Sivanto Prime
	"1111133076": (["Spodoptera", "FCM", "Thrips", "Caterpillars", "Fall Armyworm",
	                "Diamondback Moth"], []),  # Emmaron 300SC
	"1111133085": (["Thrips", "Spidermites", "Broad Mites", "Persea Mite", "Leafminers"], []),  # Gladius
	"1111133087": (["FCM", "Caterpillars", "Diamondback Moth", "Potato Tuber Moth", "Cabbage Looper",
	                "Fall Armyworm", "Loopers"], []),  # Thuricide
	"1113018": (["Aphids", "Thrips", "Whiteflies", "Scale Insects", "Mealybugs"], []),  # Mospilan
	"4010030041": (["Aphids", "Whiteflies", "Thrips", "Spidermites", "Broad Mites",
	                "Persea Mite"], []),  # Biopest (neem oil)
	"4010030040": (["Spidermites", "Broad Mites", "Persea Mite", "Scale Insects"], []),  # Prevail P
	# adjuvant (Kaitet registers the mite target)
	"1111156005": (["Spidermites"], []),  # Amisil
}

# Tank mixes: name -> [(item, rate per 1000 L)]. All in stock in the farm stores.
MIXES = {
	"Mutara Anthracnose Cover": [("1111101043", 0.75), ("1111156005", 0.5)],
	"Mutara Botrytis and Leaf Spot": [("1114001", 1.0), ("1111156005", 0.5)],
	"Mutara Blight Protectant": [("1111111027", 0.6), ("1111112055", 2.0)],
	"Mutara Mite and Thrips Knockdown": [("1111133085", 0.75), ("1111156005", 0.5)],
	"Mutara Aphid and Scale Control": [("1111133073", 1.0), ("1111156005", 0.5)],
	"Mutara Caterpillar Bio": [("1111133087", 0.5), ("1111156005", 0.5)],
	"Mutara Organic Oil Mite Mix": [("4010030040", 2.0), ("4010030041", 2.0)],
	"Mutara Foliar Zinc and Amino": [("1010100125", 1.5), ("1010100158", 1.0)],
}

# Scouting: crop -> (pests, diseases) seen in the field. Filtered to the crop's own catalog.
SCOUTED = {
	"Avocado": (["Persea Mite", "Scale Insects", "FCM", "Mealybugs", "Caterpillars"],
	            ["Anthracnose", "Cercospora Spot", "Avocado Scab", "Leaf Spot"]),
	"Potato": (["Aphids", "Thrips", "Potato Tuber Moth", "Cutworms", "Spidermites"],
	           ["Late Blight", "Early Blight"]),
	"Onion": (["Thrips", "Onion Fly", "Leafminers", "Spodoptera"],
	          ["Purple Blotch", "Onion Downy Mildew", "Stemphylium Leaf Blight"]),
	"Cabbage": (["Diamondback Moth", "Cabbage Looper", "Aphids", "Cabbage Webworm"],
	            ["Cabbage Downy Mildew", "Alternaria Leaf Spot", "Black Rot"]),
}
SCOUT_BLOCKS = [
	"Avocado Block A - MUT", "Avocado Block B - MUT",
	"P1-B1 - MUT", "P1-B2 - MUT", "P1-B3 - MUT", "P1-B4 - MUT",
	"P2-B1 - MUT", "P2-B2 - MUT", "P2-B3 - MUT", "P2-B4 - MUT",
]
SCOUT_ROUND_DAYS = [-24, -17, -10, -4, -1]
PEST_STAGES = ["Adult", "Nymph", "Larva"]


class _Log:
	def __init__(self, dry_run):
		self.dry_run = dry_run
		self.created = {}

	def made(self, kind, name):
		self.created[kind] = self.created.get(kind, 0) + 1
		print(("would create " if self.dry_run else "created ") + f"{kind}: {name}")


def run(dry_run=False):
	log = _Log(dry_run)
	if not frappe.db.exists("Farm", FARM):
		print(f"Farm {FARM} missing; nothing to seed")
		return {}
	_roster(log)
	_demo_scout(log)
	_wip_and_kits(log)
	_teams(log)
	_targets(log)
	_mix_items_and_boms(log)
	_avocado_areas(log)
	_scouting(log)
	if not dry_run:
		frappe.db.commit()
	print("summary:", log.created or "nothing to create")
	return log.created


# --------------------------------------------------------------------------


def _roster(log):
	"""Roles first: Farm validation refuses a roster user without the creator role."""
	have = set(frappe.get_all("Farm Spray Plan Creator", filters={"parent": FARM, "parenttype": "Farm"},
	                          pluck="user"))
	farm = None
	for user in ROSTER_USERS:
		if not frappe.db.exists("User", user):
			print(f"user {user} does not exist yet; skipped")
			continue
		roles = set(frappe.get_all("Has Role", filters={"parent": user, "parenttype": "User"}, pluck="role"))
		for role in ROSTER_ROLES:
			if role not in roles and frappe.db.exists("Role", role):
				log.made("User role", f"{user}: {role}")
				if not log.dry_run:
					frappe.get_doc("User", user).add_roles(role)
		if user not in have:
			log.made("Spray Plan Creator roster row", user)
			if not log.dry_run:
				farm = farm or frappe.get_doc("Farm", FARM)
				farm.append("spray_plan_creators", {"user": user})
	if farm:
		farm.save(ignore_permissions=True)


def _demo_scout(log):
	"""Stephene: SCP Scout role, Employee in the company (crop scoping and the entry's scout lookup)."""
	import os

	d = DEMO_SCOUT
	email = d["email"]
	if not frappe.db.exists("Designation", d["designation"]):
		log.made("Designation", d["designation"])
		if not log.dry_run:
			frappe.get_doc({"doctype": "Designation", "designation_name": d["designation"]}).insert(ignore_permissions=True)
	if not frappe.db.exists("User", email):
		log.made("User", email)
		if not log.dry_run:
			user = frappe.get_doc({
				"doctype": "User", "email": email, "first_name": d["first_name"], "enabled": 1,
				"send_welcome_email": 0, "user_type": "System User",
			})
			user.insert(ignore_permissions=True)
			frappe.utils.password.update_password(
				email, os.environ.get(d["password_env"]) or frappe.generate_hash(length=24))
	if not log.dry_run and frappe.db.exists("User", email):
		roles = set(frappe.get_all("Has Role", filters={"parent": email, "parenttype": "User"}, pluck="role"))
		for role in d["roles"]:
			if role not in roles and frappe.db.exists("Role", role):
				log.made("User role", f"{email}: {role}")
				frappe.get_doc("User", email).add_roles(role)
		if os.environ.get(d["password_env"]):
			frappe.utils.password.update_password(email, os.environ[d["password_env"]])
	if not frappe.db.exists("Employee", {"user_id": email}):
		log.made("Employee", d["first_name"])
		if not log.dry_run:
			frappe.get_doc({
				"doctype": "Employee", "first_name": d["first_name"], "company": COMPANY, "gender": "Male",
				"date_of_birth": "1992-05-20", "date_of_joining": "2025-01-13", "status": "Active",
				"designation": d["designation"], "user_id": email,
			}).insert(ignore_permissions=True)


def _wip_and_kits(log):
	if frappe.db.exists("Warehouse", WIP_WAREHOUSE):
		if not frappe.db.get_value("Warehouse", WIP_WAREHOUSE, "custom_farm"):
			log.made("WIP warehouse farm", f"{WIP_WAREHOUSE} -> {FARM}")
			if not log.dry_run:
				frappe.db.set_value("Warehouse", WIP_WAREHOUSE, "custom_farm", FARM)
	else:
		print(f"warehouse {WIP_WAREHOUSE} missing; no kits seeded")
		return
	have = set(frappe.get_all("Spray Equipment Details", filters={"parent": "Spray Equipment"}, pluck="kit"))
	doc = None
	for kit in KITS:
		if kit not in have:
			log.made("Spray kit", kit)
			if not log.dry_run:
				doc = doc or frappe.get_doc("Spray Equipment")
				doc.append("equipment", {"kit": kit, "warehouse": WIP_WAREHOUSE})
	if doc:
		doc.save(ignore_permissions=True)


def _team_employees():
	"""Employees of the farm that are not on a spray team yet, in a stable order."""
	taken = set(frappe.get_all("Spray Team Details", pluck="name1"))
	rows = frappe.get_all(
		"Employee", filters={"company": COMPANY, "status": "Active", "designation": ["is", "not set"]},
		fields=["name"], order_by="name asc", limit_page_length=0,
	)
	return [r.name for r in rows if r.name not in taken]


def _teams(log):
	free = _team_employees()
	for i, team in enumerate(TEAMS):
		if frappe.db.exists("Spray Team", team):
			continue
		members = free[i * len(MEMBER_ROLES):(i + 1) * len(MEMBER_ROLES)]
		log.made("Spray Team", f"{team} ({len(members)} members)")
		if log.dry_run:
			continue
		frappe.get_doc({
			"doctype": "Spray Team", "team_name": team, "custom_farm": FARM, "enabled": 1,
			"team": [{"name1": e, "role": MEMBER_ROLES[j]} for j, e in enumerate(members)],
		}).insert(ignore_permissions=True)


def _targets(log):
	for item, (pests, diseases) in TARGETS.items():
		sp = frappe.db.get_value("Spray Product", {"item": item}, "name")
		if not sp:
			continue
		if frappe.db.exists("Chemical Targets", {"parent": sp, "parenttype": "Spray Product"}):
			continue  # registered already (by hand or by an earlier run)
		rows = [{"pest": p} for p in pests if frappe.db.exists("Pest", p)]
		rows += [{"disease": d} for d in diseases if frappe.db.exists("Plant Disease", d)]
		if not rows:
			continue
		log.made("Spray Product targets", f"{item}: {len(rows)}")
		if log.dry_run:
			continue
		doc = frappe.get_doc("Spray Product", sp)
		for r in rows:
			doc.append("default_targets", r)
		doc.save(ignore_permissions=True)


def _mix_items_and_boms(log):
	from upande_scp.serverscripts.spray_plan_creator.bom_resolver import bom_item_payload

	if not frappe.db.exists("Item Group", TANK_MIX_GROUP) or not frappe.db.exists("UOM", TANK_MIX_UOM):
		print("Chemical Mix item group or tank-mix UOM missing; no tank mixes seeded")
		return
	for name, parts in MIXES.items():
		if not all(frappe.db.exists("Item", c) for c, _ in parts):
			print(f"mix {name}: an ingredient is missing; skipped")
			continue
		if not frappe.db.exists("Item", name):
			log.made("Tank mix item", name)
			if not log.dry_run:
				frappe.get_doc({
					"doctype": "Item", "item_code": name, "item_name": name, "item_group": TANK_MIX_GROUP,
					"stock_uom": TANK_MIX_UOM, "is_stock_item": 1, "include_item_in_manufacturing": 1,
					"is_purchase_item": 0, "is_sales_item": 0,
				}).insert(ignore_permissions=True)
		if frappe.db.exists("BOM", {"item": name, "docstatus": 1, "custom_item_group": TANK_MIX_GROUP}):
			continue
		log.made("Tank mix BOM", name)
		if log.dry_run:
			continue
		bom = frappe.new_doc("BOM")
		bom.item = name
		bom.company = COMPANY
		bom.custom_item_group = TANK_MIX_GROUP
		bom.custom_farm = FARM
		bom.uom = TANK_MIX_UOM
		bom.quantity = 1
		bom.is_active = 1
		bom.is_default = 1
		for code, rate in parts:
			bom.append("items", bom_item_payload(
				code, rate, rate, frappe.db.get_value("Item", code, "stock_uom")))
		bom.flags.ignore_permissions = True
		bom.insert()
		bom.submit()


def _avocado_areas(log):
	for block, area in AVOCADO_AREAS.items():
		if frappe.db.exists("Warehouse", block) and not frappe.db.get_value("Warehouse", block,
		                                                                    "custom_area_ha"):
			log.made("Block area", f"{block}: {area} ha")
			if not log.dry_run:
				frappe.db.set_value("Warehouse", block, "custom_area_ha", area)


# --------------------------------------------------------------------------


def _scouts():
	taken = set(frappe.get_all("Spray Team Details", pluck="name1"))
	rows = frappe.get_all(
		"Employee", filters={"company": COMPANY, "status": "Active", "designation": ["is", "not set"]},
		fields=["name"], order_by="name desc", limit_page_length=0,
	)
	return [r.name for r in rows if r.name not in taken][:3]


def _scouting(log):
	from upande_scp.serverscripts.common import crop_catalog, planting

	blocks = [b for b in SCOUT_BLOCKS if frappe.db.exists("Warehouse", b)]
	crops = planting.crops_for_stations(blocks)
	scouts = _scouts()
	if not scouts:
		print("no employees to act as scouts; no scouting seeded")
		return
	today = nowdate()
	for n, block in enumerate(blocks):
		crop = crops.get(block)
		if not crop or crop not in SCOUTED:
			continue
		seeded = frappe.db.sql(
			"""select 1 from `tabScouting Entry` se join `tabComments Scouting Entry` c on c.parent = se.name
			   where se.block = %s and c.comment = %s limit 1""", (block, SEED_NOTE))
		if seeded:
			continue
		allowed = set(crop_catalog.targets_for_crop(crop))
		pests = [p for p in SCOUTED[crop][0] if p in allowed and frappe.db.exists("Pest", p)]
		diseases = [d for d in SCOUTED[crop][1] if d in allowed and frappe.db.exists("Plant Disease", d)]
		if not pests and not diseases:
			continue
		rng = random.Random(f"scout-{block}")
		# One pest and one disease that build up over the rounds, plus a passing finding or two.
		main_pest = pests[n % len(pests)] if pests else None
		main_dis = diseases[n % len(diseases)] if diseases else None
		for r, offset in enumerate(SCOUT_ROUND_DAYS):
			pest_rows, dis_rows = [], []
			if main_pest:
				pest_rows.append({"pest": main_pest, "stage": rng.choice(PEST_STAGES),
				                  "count": 2 + r * 2 + rng.randint(0, 3)})
			if len(pests) > 1 and r % 2 == 1:
				pest_rows.append({"pest": rng.choice([p for p in pests if p != main_pest]),
				                  "stage": rng.choice(PEST_STAGES), "count": rng.randint(1, 4)})
			if main_dis and r >= 1:
				dis_rows.append({"disease": main_dis, "stage": "Fresh"})
			if len(diseases) > 1 and r == len(SCOUT_ROUND_DAYS) - 1:
				dis_rows.append({"disease": rng.choice([d for d in diseases if d != main_dis]),
				                 "stage": "Fresh"})
			if not pest_rows and not dis_rows:
				continue
			day = add_days(today, offset)
			log.made("Scouting Entry", f"{block} {day}")
			if log.dry_run:
				continue
			frappe.get_doc({
				"doctype": "Scouting Entry", "naming_series": "SCE-.YYYY.-",
				"scouts_name": scouts[(n + r) % len(scouts)], "crop_scouted": crop, "block": block,
				"date_of_capture": day, "time_of_capture": f"{7 + (n + r) % 4:02d}:{rng.randint(0, 5) * 10:02d}:00",
				"latitude": f"{-0.0412 - n * 0.0011:.6f}", "longitude": f"{36.8995 + n * 0.0013:.6f}",
				"pests_scouting_entry": pest_rows, "diseases_scouting_entry": dis_rows,
				"comments_scouting_entry": [{"comment": SEED_NOTE}],
			}).insert(ignore_permissions=True)
