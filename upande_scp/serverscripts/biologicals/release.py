"""Biological Release: a spray supervisor puts predators into a greenhouse, from the store.

Submitting posts a Material Issue from the farm's chemical store (Farm.custom_chemical_store,
else the name convention in `common.stores`), booked to the greenhouse's cost centre. A
zero-valued item or batch is never issued: no `allow_zero_valuation_rate`, a fix-it message
instead. The mobile app calls `release_biological`, offline too (client-id dedupe).
"""

from __future__ import annotations

import frappe
from frappe.model.document import Document
from frappe.utils import add_days, flt, get_datetime, now_datetime

from upande_scp.serverscripts.common import crop_catalog, stores
from upande_scp.serverscripts.common.timezone import to_site_naive

ROLES = {"SCP Spray Supervisor", "SCP General Manager", "System Manager"}
ROSE = ("rose", "roses")
HARMFUL = 3


def _is_rose(crop) -> bool:
	return (crop or "").strip().lower() in ROSE


def _employee(user=None):
	return frappe.db.get_value("Employee", {"user_id": user or frappe.session.user, "status": "Active"}, "name")


def _assert_role():
	if frappe.session.user == "Administrator" or ROLES & set(frappe.get_roles()):
		return
	frappe.throw("Only a spray supervisor can release biologicals.", frappe.PermissionError)


