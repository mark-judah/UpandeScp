// Trap location estimate — preview (dry run), confirm, write.
// Loaded on demand by the Trap form and list (frappe.require).

var TRAP_ESTIMATE = "upande_scp.serverscripts.traps.trap_location.estimate_trap_locations";
// Shared with trap_list.js: preview (dry run), then confirm and write.
window.scp_estimate_trap_locations = function (args, after) {
	frappe.call({
		method: TRAP_ESTIMATE,
		args: Object.assign({}, args, { dry_run: 1 }),
		freeze: true,
		freeze_message: __("Reading GPS fixes..."),
	}).then((r) => {
		const s = r.message || {};
		const lines = [
			__("Traps: {0}", [s.traps]),
			__("Would place: {0} ({1} unchanged)", [s.placed, s.unchanged]),
			__("Too few accurate fixes: {0}", [s.skipped_too_few]),
			__("No fixes at all: {0}", [s.no_fixes]),
			__("Manual (left alone): {0}", [s.unchanged_manual]),
			__("Flagged outside house: {0}", [s.flagged]),
		];
		frappe.confirm(lines.join("<br>") + "<br><br>" + __("Write these locations?"), () => {
			frappe.call({
				method: TRAP_ESTIMATE,
				args: Object.assign({}, args, { dry_run: 0 }),
				freeze: true,
			}).then((w) => {
				frappe.show_alert({
					message: __("{0} trap location(s) written", [(w.message || {}).placed - (w.message || {}).unchanged]),
					indicator: "green",
				});
				after && after();
			});
		});
	});
};

