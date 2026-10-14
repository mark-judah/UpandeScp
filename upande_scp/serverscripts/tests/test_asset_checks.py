"""Asset check sheets for scouts (asset_checks.api).

Real documents (Asset Category, Item, Assets, Template, settings rows, a scout
User) built inside one transaction and rolled back at the end — no real Asset is
read for its data or touched. Needs upande_asset installed; skipped without it.

    bench --site kaitet.local run-tests --module \\
        upande_scp.serverscripts.tests.test_asset_checks
"""

import unittest
import uuid
from unittest.mock import patch

import frappe
from frappe.utils import add_days, nowdate

from upande_scp.serverscripts.asset_checks import api

FARM, OTHER_FARM = "ZZ AC Farm", "ZZ AC Other Farm"
TEMPLATE = "ZZ AC Template"
SCOUT = "zz.ac.scout@example.com"
SCOUT_ROLE = "SCP Scout"  # swapped for "Scout" below on sites that never namespaced it


def _farm(name):
	if frappe.db.exists("Farm", name) if frappe.db.exists("DocType", "Farm") else frappe.db.sql("select 1 from `tabFarm` where name=%s", name):
		return
	if frappe.db.exists("DocType", "Farm"):
		frappe.get_doc({"doctype": "Farm", "farm_name": name, "name": name, "abbreviation": name[-4:].strip()[:4] or "ZZ",
			 "farm_type": [{"farm_type": "Has Greenhouses"}]}).insert(ignore_permissions=True)
	else:  # the table without its DocType (mona.local)
		frappe.db.sql("insert into `tabFarm` (name, farm_name, creation, modified, owner, modified_by) "
		              "values (%s, %s, now(), now(), 'Administrator', 'Administrator')", (name, name))


HAS_FARM_COL = frappe.db.has_column("Asset", "farm") if api.installed() else False


