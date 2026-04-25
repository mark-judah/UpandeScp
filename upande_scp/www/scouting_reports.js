/* ────────────────────────────────────────────────────────
 * Scouting Reports page controller
 * Wires six buttons to six whitelisted endpoints.
 * ──────────────────────────────────────────────────────── */

(function () {
	"use strict";

	var root = document.getElementById("scouting-reports-root");
	if (!root) return;

	/* ── API endpoints ── */
	var API = {
		"email-daily":  "upande_scp.serverscripts.send_daily_scouting_report.trigger_daily_email",
		"email-weekly": "upande_scp.serverscripts.send_weekly_trap_report.trigger_weekly_email",
		"email-fcm":    "upande_scp.serverscripts.send_fcm_weekly_excel_report.trigger_fcm_email",
		"dl-daily":     "upande_scp.serverscripts.send_daily_scouting_report.download_daily_pdf",
		"dl-weekly":    "upande_scp.serverscripts.send_weekly_trap_report.download_weekly_pdf",
		"dl-fcm":       "upande_scp.serverscripts.send_fcm_weekly_excel_report.download_fcm_xlsx",
		"list-fcm-farms": "upande_scp.serverscripts.send_fcm_weekly_excel_report.list_farms_with_data",
	};

	var LABELS = {
		"email-daily":  "Daily Scouting",
		"email-weekly": "Weekly Trap Report",
		"email-fcm":    "KEPHIS FCM Weekly",
		"dl-daily":     "daily_scouting.pdf",
		"dl-weekly":    "weekly_trap_report.pdf",
		"dl-fcm":       "kephis_fcm_weekly.xlsx",
	};

	/* ── Status strip ── */
	var statusEl = root.querySelector("#sr-status");
	var statusMsg = root.querySelector("#sr-status-msg");
	var statusClose = root.querySelector("#sr-status-close");
	if (statusClose) {
		statusClose.addEventListener("click", function () {
			statusEl.hidden = true;
		});
	}

	function showStatus(msg, kind) {
		if (!statusEl) return;
		statusEl.classList.remove("is-error", "is-info");
		if (kind === "error") statusEl.classList.add("is-error");
		else if (kind === "info") statusEl.classList.add("is-info");
		statusMsg.textContent = msg;
		statusEl.hidden = false;
	}

	/* ── Button state ── */
	function setBusy(btn, label) {
		if (!btn) return;
		btn.dataset.origLabel = btn.dataset.origLabel || btn.textContent;
		btn.disabled = true;
		btn.innerHTML = '<span class="sr-spinner"></span>' + (label || "Working…");
	}
	function clearBusy(btn) {
		if (!btn) return;
		btn.disabled = false;
		btn.textContent = btn.dataset.origLabel || "";
	}

	/* ── CSRF helper ── */
	function csrfToken() {
		if (window.frappe && window.frappe.csrf_token) return window.frappe.csrf_token;
		var meta = document.querySelector('meta[name="csrf_token"]');
		return meta ? meta.getAttribute("content") : "";
	}

	/* ── Farm-select helpers ── */
	function getFarmFor(action) {
		var sel = root.querySelector('[data-farm-select="' + action + '"]');
		return sel ? sel.value : "";
	}

	function populateFarmSelectors() {
		var selects = root.querySelectorAll("select[data-farm-select]");
		if (!selects.length) return;
		fetch("/api/method/" + API["list-fcm-farms"], {
			method: "POST",
			headers: {
				"X-Frappe-CSRF-Token": csrfToken(),
				"X-Requested-With": "XMLHttpRequest",
				"Accept": "application/json",
			},
			credentials: "same-origin",
		})
			.then(function (r) { return r.ok ? r.json() : { message: [] }; })
			.then(function (json) {
				var farms = (json && json.message) || [];
				if (!farms.length) return;
				selects.forEach(function (sel) {
					farms.forEach(function (f) {
						var opt = document.createElement("option");
						opt.value = f.farm;
						opt.textContent = f.display + (f.kephis_farm_id ? " — " + f.kephis_farm_id : "");
						sel.appendChild(opt);
					});
				});
			})
			.catch(function () { /* silent — selects stay on defaults */ });
	}

	/* ── Trigger (email) handler ── */
	function triggerEmail(action, btn) {
		var method = API[action];
		var label = LABELS[action];
		setBusy(btn, "Queuing email…");
		showStatus("Sending " + label + " email…", "info");

		var body = null;
		var headers = {
			"X-Frappe-CSRF-Token": csrfToken(),
			"X-Requested-With": "XMLHttpRequest",
			"Accept": "application/json",
		};
		var farm = getFarmFor(action);
		if (farm) {
			headers["Content-Type"] = "application/x-www-form-urlencoded";
			body = "farm=" + encodeURIComponent(farm);
		}

		fetch("/api/method/" + method, {
			method: "POST",
			headers: headers,
			body: body,
			credentials: "same-origin",
		})
			.then(function (r) {
				if (!r.ok) return r.text().then(function (t) { throw new Error("HTTP " + r.status + " — " + t.slice(0, 200)); });
				return r.json();
			})
			.then(function (json) {
				var rec = (json && json.message && json.message.recipients) || [];
				if (rec.length) {
					showStatus(label + " email sent to: " + rec.join(", "), "success");
				} else {
					showStatus(label + " email queued.", "success");
				}
			})
			.catch(function (e) {
				showStatus("Failed to send " + label + ": " + e.message, "error");
			})
			.finally(function () {
				clearBusy(btn);
			});
	}

	/* ── Download handler ── */
	function downloadFile(action, btn) {
		var method = API[action];
		var label = LABELS[action];

		var farm = getFarmFor(action);
		var sel = root.querySelector('[data-farm-select="' + action + '"]');
		if (sel && !farm) {
			showStatus("Please choose a farm before downloading the FCM report.", "error");
			return;
		}

		setBusy(btn, "Generating…");
		showStatus("Generating " + label + "…", "info");

		var headers = {
			"X-Frappe-CSRF-Token": csrfToken(),
			"X-Requested-With": "XMLHttpRequest",
		};
		var body = null;
		if (farm) {
			headers["Content-Type"] = "application/x-www-form-urlencoded";
			body = "farm=" + encodeURIComponent(farm);
		}

		fetch("/api/method/" + method, {
			method: "POST",
			headers: headers,
			body: body,
			credentials: "same-origin",
		})
			.then(function (r) {
				if (!r.ok) return r.text().then(function (t) { throw new Error("HTTP " + r.status + " — " + t.slice(0, 200)); });
				var cd = r.headers.get("Content-Disposition") || "";
				var fname = label;
				var m = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(cd);
				if (m) fname = decodeURIComponent(m[1]);
				return r.blob().then(function (b) { return { blob: b, filename: fname }; });
			})
			.then(function (out) {
				var url = URL.createObjectURL(out.blob);
				var a = document.createElement("a");
				a.href = url;
				a.download = out.filename;
				document.body.appendChild(a);
				a.click();
				a.remove();
				setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
				showStatus("Downloaded " + out.filename, "success");
			})
			.catch(function (e) {
				showStatus("Download failed: " + e.message, "error");
			})
			.finally(function () {
				clearBusy(btn);
			});
	}

	/* ── Wire up buttons ── */
	root.addEventListener("click", function (ev) {
		var btn = ev.target.closest("button[data-action]");
		if (!btn) return;
		var action = btn.getAttribute("data-action");
		if (!API[action]) return;
		if (action.indexOf("email-") === 0) {
			triggerEmail(action, btn);
		} else if (action.indexOf("dl-") === 0) {
			downloadFile(action, btn);
		}
	});

	populateFarmSelectors();
})();