class BiologicalRelease(Document):
	def validate(self):
		if flt(self.quantity) <= 0:
			frappe.throw("Quantity must be more than zero.")
		self.farm = frappe.db.get_value("Warehouse", self.greenhouse, "custom_farm")
		if not self.farm:
			frappe.throw(f"{self.greenhouse} is not a greenhouse of a farm.")
		if frappe.db.get_value("Warehouse", self.greenhouse, "warehouse_type") != "Greenhouse":
			frappe.throw(f"{self.greenhouse} is not a greenhouse.")
		self.crop = crop_catalog.crop_for_greenhouse(self.greenhouse) or ""
		if not _is_rose(self.crop):
			frappe.throw("Biological releases are recorded for roses greenhouses only for now.")
		pred = frappe.get_doc("Predator", self.predator)
		stages = [r.stage for r in pred.predator_stages if r.stage]
		if self.stage and stages and self.stage not in stages:
			frappe.throw(f"{self.predator} has no stage {self.stage}. Pick one of: {', '.join(stages)}.")
		self.item = self.item or pred.item
		if not self.item:
			frappe.throw(f"{self.predator} has no stock item. Link its Biologicals item on the Predator first.",
			             title="No stock item")
		stock_uom = frappe.db.get_value("Item", self.item, "stock_uom")
		self.uom = self.uom or stock_uom
		factor = self._factor(stock_uom)
		self.store = self.store or stores.primary_store(self.farm, "chemical")
		if not self.store:
			frappe.throw(f"Farm {self.farm} has no store mapped. Set its chemical store on the Farm so releases can be issued.",
			             title="No store")
		if not self.released_by:
			self.released_by = _employee()
		self._pick_batch(stock_uom, factor)

	def _factor(self, stock_uom) -> float:
		if self.uom == stock_uom:
			return 1.0
		f = frappe.db.get_value("UOM Conversion Detail", {"parent": self.item, "uom": self.uom}, "conversion_factor")
		if not f:
			frappe.throw(f"{self.item} has no conversion from {self.uom} to {stock_uom}. Add it on the Item or release in {stock_uom}.")
		return flt(f)

	def _pick_batch(self, stock_uom, factor):
		if not frappe.db.get_value("Item", self.item, "has_batch_no"):
			self.batch_no = None
			return
		from upande_scp.serverscripts.store.batch_stock import available_in_store
		need = flt(self.quantity) * factor
		batches = available_in_store([(self.item, self.store)]).get((self.item, self.store), [])
		if self.batch_no:
			mine = [b for b in batches if b["batch_no"] == self.batch_no]
			if not mine:
				frappe.throw(f"Batch {self.batch_no} has no stock in {self.store}.")
			self._not_zero_valued(mine[0])
			return
		ok = [b for b in batches if not b["zero_valued"] and b["qty"] >= need]
		if not ok:
			if any(b["zero_valued"] for b in batches):
				self._not_zero_valued([b for b in batches if b["zero_valued"]][0])
			frappe.throw(f"No batch of {self.item} in {self.store} holds {need:g} {stock_uom}. Receive stock into the store first.",
			             title="Not enough stock")
		ok.sort(key=lambda b: (b["expiry_date"] or get_datetime("2999-12-31").date(), str(b["created"])))
		self.batch_no = ok[0]["batch_no"]

	def _not_zero_valued(self, batch):
		if batch["zero_valued"]:
			frappe.throw(
				f"Batch {batch['batch_no']} of {self.item} in {self.store} is valued at zero, and a zero-valued batch is never issued. "
				"Ask the store to receive it with a rate (a Purchase Receipt or a Stock Reconciliation with a valuation rate), then release again.",
				title="Stock has no value")

	def before_submit(self):
		stock_uom = frappe.db.get_value("Item", self.item, "stock_uom")
		need = flt(self.quantity) * self._factor(stock_uom)
		have = flt(frappe.db.get_value("Bin", {"item_code": self.item, "warehouse": self.store}, "actual_qty"))
		if have < need:
			frappe.throw(f"{self.store} holds {have:g} {stock_uom} of {self.item}; this release needs {need:g}.",
			             title="Not enough stock")

	def on_submit(self):
		self.db_set("stock_entry", self._post_issue(), update_modified=False)

	def on_cancel(self):
		if self.stock_entry:
			se = frappe.get_doc("Stock Entry", self.stock_entry)
			if se.docstatus == 1:
				se.flags.ignore_permissions = True
				se.cancel()

	def _post_issue(self) -> str:
		from upande_scp.serverscripts.finance import accounts, cost_centres
		company = frappe.db.get_value("Warehouse", self.store, "company")
		stock_uom = frappe.db.get_value("Item", self.item, "stock_uom")
		factor = self._factor(stock_uom)
		account, _ = accounts.first_present(accounts.expense_account_candidates(self.item, company))
		if not account:
			frappe.throw(f"{self.item} has no expense account for {company}: set the Item Default or the company's default expense account.",
			             title="No expense account")
		cc = cost_centres.resolve(self.greenhouse)[0] or cost_centres.company_default(company)
		moment = get_datetime(self.released_at)
		row = {"item_code": self.item, "qty": flt(self.quantity), "uom": self.uom, "stock_uom": stock_uom,
		       "conversion_factor": factor, "s_warehouse": self.store, "expense_account": account,
		       "cost_center": cc, "farm": self.farm}
		if self.batch_no:
			row.update(batch_no=self.batch_no, use_serial_batch_fields=1)
		se = frappe.get_doc({
			"doctype": "Stock Entry", "stock_entry_type": "Material Issue", "purpose": "Material Issue",
			"company": company, "posting_date": moment.date().isoformat(), "posting_time": moment.time().isoformat(),
			"set_posting_time": 1, "from_warehouse": self.store, "farm": self.farm,
			"remarks": f"Biological release {self.name}: {self.predator} {self.stage or ''} into {self.greenhouse}",
			"items": [row]})
		se.flags.ignore_permissions = True
		se.insert()
		for r in se.items:
			if flt(r.basic_rate) <= 0:
				frappe.throw(
					f"{self.item} in {self.store} has no value (rate 0), and a zero-valued item is never issued. "
					"Ask the store to receive it with a rate (Purchase Receipt, or Stock Reconciliation with a valuation rate), then release again.",
					title="Stock has no value")
		se.submit()
		return se.name


# --- warnings: a release after a harmful spray --------------------------------