@unittest.skipUnless(api.installed(), "upande_asset not installed")
class TestAssetChecks(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		try:
			cls._build()
		except Exception:
			frappe.db.rollback()  # tearDownClass never runs when setUpClass raises
			raise

	@classmethod
	def _build(cls):
		frappe.set_user("Administrator")
		for f in (FARM, OTHER_FARM):
			_farm(f)
		src = frappe.get_all(
			"Asset Category Account",
			fields=["company_name", "fixed_asset_account", "accumulated_depreciation_account", "depreciation_expense_account"],
			filters={"fixed_asset_account": ["is", "set"], "accumulated_depreciation_account": ["is", "set"],
			         "depreciation_expense_account": ["is", "set"]},
			limit=1,
		)[0]
		cls.company = src.company_name
		if frappe.db.has_column("Farm", "company"):
			frappe.db.sql("update `tabFarm` set company=%s where name=%s", (cls.company, FARM))
		cls.cat = frappe.get_doc(
			{"doctype": "Asset Category", "asset_category_name": "ZZ AC Cat", "accounts": [dict(src)]}
		).insert().name
		cls.item = frappe.get_doc(
			{"doctype": "Item", "item_code": "ZZ-AC-ASSET", "item_name": "ZZ AC", "item_group": "Fixed Assets" if frappe.db.exists("Item Group", "Fixed Assets") else frappe.db.get_value("Item Group", {"is_group": 0}, "name"),
			 "is_stock_item": 0, "is_fixed_asset": 1, "asset_category": cls.cat, "stock_uom": "Nos"}
		).insert().name
		cls.location = frappe.get_all("Location", pluck="name", limit=1)[0]
		team = frappe.get_all("Asset Maintenance Team", pluck="name", limit=1)
		if team:
			team = team[0]
		else:  # none on this site: a throwaway one (rolled back with the rest)
			team = frappe.get_doc(
				{"doctype": "Asset Maintenance Team", "maintenance_team_name": "ZZ AC Team", "company": cls.company,
				 "maintenance_manager": "Administrator",
				 "maintenance_team_members": [{"team_member": "Administrator", "maintenance_role": "System Manager"}]}
			).insert().name

		def items(*factors):
			return [{"check_factor": f, "threshold_percent": 10} for f in factors]

		cls.template = frappe.get_doc(
			{
				"doctype": "Asset Check Sheet Template", "template_name": TEMPLATE, "asset_category": cls.cat,
				"asset_maintenance_team": team, "number_of_sections": 2, "frequency": "Weekly",
				"require_incident_percent": 1, "require_proposed_action": 1,
				"section_a_name": "Engine", "section_a_items": items("Oil level", "Belts"),
				"section_b_name": "Body", "section_b_items": items("Paint"),
			}
		).insert()
		cls.template_name = cls.template.name

		if not frappe.db.exists("User", SCOUT):
			frappe.get_doc(
				{"doctype": "User", "email": SCOUT, "first_name": "ZZ AC Scout", "send_welcome_email": 0,
				 "roles": [{"role": SCOUT_ROLE if frappe.db.exists("Role", SCOUT_ROLE) else "Scout"}]}
			).insert(ignore_permissions=True)

	@classmethod
	def tearDownClass(cls):
		frappe.set_user("Administrator")
		frappe.db.rollback()
		frappe.clear_cache(doctype=api.SETTINGS)

	def setUp(self):
		frappe.set_user("Administrator")
		api.save_asset_check_settings(
			{"enabled": 1, "rows": [{"farm": FARM, "asset_category": self.cat, "enabled": 1}]}
		)

	def tearDown(self):
		frappe.set_user("Administrator")

	# helpers
	def asset(self, farm=FARM, name=None):
		a = frappe.get_doc(
			{"doctype": "Asset", "item_code": self.item, "asset_category": self.cat, "company": self.company,
			 "asset_name": name or f"ZZ AC {uuid.uuid4().hex[:6]}", "gross_purchase_amount": 100,
			 "net_purchase_amount": 100, "purchase_date": "2026-01-01", "available_for_use_date": "2026-01-01",
			 "location": self.location, "is_existing_asset": 1, "cost_center": frappe.db.get_value("Company", self.company, "cost_center"), **({"farm": farm} if HAS_FARM_COL else {})}
		).insert()
		a.submit()
		return a.name

	def config_row(self, asset):
		"""The asset's entry flattened with its ``self.template_name`` template entry."""
		cfg = api.get_asset_check_config()
		entry = next((x for x in cfg["assets"] if x["asset"] == asset), None)
		if entry is None:
			return None
		t = next(t for t in entry["templates"] if t["template"] == self.template_name)
		return {**{k: v for k, v in entry.items() if k != "templates"}, **t}

	def answers(self, status="OK", **extra):
		def row(idx):
			return dict({"idx": idx, "status": status}, **extra)

		return {"a": [row(1), row(2)], "b": [row(1)]}

	FACTORS = {("a", 1): "Oil level", ("a", 2): "Belts", ("b", 1): "Paint"}

	def payload(self, asset, **kw):
		"""A phone payload: every answer row carries the check_factor it answered, and
		the template fingerprint, exactly as the app sends them."""
		p = dict({"client_id": uuid.uuid4().hex, "asset": asset, "template": self.template_name,
		          "template_fingerprint": api._fingerprint(frappe.get_doc(api.TEMPLATE, self.template_name)),
		          "sections": self.answers()}, **kw)
		p["sections"] = {
			k: [dict({"check_factor": self.FACTORS.get((k, r.get("idx")))}, **r) for r in rows]
			for k, rows in p["sections"].items()
		}
		return p

	def as_scout(self, farms=(FARM,)):
		frappe.set_user(SCOUT)
		return patch.object(api, "_scope_farms", return_value=set(farms))

	# config
	def test_feature_off_returns_disabled(self):
		self.asset()
		api.save_asset_check_settings({"enabled": 0, "rows": []})
		cfg = api.get_asset_check_config()
		self.assertEqual((cfg["enabled"], cfg["assets"]), (False, []))

	def test_feature_off_when_app_absent(self):
		with patch.object(api, "installed", return_value=False):
			cfg = api.get_asset_check_config()
		self.assertEqual((cfg["enabled"], cfg["assets"]), (False, []))

	def test_config_shape(self):
		a = self.asset()
		cfg = api.get_asset_check_config()
		self.assertTrue(cfg["enabled"])
		self.assertEqual(cfg["today"], nowdate())
		s = self.config_row(a)
		self.assertEqual((s["template"], s["farm"], s["frequency"], s["due"]), (self.template_name, FARM, "Weekly", True))
		entry = next(x for x in cfg["assets"] if x["asset"] == a)
		self.assertTrue(entry["any_due"])
		self.assertEqual(set(entry), {"asset", "asset_name", "asset_category", "company", "farm", "any_due", "templates"})
		self.assertNotIn("sheets", cfg)
		self.assertTrue(s["require_incident_percent"] and s["require_proposed_action"])
		self.assertEqual([x["key"] for x in s["sections"]], ["a", "b"])
		self.assertEqual(s["sections"][0]["label"], "Engine")
		self.assertEqual([i["check_factor"] for i in s["sections"][0]["items"]], ["Oil level", "Belts"])
		self.assertEqual(s["sections"][0]["items"][0]["idx"], 1)
		self.assertEqual(s["sections"][0]["items"][0]["threshold_percent"], 10)

	@unittest.skipUnless(HAS_FARM_COL, "Asset has no farm column here; see the company fallback test")
	def test_scoping_by_farm_and_scout_scope(self):
		mine, theirs = self.asset(FARM), self.asset(OTHER_FARM)
		api.save_asset_check_settings({"enabled": 1, "rows": [
			{"farm": FARM, "asset_category": self.cat, "enabled": 1},
			{"farm": OTHER_FARM, "asset_category": self.cat, "enabled": 1}]})
		# a manager sees every enabled farm
		self.assertTrue(self.config_row(mine) and self.config_row(theirs))
		# a scout only the farms in their scope
		with self.as_scout((FARM,)):
			self.assertTrue(self.config_row(mine))
			self.assertIsNone(self.config_row(theirs))
		with self.as_scout(()):
			self.assertEqual(api.get_asset_check_config()["assets"], [])

	def test_disabled_row_and_other_category_excluded(self):
		a = self.asset()
		api.save_asset_check_settings({"enabled": 1, "rows": [
			{"farm": FARM, "asset_category": self.cat, "enabled": 0}]})
		self.assertIsNone(self.config_row(a))

	def test_unrelated_user_refused(self):
		frappe.set_user("Guest")
		self.assertRaises(frappe.PermissionError, api.get_asset_check_config)

	# the scout picks the template: every template of the category comes back
	def test_all_templates_of_category_default_first_and_empty_skipped(self):
		a = self.asset()
		team = self.template.asset_maintenance_team

		def tmpl(name, default, items=True):
			return frappe.get_doc(
				{"doctype": "Asset Check Sheet Template", "template_name": name, "asset_category": self.cat,
				 "asset_maintenance_team": team, "number_of_sections": 1, "frequency": "Daily",
				 "is_default": default, "section_a_name": "Only",
				 "section_a_items": [{"check_factor": "Thing", "threshold_percent": 5}] if items else []}
			).insert().name

		d = tmpl("ZZ AC Default", 1)
		tmpl("ZZ AC Empty", 0, items=False)
		entry = next(x for x in api.get_asset_check_config()["assets"] if x["asset"] == a)
		names = [t["template"] for t in entry["templates"]]
		self.assertEqual(names[0], d)  # default first
		self.assertIn(self.template_name, names)
		self.assertEqual(len(names), 2)  # the item-less one is skipped
		self.assertTrue(entry["templates"][0]["is_default"])
		# due is per template: checking one leaves the other due
		with self.as_scout():
			api.submit_asset_check_sheet(self.payload(a))
		frappe.set_user("Administrator")
		entry = next(x for x in api.get_asset_check_config()["assets"] if x["asset"] == a)
		due = {t["template"]: t["due"] for t in entry["templates"]}
		self.assertEqual((due[self.template_name], due[d]), (False, True))
		self.assertTrue(entry["any_due"])

	def test_template_of_other_category_refused(self):
		a = self.asset()
		other = frappe.get_all("Asset Check Sheet Template", filters={"asset_category": ["!=", self.cat]}, pluck="name", limit=1)
		if not other:
			self.skipTest("no template of another category on this site")
		with self.as_scout():
			self.assertRaises(frappe.ValidationError, api.submit_asset_check_sheet, self.payload(a, template=other[0]))

	def test_category_not_enabled_for_farm_refused(self):
		a = self.asset()
		api.save_asset_check_settings({"enabled": 1, "rows": []})
		with self.as_scout():
			self.assertRaises(frappe.ValidationError, api.submit_asset_check_sheet, self.payload(a))

	def test_category_without_templates_omitted(self):
		a = self.asset()
		with patch.object(api, "_templates_of", return_value=[]):
			self.assertEqual(api.get_asset_check_config()["assets"], [])
		self.assertTrue(self.config_row(a))

	# due logic
	def test_due_from_last_sheet_and_frequency(self):
		a = self.asset()
		self.assertTrue(self.config_row(a)["due"])
		with self.as_scout():
			r = api.submit_asset_check_sheet(self.payload(a, check_date=add_days(nowdate(), -3)))
		self.assertEqual(r["docstatus"], 1)
		frappe.set_user("Administrator")
		s = self.config_row(a)
		self.assertFalse(s["due"])  # weekly: next due in 4 days
		self.assertEqual(s["next_due_date"], add_days(nowdate(), 4))
		self.assertEqual(s["last_check_date"], add_days(nowdate(), -3))
		# an old sheet makes it due again
		b = self.asset()
		with patch.object(api, "BACKDATE_DAYS", 30):  # the clamp is tested on its own
			api.submit_asset_check_sheet(self.payload(b, check_date=add_days(nowdate(), -8)))
		self.assertTrue(self.config_row(b)["due"])

	def test_due_from_schedule(self):
		a = self.asset()
		sch = frappe.get_doc({"doctype": "Asset Check Sheet Schedule", "asset": a,
		                      "check_sheet_template": self.template_name, "enabled": 1}).insert()
		self.assertTrue(self.config_row(a)["due"])  # never checked => due today
		frappe.db.set_value(sch.doctype, sch.name, "next_due_date", add_days(nowdate(), 5))
		self.assertFalse(self.config_row(a)["due"])
		frappe.db.set_value(sch.doctype, sch.name, "next_due_date", add_days(nowdate(), -1))
		self.assertTrue(self.config_row(a)["due"])
		frappe.db.set_value(sch.doctype, sch.name, "next_due_date", None)
		self.assertTrue(self.config_row(a)["due"])
		frappe.db.set_value(sch.doctype, sch.name, "enabled", 0)  # disabled schedule: fall back
		frappe.db.set_value(sch.doctype, sch.name, "next_due_date", add_days(nowdate(), 5))
		self.assertTrue(self.config_row(a)["due"])

	# submit
	def test_submit_happy_path(self):
		a = self.asset()
		ans = self.answers()
		ans["a"][1] = {"idx": 2, "status": "Fault / Defect", "severity": "High",
		               "fault_description": "Frayed", "incident_percent": 30, "proposed_action": "Replace"}
		with self.as_scout():
			r = api.submit_asset_check_sheet(self.payload(a, sections=ans, additional_notes="n"))
		self.assertEqual((r["docstatus"], r["overall_status"], r["duplicate"]), (1, "Needs Attention", False))
		doc = frappe.get_doc("Asset Check Sheet", r["name"])
		self.assertEqual(doc.owner, SCOUT)
		self.assertEqual(doc.section_a_label, "Engine")
		self.assertEqual([i.check_factor for i in doc.section_a_items], ["Oil level", "Belts"])
		self.assertEqual(doc.section_a_items[0].status, "OK")
		belts = doc.section_a_items[1]
		self.assertEqual((belts.status, belts.severity, belts.incident_percent, belts.percent_above_threshold),
		                 ("Fault / Defect", "High", 30, 20))
		self.assertEqual(doc.section_b_items[0].status, "OK")
		self.assertEqual(doc.company, self.company)

	def test_all_ok_passes(self):
		a = self.asset()
		with self.as_scout():
			r = api.submit_asset_check_sheet(self.payload(a))
		self.assertEqual(r["overall_status"], "Passed")

	def test_idempotent_repeat(self):
		a = self.asset()
		p = self.payload(a)
		with self.as_scout():
			first = api.submit_asset_check_sheet(p)
			again = api.submit_asset_check_sheet(p)
		self.assertFalse(first["duplicate"])
		self.assertTrue(again["duplicate"])
		self.assertEqual(again["name"], first["name"])
		self.assertEqual(frappe.db.count("Asset Check Sheet", {"asset": a}), 1)

	def test_not_due_refused(self):
		a = self.asset()
		with self.as_scout():
			api.submit_asset_check_sheet(self.payload(a))
			with self.assertRaises(frappe.ValidationError):
				api.submit_asset_check_sheet(self.payload(a))  # new client_id, same day

	@unittest.skipUnless(HAS_FARM_COL, "Asset has no farm column here; see the company fallback test")
	def test_out_of_scope_and_disabled_refused(self):
		a = self.asset(OTHER_FARM)
		with self.as_scout((FARM,)):
			self.assertRaises(frappe.PermissionError, api.submit_asset_check_sheet, self.payload(a))
		frappe.set_user("Administrator")
		api.save_asset_check_settings({"enabled": 0, "rows": []})
		b = self.asset()
		self.assertRaises(frappe.ValidationError, api.submit_asset_check_sheet, self.payload(b))

	def test_validation_errors(self):
		a = self.asset()
		fault = {"status": "Fault / Defect", "severity": "Low", "fault_description": "x",
		         "incident_percent": 5, "proposed_action": "fix"}

		def one(**over):
			ans = self.answers()
			ans["a"][0] = dict({"idx": 1}, **dict(fault, **over))
			return ans

		cases = {
			"missing row": {"a": [{"idx": 1, "status": "OK"}], "b": [{"idx": 1, "status": "OK"}]},
			"no status": one(status=""),
			"bad status": one(status="Broken"),
			"no severity": one(severity=None),
			"no description": one(fault_description=" "),
			"no incident": one(incident_percent=None),
			"no action": one(proposed_action=None),
		}
		with self.as_scout():
			for label, sections in cases.items():
				with self.subTest(label), self.assertRaises(frappe.ValidationError):
					api.submit_asset_check_sheet(self.payload(a, sections=sections))
		self.assertEqual(frappe.db.count("Asset Check Sheet", {"asset": a}), 0)

	def test_affected_needs_description_but_needs_monitoring_does_not(self):
		a = self.asset()
		ans = self.answers()
		ans["a"][0] = {"idx": 1, "status": "Needs Monitoring"}
		ans["a"][1] = {"idx": 2, "status": "Not Applicable"}
		with self.as_scout():
			r = api.submit_asset_check_sheet(self.payload(a, sections=ans))
		self.assertEqual(r["overall_status"], "Passed")

	# farm resolution when Asset has no farm column (mona): by the farm's company
	def test_company_fallback_when_asset_has_no_farm_column(self):
		a = self.asset(OTHER_FARM)  # its farm column is ignored below
		frappe.db.sql("update `tabFarm` set company=%s where name=%s", (self.company, FARM))
		frappe.db.sql("update `tabFarm` set company=NULL where name=%s", OTHER_FARM)
		with patch.object(api, "_asset_has_farm", return_value=False):
			row = self.config_row(a)
			self.assertEqual(row["farm"], FARM)  # every farm of the asset's company
			with self.as_scout((FARM,)):
				r = api.submit_asset_check_sheet(self.payload(a))
			self.assertEqual(r["docstatus"], 1)
			frappe.set_user("Administrator")
			b = self.asset()
			with self.as_scout(()):
				self.assertRaises(frappe.PermissionError, api.submit_asset_check_sheet, self.payload(b))

	# settings
	def test_settings_validate_template_and_gm_only(self):
		with self.assertRaises(frappe.ValidationError):
			api.save_asset_check_settings({"enabled": 1, "rows": [{"farm": FARM, "asset_category": "nope"}]})
		out = api.get_asset_check_settings()
		self.assertTrue(out["installed"])
		self.assertIn(self.cat, out["categories"])
		self.assertEqual(out["rows"], [{"farm": FARM, "asset_category": self.cat, "enabled": 1}])
		with self.as_scout():
			self.assertRaises(frappe.PermissionError, api.get_asset_check_settings)

	# ── review fixes ─────────────────────────────────────────────────────

	def _scratch_template(self, name):
		return frappe.get_doc(
			{"doctype": "Asset Check Sheet Template", "template_name": name, "asset_category": self.cat,
			 "asset_maintenance_team": self.template.asset_maintenance_team, "number_of_sections": 1,
			 "frequency": "Daily", "section_a_name": "Only",
			 "section_a_items": [{"check_factor": "One", "threshold_percent": 5},
			                     {"check_factor": "Two", "threshold_percent": 5}]}
		).insert()

	def test_config_carries_fingerprint_that_follows_template_edits(self):
		a = self.asset()
		cfg_fp = self.config_row(a)["fingerprint"]
		self.assertEqual(cfg_fp, api._fingerprint(frappe.get_doc(api.TEMPLATE, self.template_name)))
		t = self._scratch_template("ZZ AC Edit " + uuid.uuid4().hex[:4])
		before = api._fingerprint(t)
		t.section_a_items[0].threshold_percent = 9
		self.assertNotEqual(api._fingerprint(t), before)  # threshold
		t.reload()
		t.section_a_items = list(reversed(t.section_a_items))
		for i, r in enumerate(t.section_a_items, 1):
			r.idx = i
		self.assertNotEqual(api._fingerprint(t), before)  # order
		t.reload()
		t.require_proposed_action = 1
		self.assertNotEqual(api._fingerprint(t), before)  # flags
		t.reload()
		self.assertEqual(api._fingerprint(t), before)

	def test_template_changed_refused_on_fingerprint_mismatch(self):
		a = self.asset()
		with self.as_scout():
			with self.assertRaises(api.TemplateChanged) as cm:
				api.submit_asset_check_sheet(self.payload(a, template_fingerprint="0" * 16))
		self.assertIn("TEMPLATE_CHANGED", str(cm.exception))
		self.assertTrue(issubclass(api.TemplateChanged, frappe.ValidationError))
		self.assertEqual(frappe.db.count("Asset Check Sheet", {"asset": a}), 0)

	def test_template_changed_refused_when_a_row_answers_another_check(self):
		"""An item inserted above shifts every idx: the same (section, idx) now means a
		different check, which only the carried check_factor reveals."""
		a = self.asset()
		sections = self.answers()
		sections["a"] = [{"idx": 1, "status": "OK", "check_factor": "Something removed"},
		                 {"idx": 2, "status": "OK", "check_factor": "Oil level"}]
		with self.as_scout():
			with self.assertRaises(api.TemplateChanged):
				api.submit_asset_check_sheet(self.payload(a, sections=sections, template_fingerprint=""))
			# no fingerprint and no check_factor at all is no better than a mismatch
			bare = {"a": [{"idx": 1, "status": "OK", "check_factor": ""}, {"idx": 2, "status": "OK", "check_factor": ""}],
			        "b": [{"idx": 1, "status": "OK", "check_factor": ""}]}
			with self.assertRaises(api.TemplateChanged):
				api.submit_asset_check_sheet(self.payload(a, sections=bare, template_fingerprint=""))
			# an answer for a row the template no longer has
			extra = self.answers()
			extra["b"].append({"idx": 2, "status": "OK", "check_factor": "Gone"})
			with self.assertRaises(api.TemplateChanged):
				api.submit_asset_check_sheet(self.payload(a, sections=extra))
		self.assertEqual(frappe.db.count("Asset Check Sheet", {"asset": a}), 0)

	def test_matching_fingerprint_and_factors_accepted(self):
		a = self.asset()
		with self.as_scout():
			r = api.submit_asset_check_sheet(self.payload(a))
		self.assertEqual(r["docstatus"], 1)

	def test_duplicate_without_client_id_column(self):
		"""upande_asset installed after SCP: no column, so a retry is found by
		asset + template + date + owner."""
		a = self.asset()
		with patch.object(api, "_has_client_id_column", return_value=False), self.as_scout():
			first = api.submit_asset_check_sheet(self.payload(a))
			again = api.submit_asset_check_sheet(self.payload(a))  # a fresh client_id: the retry has no column to match
		self.assertFalse(first["duplicate"])
		self.assertTrue(again["duplicate"])
		self.assertEqual(again["name"], first["name"])
		self.assertEqual(frappe.db.count("Asset Check Sheet", {"asset": a}), 1)

	def test_already_exists_from_upande_asset_resolves_to_the_winner(self):
		a = self.asset()
		with self.as_scout():
			first = api.submit_asset_check_sheet(self.payload(a))
			# a racing twin got past the due check; upande_asset's one-a-day rule then fires
			with patch.object(api, "_due", return_value=(True, None, None)), \
			     patch.object(api, "_existing_by_client_id", return_value=None), \
			     patch.object(frappe.db, "rollback"):  # keep the test fixtures
				again = api.submit_asset_check_sheet(self.payload(a))
		self.assertTrue(again["duplicate"])
		self.assertEqual(again["name"], first["name"])
		self.assertEqual(frappe.db.count("Asset Check Sheet", {"asset": a}), 1)

	def test_lock_is_taken_per_client_id_and_released(self):
		a = self.asset()
		p = self.payload(a)
		key = api._lock_key(p)
		with self.as_scout():
			api.submit_asset_check_sheet(p)
		self.assertEqual(int(frappe.db.sql("select is_free_lock(%s)", key)[0][0]), 1)
		self.assertNotEqual(api._lock_key(p), api._lock_key(self.payload(a)))  # per client_id
		# released even when the submission is refused
		bad = self.payload(a, template_fingerprint="0" * 16)
		with self.as_scout(), self.assertRaises(api.TemplateChanged):
			api.submit_asset_check_sheet(bad)
		self.assertEqual(int(frappe.db.sql("select is_free_lock(%s)", api._lock_key(bad))[0][0]), 1)

	def test_lock_loser_gets_the_winners_sheet(self):
		a = self.asset()
		p = self.payload(a)
		with self.as_scout():
			winner = api.submit_asset_check_sheet(p)
			with patch.object(api, "_get_lock", return_value=False):  # timed out waiting on the twin
				loser = api.submit_asset_check_sheet(p)
				self.assertTrue(loser["duplicate"])
				self.assertEqual(loser["name"], winner["name"])
				# the twin has not committed anything yet: a retryable 503, not a refusal
				with self.assertRaises(frappe.ServiceUnavailableError):
					api.submit_asset_check_sheet(self.payload(a))

	def test_lock_really_excludes_a_second_connection(self):
		from frappe.database import get_db

		other = get_db(host=frappe.conf.db_host or "127.0.0.1", user=frappe.conf.db_name,
		               password=frappe.conf.db_password, port=frappe.conf.db_port)
		key = "scp_ac:test-" + uuid.uuid4().hex
		try:
			with api._client_lock(key, 1) as got:
				self.assertTrue(got)
				self.assertEqual(int(other.sql("select get_lock(%s, 0)", key)[0][0]), 0)
			self.assertEqual(int(other.sql("select get_lock(%s, 0)", key)[0][0]), 1)
			other.sql("select release_lock(%s)", key)
		finally:
			other.close()

	def test_check_date_clamped_to_three_days_back(self):
		for days, ok in ((-4, False), (-3, True), (1, False)):
			with self.subTest(days=days):
				frappe.set_user("Administrator")
				a = self.asset()
				with self.as_scout():
					p = self.payload(a, check_date=add_days(nowdate(), days))
					if ok:
						self.assertEqual(api.submit_asset_check_sheet(p)["docstatus"], 1)
					else:
						with self.assertRaises(frappe.ValidationError):
							api.submit_asset_check_sheet(p)

	def test_due_is_judged_on_the_check_date(self):
		a = self.asset()
		with self.as_scout():
			api.submit_asset_check_sheet(self.payload(a, check_date=add_days(nowdate(), -2)))
			# weekly: a sheet dated yesterday is still inside the week of the one two days ago
			with self.assertRaises(frappe.ValidationError):
				api.submit_asset_check_sheet(self.payload(a, check_date=add_days(nowdate(), -1)))

	def test_next_due_is_the_later_of_schedule_and_last_sheet(self):
		a = self.asset()
		sch = frappe.get_doc({"doctype": "Asset Check Sheet Schedule", "asset": a,
		                      "check_sheet_template": self.template_name, "enabled": 1}).insert()
		frappe.db.set_value(sch.doctype, sch.name, "next_due_date", add_days(nowdate(), -5))
		with self.as_scout():
			api.submit_asset_check_sheet(self.payload(a, check_date=add_days(nowdate(), -3)))
		frappe.set_user("Administrator")
		frappe.db.set_value(sch.doctype, sch.name, "next_due_date", add_days(nowdate(), -1))  # a stale schedule
		s = self.config_row(a)
		self.assertFalse(s["due"])  # last sheet + 7 days wins over the lagging schedule
		self.assertEqual(s["next_due_date"], add_days(nowdate(), 4))
		frappe.db.set_value(sch.doctype, sch.name, "next_due_date", add_days(nowdate(), 6))  # schedule later
		self.assertEqual(self.config_row(a)["next_due_date"], add_days(nowdate(), 6))

	def test_quarterly_matches_upande_asset(self):
		self.assertEqual(api.FREQ_DAYS["Quarterly"], 90)
		self.assertEqual(api.FREQ_DAYS["Yearly"], 365)

	def test_asset_on_two_farms_shows_the_scouts_own_farm(self):
		if not frappe.db.has_column("Farm", "company"):
			self.skipTest("Farm has no company column here")
		a = self.asset(OTHER_FARM)
		frappe.db.sql("update `tabFarm` set company=%s where name in %s", (self.company, (FARM, OTHER_FARM)))
		api.save_asset_check_settings({"enabled": 1, "rows": [
			{"farm": FARM, "asset_category": self.cat, "enabled": 1},
			{"farm": OTHER_FARM, "asset_category": self.cat, "enabled": 1}]})
		with patch.object(api, "_asset_has_farm", return_value=False):
			for home in (FARM, OTHER_FARM):
				with self.subTest(home=home), patch.object(api, "_home_farms", return_value={home}):
					self.assertEqual(self.config_row(a)["farm"], home)

	def test_setup_guard_creates_the_field_only_when_the_table_exists(self):
		from upande_scp.serverscripts.asset_checks import setup

		self.assertTrue(setup.ensure_client_id_field())  # present (or created now)
		with patch.object(frappe.db, "table_exists", return_value=False):
			self.assertFalse(setup.ensure_client_id_field())
