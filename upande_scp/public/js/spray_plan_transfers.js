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

// Spray Plan Transfers — Stock Entry list-view button
//
// Defensively re-installs itself on every list refresh so other apps'
// client scripts can't clobber our onload by replacing
// ``frappe.listview_settings["Stock Entry"]``. The button is
// idempotent: we tag the DOM node with ``data-spt-button`` and skip
// re-injection if it's already present.

const SK_ROLE = "Store Keeper";
const TRANSFERS_URL = "/scp_app/#/spray-plan-transfers";
const BTN_LABEL = "Spray Plan Transfers";
const BTN_TAG = "spt-spray-plan-transfers-btn";
const FLASK_ICON =
	'<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-2px;margin-right:6px;color:#0ea5e9;"><path d="M9 3h6"/><path d="M10 3v6.5L4.5 19a2 2 0 0 0 1.7 3h11.6a2 2 0 0 0 1.7-3L14 9.5V3"/><path d="M6.5 14h11"/></svg>';

function _spt_install_button(listview) {
	if (!listview || !listview.page) return;
	const roles = (frappe.boot && frappe.boot.user && frappe.boot.user.roles) || [];
	if (!roles.includes(SK_ROLE)) return;

	// Already injected? page.wrapper survives across refreshes; the
	// data-* attribute is our idempotency tag.
	const wrapper = listview.page.wrapper;
	if (wrapper && wrapper.find(`[data-${BTN_TAG}]`).length) return;

	const $btn = listview.page.add_button(BTN_LABEL, () => {
		window.location.href = TRANSFERS_URL;
	});
	if ($btn && $btn.length) {
		const html = $btn.html();
		if (html && !html.includes("svg")) {
			$btn.html(`${FLASK_ICON}${html}`);
		}
		$btn.attr("data-" + BTN_TAG, "1");
		$btn.attr(
			"title",
			"Open the biometric-authorised Spray Plan Transfers page",
		);
	}
}

(function () {
	const existing = frappe.listview_settings["Stock Entry"] || {};
	const prevOnload = existing.onload;
	const prevRefresh = existing.refresh;
	frappe.listview_settings["Stock Entry"] = Object.assign(existing, {
		onload(listview) {
			if (typeof prevOnload === "function") {
				try {
					prevOnload.call(this, listview);
				} catch (e) {
					console.error("[spray-plan-transfers] prior onload failed:", e);
				}
			}
			_spt_install_button(listview);
		},
		// Re-install on every refresh too. Frappe's list view rebuilds the
		// page-actions area when filters change or the list reloads, which
		// previously made the button disappear on the first refresh.
		refresh(listview) {
			if (typeof prevRefresh === "function") {
				try {
					prevRefresh.call(this, listview);
				} catch (e) {
					console.error("[spray-plan-transfers] prior refresh failed:", e);
				}
			}
			_spt_install_button(listview);
		},
	});
})();

