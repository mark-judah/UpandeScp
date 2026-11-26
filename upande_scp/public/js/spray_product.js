// Desk form script for Spray Product.
//
// One doctype now covers chemicals and foliars; `category` carries the
// distinction, and it is set from the Item's Item Group rather than typed, so
// the form explains where it came from instead of inviting an edit that the
// next Item save would undo.
// A rate is "stock UOM per an amount of Water or Area": a Water row's unit is a Volume
// UOM, an Area row's an Area UOM, both convertible to Litre / Square Meter. The server
// refuses anything else, so the picker only offers what converts.
const SCP_RATE_UOMS = { Water: null, Hectarage: null };
function scpLoadRateUoms() {
	if (SCP_RATE_UOMS.Water) return Promise.resolve();
	return frappe
		.call("upande_scp.serverscripts.common.spray_rates.get_rate_uoms")
		.then((r) => Object.assign(SCP_RATE_UOMS, r.message || {}));
}
const SCP_LEGACY_UNIT = { Water: [1000, "Litre"], Hectarage: [1, "Hectare"] };

function scpRenderRates(frm) {
	const rows = (frm.doc.crop_rates || []).filter((r) => r.rate_line);
	const legacy =
		flt(frm.doc.default_lower_rate_limit) || flt(frm.doc.default_upper_rate_limit)
			? `<li>${frappe.utils.escape_html(
					`${frm.doc.product_name || frm.doc.item}: ${flt(frm.doc.default_lower_rate_limit)}\u2013${flt(
						frm.doc.default_upper_rate_limit,
					)} ${frm.doc.stock_uom || ""} per 1000 Litre of water (default, every crop)`,
				)}</li>`
			: "";
	const lines = rows
		.map((r) => {
			const crop = r.crop ? ` (${r.crop})` : " (every crop)";
			return `<li>${frappe.utils.escape_html(`${r.rate_line}${crop}`)}</li>`;
		})
		.join("");
	const html = lines || legacy ? `<ul class="list-unstyled" style="margin:0">${lines}${legacy}</ul>` : "";
	const f = frm.fields_dict.rate_summary;
	if (f) f.$wrapper.html(html || `<span class="text-muted">No rate lines yet.</span>`);
}

frappe.ui.form.on("Spray Product Crop Rate", {
	basis(frm, cdt, cdn) {
		// a basis change resets the unit to that basis's usual one
		const row = locals[cdt][cdn];
		const [qty, uom] = SCP_LEGACY_UNIT[row.basis] || SCP_LEGACY_UNIT.Water;
		frappe.model.set_value(cdt, cdn, { per_qty: qty, per_uom: uom });
	},
	crop_rates_add(frm, cdt, cdn) {
		const [qty, uom] = SCP_LEGACY_UNIT.Water;
		frappe.model.set_value(cdt, cdn, { per_qty: qty, per_uom: uom });
	},
});

frappe.ui.form.on("Spray Product", {
	onload(frm) {
		frm.set_query("per_uom", "crop_rates", (doc, cdt, cdn) => {
			const row = locals[cdt][cdn];
			const list = SCP_RATE_UOMS[row.basis || "Water"];
			return list && list.length ? { filters: { name: ["in", list] } } : {};
		});
		scpLoadRateUoms();
	},

	refresh(frm) {
		scpRenderRates(frm);
		if (frm.doc.disabled) {
			frm.dashboard.set_headline_alert(
				"This product's Item has left the configured crop-protection Item " +
					"Groups, so it is hidden from spray planning. Its rates and codes " +
					"are kept — move the Item back into a configured group to re-enable it.",
				"orange",
			);
		}
		if (frm.doc.item) {
			frm.add_custom_button(__("Open Item"), () =>
				frappe.set_route("Form", "Item", frm.doc.item),
			);
		}
	},

	crop_rates_remove(frm) {
		scpRenderRates(frm);
	},

	category(frm) {
		if (frm.doc.__islocal) return;
		frm.set_df_property(
			"category",
			"description",
			"Normally set from the Item's Item Group via Scouting and Crop " +
				"Protection Settings. An edit here is overwritten the next time the " +
				"Item's group changes.",
		);
	},
});