def harmful_sprays(greenhouse, predator, stage=None, when=None) -> list[dict]:
	"""Completed/approved sprays on `greenhouse` whose residue is still harmful to `predator`
	at `when` (spray time + persistence days > when, class >= 3)."""
	from upande_scp.serverscripts.spray_compliance import context as C
	when = get_datetime(when) if when else now_datetime()
	look = add_days(when, -60)
	rows = frappe.db.sql("""select wo.name wo, wo.custom_scheduled_application_time `when`, wi.item_code
	                        from `tabWork Order` wo join `tabWork Order Item` wi on wi.parent = wo.name
	                        where wo.custom_greenhouse=%(g)s and wo.custom_type='Application Floor Plan'
	                          and wo.workflow_state in %(st)s
	                          and wo.custom_scheduled_application_time between %(a)s and %(b)s
	                        order by wo.custom_scheduled_application_time desc""",
	                     {"g": greenhouse, "st": C.ACTIVE_STATES, "a": look, "b": when}, as_dict=True)
	items = sorted({r.item_code for r in rows})
	if not items:
		return []
	products = C.load_products(items)
	out = []
	for r in rows:
		for imp in (products.get(r.item_code) or {}).get("impacts", []):
			if imp["predator"] != predator or imp["cls"] < HARMFUL or imp["persistence"] <= 0:
				continue
			if imp["stage"] and stage and imp["stage"] != stage:
				continue
			until = add_days(get_datetime(r.when), imp["persistence"])
			if until > when:
				out.append({"wo": r.wo, "when": str(r.when)[:19], "product": products[r.item_code]["name"],
				            "ingredient": imp["ingredient"], "cls": imp["cls"], "harmful_until": str(until)[:10]})
	return out


def release_warnings(greenhouse, predator, stage=None, when=None) -> list[str]:
	from upande_scp.serverscripts.spray_compliance import context as C, rules as R
	crop = crop_catalog.crop_for_greenhouse(greenhouse) or ""
	if (C.load_modes(crop).get("predator_harm") or "Warn") == "Off":
		return []
	return [f"{h['product']} ({h['ingredient']}) sprayed on {h['when'][:10]} is {R.CLASS_NAMES[h['cls']]} to {predator} "
	        f"and its residue stays harmful until about {h['harmful_until']}; the release may be killed." for h in
	        harmful_sprays(greenhouse, predator, stage, when)]


# --- API ----------------------------------------------------------------------

def _scope():
	from upande_scp.serverscripts.sprayers import api as sprayers_api
	return sprayers_api.scope("Rose")


@frappe.whitelist()
def get_release_config():
	"""What the Release screen offers: greenhouses of the user's farms (roses) with their store,
	and the predators that have a stock item."""
	_assert_role()
	sc = _scope()
	houses = crop_catalog.greenhouses_for_crop("Rose")
	rows = frappe.get_all("Warehouse", filters={"name": ["in", sorted(houses) or [""]], "warehouse_type": "Greenhouse", "is_group": 0, "disabled": 0}, fields=["name", "custom_farm"],
	                      order_by="name asc")
	gh = []
	for r in rows:
		if sc["farms"] is not None and r.custom_farm not in sc["farms"]:
			continue
		gh.append({"name": r.name, "farm": r.custom_farm, "store": stores.primary_store(r.custom_farm, "chemical")})
	preds = []
	for p in frappe.get_all("Predator", filters={"item": ["is", "set"]},
	                        fields=["name", "scientific_name", "item", "kind"], order_by="name asc"):
		item = frappe.db.get_value("Item", p.item, ["stock_uom", "item_name"], as_dict=True) or {}
		preds.append({**p, "uom": item.get("stock_uom"),
		              "stages": frappe.get_all("Predator Stages", filters={"parent": p.name, "parenttype": "Predator"},
		                                       pluck="stage", order_by="idx asc")})
	return {"enabled": bool(gh and preds), "greenhouses": gh, "predators": preds}


@frappe.whitelist()
def check_release(greenhouse, predator, stage=None, released_at=None):
	_assert_role()
	return {"warnings": release_warnings(greenhouse, predator, stage or None, to_site_naive(released_at))}


