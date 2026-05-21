// ============================================================
//  Stock Entry — List View
//  "Spray Plan Transfers" redirect button
//
//  Replaces the old in-page bulk-submit modal (which kept failing
//  silently and disappearing when the bypass script wasn't loaded)
//  with a single redirect to the React Spray Plan Transfers page
//  inside /scp_app. The whole bulk-submit + biometric flow now lives
//  there, in a properly tested form.
//
//  Visibility: only injected when the current user holds the
//  ``Store Keeper`` role — every other role keeps the default Stock
//  Entry list view untouched.
// ============================================================

const SK_ROLE = "Store Keeper";
const TRANSFERS_URL = "/scp_app/#/spray-plan-transfers";
const STAR = '<span aria-hidden="true" style="display:inline-block;margin-right:6px;color:#f59e0b;">★</span>';

(function () {
	const existing = frappe.listview_settings["Stock Entry"] || {};
	const prevOnload = existing.onload;
	frappe.listview_settings["Stock Entry"] = Object.assign(existing, {
		onload(listview) {
			if (typeof prevOnload === "function") {
				try {
					prevOnload.call(this, listview);
				} catch (e) {
					console.error("Prior onload failed:", e);
				}
			}
			const roles = frappe.boot.user.roles || [];
			if (!roles.includes(SK_ROLE)) return;

			const btn = listview.page.add_button("Spray Plan Transfers", () => {
				window.location.href = TRANSFERS_URL;
			});
			if (btn && btn.length) {
				const html = btn.html();
				if (html && !html.includes(STAR)) {
					btn.html(`${STAR}${html}`);
				}
				btn.attr(
					"title",
					"Open the biometric-authorised Spray Plan Transfers page",
				);
			}
		},
	});
})();
