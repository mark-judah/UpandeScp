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
// Inline SVG keeps the icon present even when Frappe is offline / asset
// CDNs are blocked, which is the whole point of shipping this button
// out of public/js (and not as a database Client Script that can vanish).
const FLASK_ICON =
	'<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-2px;margin-right:6px;color:#0ea5e9;"><path d="M9 3h6"/><path d="M10 3v6.5L4.5 19a2 2 0 0 0 1.7 3h11.6a2 2 0 0 0 1.7-3L14 9.5V3"/><path d="M6.5 14h11"/></svg>';

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
				if (html && !html.includes("svg")) {
					btn.html(`${FLASK_ICON}${html}`);
				}
				btn.attr(
					"title",
					"Open the biometric-authorised Spray Plan Transfers page",
				);
			}
		},
	});
})();