@frappe.whitelist()
def release_biological(greenhouse, predator, quantity, stage=None, uom=None, client_id=None, released_at=None,
                       notes=None, batch_no=None):
	"""Create and submit a release. Idempotent on `client_id`: a retry returns the same document."""
	_assert_role()
	if client_id:
		have = frappe.db.get_value("Biological Release", {"client_id": client_id}, ["name", "docstatus"], as_dict=True)
		if have:
			return {"name": have.name, "duplicate": True, "warnings": []}
	sc = _scope()
	farm = frappe.db.get_value("Warehouse", greenhouse, "custom_farm")
	if sc["farms"] is not None and farm not in sc["farms"]:
		frappe.throw(f"You are not rostered on farm {farm or greenhouse}.", frappe.PermissionError)
	moment = to_site_naive(released_at) or now_datetime()
	warnings = release_warnings(greenhouse, predator, stage or None, moment)
	doc = frappe.get_doc({"doctype": "Biological Release", "greenhouse": greenhouse, "predator": predator,
	                      "stage": stage or None, "quantity": flt(quantity), "uom": uom or None,
	                      "released_at": moment, "client_id": client_id or None, "notes": notes,
	                      "batch_no": batch_no or None})
	doc.flags.ignore_permissions = True
	frappe.db.savepoint("bio_release")
	try:
		doc.insert()
		doc.submit()
	except Exception:
		# A refused release leaves no draft behind (and the retry is not a duplicate).
		frappe.db.rollback(save_point="bio_release")
		raise
	if warnings:
		doc.add_comment("Info", "Released after a harmful spray: " + " ".join(warnings))
	return {"name": doc.name, "duplicate": False, "warnings": warnings}


@frappe.whitelist()
def recent_releases(greenhouse, limit=10):
	_assert_role()
	return frappe.get_all("Biological Release", filters={"greenhouse": greenhouse, "docstatus": 1},
	                      fields=["name", "released_at", "predator", "stage", "quantity", "uom", "released_by_name"],
	                      order_by="released_at desc", limit_page_length=int(limit))


@frappe.whitelist()
def list_releases(from_date=None, to_date=None, greenhouse=None, predator=None, farm=None, limit=500):
	"""History for the Biologicals page: rows plus totals by predator and by greenhouse."""
	sc = _scope()
	filters = {"docstatus": 1}
	# greenhouse / farm each take one name or several (JSON list, comma names)
	from upande_scp.serverscripts.common.place_filter import parse_names
	houses, farms = parse_names(greenhouse), parse_names(farm)
	if houses:
		filters["greenhouse"] = houses[0] if len(houses) == 1 else ["in", houses]
	if predator:
		filters["predator"] = predator
	if farms:
		filters["farm"] = farms[0] if len(farms) == 1 else ["in", farms]
	elif sc["farms"] is not None:
		filters["farm"] = ["in", sorted(sc["farms"]) or [""]]
	if from_date:
		filters["released_at"] = [">=", f"{from_date} 00:00:00"]
	if to_date:
		filters["released_at"] = ["between", [f"{from_date or '2000-01-01'} 00:00:00", f"{to_date} 23:59:59"]]
	rows = frappe.get_all("Biological Release", filters=filters,
	                      fields=["name", "released_at", "greenhouse", "farm", "predator", "stage", "quantity", "uom",
	                              "item", "batch_no", "store", "released_by", "released_by_name", "stock_entry", "notes"],
	                      order_by="released_at desc", limit_page_length=int(limit))
	by_pred, by_gh = {}, {}
	for r in rows:
		k = (r.predator, r.uom)
		by_pred[k] = by_pred.get(k, 0) + flt(r.quantity)
		by_gh[r.greenhouse] = by_gh.get(r.greenhouse, 0) + flt(r.quantity)
	return {"rows": rows,
	        "by_predator": [{"predator": p, "uom": u, "quantity": q} for (p, u), q in sorted(by_pred.items())],
	        "by_greenhouse": [{"greenhouse": g, "quantity": q} for g, q in sorted(by_gh.items())],
	        "filters": {"greenhouses": sorted({r.greenhouse for r in rows}),
	                    "predators": frappe.get_all("Predator", pluck="name", order_by="name asc")}}
