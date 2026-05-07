// ============================================================
//  Stock Entry — List View Bundle
//  "Spray Plan Transfers"  →  Store Keeper role only
//
//  SCREEN 1 (Farm Picker):
//    • "Print Labels" buttons — for SUBMITTED (docstatus=1) SEs
//    • Farm buttons           — for DRAFT (docstatus=0) SEs
//
//  SCREEN 2 (Per-farm modal):
//    • Date RANGE picker (from / to) — both optional
//    • Chemical levels card recomputes for the visible range
//    • Bulk submit (drafts) or label generation (submitted)
//
//  LABEL GENERATOR — Zebra ZQ520 optimized
//    • Pure B/W thermal output (no colors, no shading)
//    • 4" wide labels (102mm)
//    • 1, 2, or 3 labels per page
// ============================================================

const SK_ROLE = "Store Keeper";
const AFP_TYPE = "Application Floor Plan";
const SE_PURPOSE = "Material Transfer for Manufacture";

// Merge into any existing listview_settings — other client scripts may
// register their own indicators/fields and we must not clobber them.
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
			const hasRole = (frappe.boot.user.roles || []).includes(SK_ROLE);
			if (!hasRole) return;
			injectSkStyles();
			listview.page.add_button("Spray Plan Transfers", () => openFarmPickerScreen());
		},
	});
})();

// ═══════════════════════════════════════════════════════════════════
//  DATA LOADER  — shared by both flows
// ═══════════════════════════════════════════════════════════════════

async function loadSprayPlanData(docstatus) {
	const seRes = await frappe.call({
		method: "frappe.client.get_list",
		args: {
			doctype: "Stock Entry",
			filters: [
				["purpose", "=", SE_PURPOSE],
				["docstatus", "=", docstatus],
				["work_order", "!=", ""],
			],
			fields: ["name", "work_order", "to_warehouse", "from_warehouse", "creation"],
			limit_page_length: 0,
		},
	});

	const seList = seRes.message || [];
	if (!seList.length) return { seList: [], woMap: {} };

	const woNames = [...new Set(seList.map((se) => se.work_order))];
	const woMap = {};

	const CHUNK = 500;
	for (let i = 0; i < woNames.length; i += CHUNK) {
		const chunk = woNames.slice(i, i + CHUNK);
		const woRes = await frappe.call({
			method: "frappe.client.get_list",
			args: {
				doctype: "Work Order",
				filters: [
					["name", "in", chunk],
					["custom_type", "=", AFP_TYPE],
					["docstatus", "=", 1],
				],
				fields: ["name", "custom_greenhouse", "custom_spray_type"],
				limit_page_length: 0,
			},
		});

		(woRes.message || []).forEach((wo) => {
			woMap[wo.name] = wo;
		});
	}

	const filtered = seList.filter((se) => woMap[se.work_order]);
	return { seList: filtered, woMap };
}

function buildFarmMap(seList, woMap) {
	const farmMap = {};

	seList.forEach((se) => {
		const wo = woMap[se.work_order] || {};
		const gh = wo.custom_greenhouse || "Unknown GH";
		const csu = se.to_warehouse || "Unknown CSU";
		const farm = deriveFarm(gh);
		if (!farm) return;

		if (!farmMap[farm]) farmMap[farm] = {};
		if (!farmMap[farm][csu]) farmMap[farm][csu] = {};
		if (!farmMap[farm][csu][gh]) farmMap[farm][csu][gh] = [];

		farmMap[farm][csu][gh].push({
			seName: se.name,
			fromWarehouse: se.from_warehouse || "",
			toWarehouse: se.to_warehouse || "",
			rowDate: se.creation || "",
			sprayType: wo.custom_spray_type || "",
			workOrder: se.work_order,
			greenhouse: gh,
		});
	});

	return farmMap;
}

// ═══════════════════════════════════════════════════════════════════
//  SCREEN 1 — Farm Picker
// ═══════════════════════════════════════════════════════════════════

async function openFarmPickerScreen() {
	frappe.show_progress("Loading", 20, 100, "Fetching spray plan data…");

	let draftData, submittedData;
	try {
		[draftData, submittedData] = await Promise.all([
			loadSprayPlanData(0),
			loadSprayPlanData(1),
		]);
	} catch (e) {
		frappe.hide_progress();
		frappe.msgprint("Failed to load data: " + (e.message || e));
		return;
	}
	frappe.hide_progress();

	const draftFarmMap = buildFarmMap(draftData.seList, draftData.woMap);
	const submittedFarmMap = buildFarmMap(submittedData.seList, submittedData.woMap);

	const overlay = buildOverlay();
	const modal = buildModal();
	overlay.appendChild(modal);
	document.body.appendChild(overlay);
	overlay.addEventListener("click", (e) => {
		if (e.target === overlay) overlay.remove();
	});
	modal.appendChild(buildHeader("Spray Plan Transfers", () => overlay.remove()));

	const body = document.createElement("div");
	body.className = "sp-body";
	modal.appendChild(body);

	// ── Section: Print Labels (submitted SEs) ───────────────
	const docSection = document.createElement("div");
	docSection.className = "sk-picker-section";
	docSection.innerHTML = `
        <div class="sk-picker-section-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
                <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="3" height="3"/>
            </svg>
            <span>Print Labels — Submitted Transfers</span>
        </div>
        <p class="sk-picker-desc">Select a farm to generate QR labels for the Zebra ZQ520 thermal printer.</p>
    `;

	const submittedFarms = Object.keys(submittedFarmMap).sort();

	if (!submittedFarms.length) {
		docSection.appendChild(buildEmptyRow("No submitted spray plan transfers found."));
	} else {
		const farmGrid = document.createElement("div");
		farmGrid.className = "sp-farm-grid";

		submittedFarms.forEach((farm) => {
			const allSes = Object.values(submittedFarmMap[farm]).flatMap((csuMap) =>
				Object.values(csuMap).flat(),
			);
			const seCount = allSes.length;
			const btn = document.createElement("button");
			btn.className = "sp-farm-btn";
			btn.innerHTML = `
                <span class="sp-farm-btn-name">${escapeHtml(farm)}</span>
                <span class="sp-farm-btn-meta">${seCount} transfer${seCount !== 1 ? "s" : ""}</span>`;
			btn.addEventListener("click", () => {
				overlay.remove();
				openLabelPickerModal(farm, submittedFarmMap[farm]);
			});
			farmGrid.appendChild(btn);
		});

		docSection.appendChild(farmGrid);
	}
	body.appendChild(docSection);

	// ── Divider ──────────────────────────────────────────────
	const divider = document.createElement("div");
	divider.className = "sk-picker-divider";
	body.appendChild(divider);

	// ── Section: Draft Farm Picker (submit flow) ─────────────
	const draftSection = document.createElement("div");
	draftSection.className = "sk-picker-section";
	draftSection.innerHTML = `
        <div class="sk-picker-section-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
            </svg>
            <span>Submit Transfers — Drafts Awaiting Submission</span>
        </div>
        <p class="sk-picker-desc">Select a farm to review and submit its pending chemical transfers.</p>
    `;

	const draftFarms = Object.keys(draftFarmMap).sort();

	if (!draftFarms.length) {
		draftSection.appendChild(buildEmptyRow("No pending draft spray plan transfers found."));
	} else {
		const draftFarmGrid = document.createElement("div");
		draftFarmGrid.className = "sp-farm-grid";

		draftFarms.forEach((farm) => {
			const seCount = draftData.seList.filter((se) => {
				const gh = draftData.woMap[se.work_order]?.custom_greenhouse || "";
				return deriveFarm(gh) === farm;
			}).length;
			const btn = document.createElement("button");
			btn.className = "sp-farm-btn";
			btn.innerHTML = `
                <span class="sp-farm-btn-name">${escapeHtml(farm)}</span>
                <span class="sp-farm-btn-meta">${seCount} pending</span>`;
			btn.addEventListener("click", async () => {
				overlay.remove();
				const farmSeNames = draftData.seList
					.filter(
						(se) =>
							deriveFarm(draftData.woMap[se.work_order]?.custom_greenhouse || "") ===
							farm,
					)
					.map((se) => se.name);
				await openSkTransferModal(farm, farmSeNames, draftData.woMap);
			});
			draftFarmGrid.appendChild(btn);
		});

		draftSection.appendChild(draftFarmGrid);
	}
	body.appendChild(draftSection);
}

function buildEmptyRow(text) {
	const empty = document.createElement("div");
	empty.className = "sp-empty";
	empty.textContent = text;
	return empty;
}

// ═══════════════════════════════════════════════════════════════════
//  DATE RANGE HELPERS
// ═══════════════════════════════════════════════════════════════════

function isoDay(scheduledStr) {
	return (scheduledStr || "").split(" ")[0];
}

function inDateRange(scheduledStr, fromIso, toIso) {
	const day = isoDay(scheduledStr);
	if (!day) return !fromIso && !toIso;
	if (fromIso && day < fromIso) return false;
	if (toIso && day > toIso) return false;
	return true;
}

function buildDateRangeBar({ onChange, defaultFrom = "", defaultTo = "", extraHTML = "" }) {
	const bar = document.createElement("div");
	bar.className = "sp-filter-bar";
	bar.innerHTML = `
        <div class="sp-filter-field">
            <label>From date</label>
            <input type="date" data-role="from" value="${defaultFrom}">
        </div>
        <div class="sp-filter-field">
            <label>To date</label>
            <input type="date" data-role="to" value="${defaultTo}">
        </div>
        ${extraHTML}
        <button data-role="clear" class="sp-btn sp-btn-ghost">Show All</button>
    `;

	const fromInput = bar.querySelector('[data-role="from"]');
	const toInput = bar.querySelector('[data-role="to"]');
	const clearBtn = bar.querySelector('[data-role="clear"]');

	const fire = () => {
		let from = fromInput.value;
		let to = toInput.value;
		// Auto-swap if user picked an inverted range
		if (from && to && from > to) [from, to] = [to, from];
		onChange(from, to);
	};

	fromInput.addEventListener("change", fire);
	toInput.addEventListener("change", fire);
	clearBtn.addEventListener("click", () => {
		fromInput.value = "";
		toInput.value = "";
		onChange("", "");
	});

	return { bar, fromInput, toInput };
}

// ═══════════════════════════════════════════════════════════════════
//  LABEL PICKER MODAL  — choose SEs to generate labels for
// ═══════════════════════════════════════════════════════════════════

function openLabelPickerModal(farm, farmCsuMap) {
	const overlay = buildOverlay();
	const modal = buildModal();
	overlay.appendChild(modal);
	document.body.appendChild(overlay);
	overlay.addEventListener("click", (e) => {
		if (e.target === overlay) overlay.remove();
	});
	modal.appendChild(buildHeader(`Print Labels — ${farm}`, () => overlay.remove()));

	const body = document.createElement("div");
	body.className = "sp-body";
	modal.appendChild(body);

	// ── Filter bar: date range + labels-per-page ────────────
	const extra = `
        <div class="sp-filter-field">
            <label>Labels per page</label>
            <select data-role="per-page">
                <option value="1">1 label (4" × 6")</option>
                <option value="2" selected>2 labels (4" × 3" each)</option>
                <option value="3">3 labels (4" × 2" each)</option>
            </select>
        </div>`;

	const { bar: filterBar } = buildDateRangeBar({
		onChange: (from, to) => applyDateFilter(from, to),
		extraHTML: extra,
	});
	body.appendChild(filterBar);

	const perPageSel = filterBar.querySelector('[data-role="per-page"]');

	// ── Selection state ──────────────────────────────────────
	const selectionMap = {};
	const itemByName = {};

	// ── Render CSU → GH tree with checkboxes ────────────────
	const sortedCsus = Object.keys(farmCsuMap).sort();
	const cardContainer = document.createElement("div");
	body.appendChild(cardContainer);

	const allItemRows = [];

	sortedCsus.forEach((csu) => {
		const csuBlock = document.createElement("div");
		csuBlock.className = "sk-tree-csu";
		csuBlock.dataset.csu = csu;

		const csuHeader = document.createElement("div");
		csuHeader.className = "sk-tree-csu-header";

		const csuCb = document.createElement("input");
		csuCb.type = "checkbox";
		csuCb.className = "sk-tree-cb";
		csuCb.title = "Select all in this CSU";

		const csuLabel = document.createElement("span");
		csuLabel.className = "sk-tree-csu-label";
		csuLabel.textContent = csu;

		const csuMeta = document.createElement("span");
		csuMeta.className = "sk-tree-meta";

		csuHeader.appendChild(csuCb);
		csuHeader.appendChild(csuLabel);
		csuHeader.appendChild(csuMeta);
		csuBlock.appendChild(csuHeader);

		const sortedGhs = Object.keys(farmCsuMap[csu]).sort();
		const csuCbs = [];

		sortedGhs.forEach((gh) => {
			const ghBlock = document.createElement("div");
			ghBlock.className = "sk-tree-gh";
			ghBlock.dataset.gh = gh;

			const ghHeader = document.createElement("div");
			ghHeader.className = "sk-tree-gh-header";

			const ghCb = document.createElement("input");
			ghCb.type = "checkbox";
			ghCb.className = "sk-tree-cb";

			const ghLabel = document.createElement("span");
			ghLabel.className = "sk-tree-gh-label";
			ghLabel.textContent = gh;

			const ghMeta = document.createElement("span");
			ghMeta.className = "sk-tree-meta";

			ghHeader.appendChild(ghCb);
			ghHeader.appendChild(ghLabel);
			ghHeader.appendChild(ghMeta);
			ghBlock.appendChild(ghHeader);

			const ghCbs = [];
			const items = farmCsuMap[csu][gh];

			items.forEach((item) => {
				selectionMap[item.seName] = false;
				itemByName[item.seName] = { ...item, farm, csu };

				const row = document.createElement("div");
				row.className = "sk-tree-row";
				row.dataset.date = isoDay(item.rowDate);

				const cb = document.createElement("input");
				cb.type = "checkbox";
				cb.className = "sk-tree-cb sk-se-cb";
				cb.dataset.se = item.seName;

				const seLink = document.createElement("a");
				seLink.href = `/app/stock-entry/${item.seName}`;
				seLink.target = "_blank";
				seLink.className = "sk-tree-se-link";
				seLink.textContent = item.seName;

				const schedBadge = document.createElement("span");
				schedBadge.className = "sk-badge";
				schedBadge.textContent = isoDay(item.rowDate) || "—";

				const typeBadge = document.createElement("span");
				typeBadge.className = "sk-badge sk-badge-outline";
				typeBadge.textContent = item.sprayType || "";

				row.appendChild(cb);
				row.appendChild(seLink);
				row.appendChild(schedBadge);
				if (item.sprayType) row.appendChild(typeBadge);
				ghBlock.appendChild(row);

				ghCbs.push(cb);
				csuCbs.push(cb);

				allItemRows.push({
					el: row,
					seName: item.seName,
					rowDate: item.rowDate || "",
				});

				cb.addEventListener("change", () => {
					selectionMap[item.seName] = cb.checked;
					syncParentCb(ghCb, ghCbs);
					syncParentCb(csuCb, csuCbs);
					updateFooter();
				});
			});

			ghCb.addEventListener("change", () => {
				ghCbs.forEach((c) => {
					if (c.closest(".sk-tree-row").style.display !== "none") {
						c.checked = ghCb.checked;
						selectionMap[c.dataset.se] = ghCb.checked;
					}
				});
				ghCb.indeterminate = false;
				syncParentCb(csuCb, csuCbs);
				updateFooter();
			});

			ghHeader.style.cursor = "pointer";
			ghHeader.addEventListener("click", (e) => {
				if (e.target === ghCb) return;
				ghCb.checked = !ghCb.checked;
				ghCb.dispatchEvent(new Event("change"));
			});

			csuBlock.appendChild(ghBlock);
			ghMeta.textContent = `${items.length} SE${items.length !== 1 ? "s" : ""}`;
		});

		csuCb.addEventListener("change", () => {
			csuCbs.forEach((c) => {
				if (c.closest(".sk-tree-row").style.display !== "none") {
					c.checked = csuCb.checked;
					selectionMap[c.dataset.se] = csuCb.checked;
				}
			});
			csuCb.indeterminate = false;

			csuBlock.querySelectorAll(".sk-tree-gh-header input").forEach((ghCb) => {
				const ghBlock = ghCb.closest(".sk-tree-gh");
				const visibleCbs = [...ghBlock.querySelectorAll(".sk-se-cb")].filter(
					(c) => c.closest(".sk-tree-row").style.display !== "none",
				);
				syncParentCb(ghCb, visibleCbs);
			});
			updateFooter();
		});

		csuHeader.style.cursor = "pointer";
		csuHeader.addEventListener("click", (e) => {
			if (e.target === csuCb) return;
			csuCb.checked = !csuCb.checked;
			csuCb.dispatchEvent(new Event("change"));
		});

		const totalInCsu = Object.values(farmCsuMap[csu]).flat().length;
		csuMeta.textContent = `${Object.keys(farmCsuMap[csu]).length} GH · ${totalInCsu} SEs`;

		cardContainer.appendChild(csuBlock);
	});

	function applyDateFilter(fromIso, toIso) {
		allItemRows.forEach(({ el }) => {
			const day = el.dataset.date;
			const visible = inDateRange(day, fromIso, toIso);
			el.style.display = visible ? "flex" : "none";
			if (!visible) {
				const cb = el.querySelector("input[type=checkbox]");
				if (cb && cb.checked) {
					cb.checked = false;
					selectionMap[cb.dataset.se] = false;
				}
			}
		});

		cardContainer.querySelectorAll(".sk-tree-gh-header input").forEach((ghCb) => {
			const ghBlock = ghCb.closest(".sk-tree-gh");
			const visibleCbs = [...ghBlock.querySelectorAll(".sk-se-cb")].filter(
				(c) => c.closest(".sk-tree-row").style.display !== "none",
			);
			syncParentCb(ghCb, visibleCbs);
		});

		cardContainer.querySelectorAll(".sk-tree-csu-header input").forEach((csuCb) => {
			const csuBlock = csuCb.closest(".sk-tree-csu");
			const visibleCbs = [...csuBlock.querySelectorAll(".sk-se-cb")].filter(
				(c) => c.closest(".sk-tree-row").style.display !== "none",
			);
			syncParentCb(csuCb, visibleCbs);
		});

		updateFooter();
	}

	const footer = document.createElement("div");
	footer.className = "sp-footer";
	modal.appendChild(footer);

	const footerInfo = document.createElement("div");
	footerInfo.className = "sp-footer-info";
	footer.appendChild(footerInfo);

	const footerBtns = document.createElement("div");
	footerBtns.className = "sp-footer-btns";

	const btnCancel = document.createElement("button");
	btnCancel.className = "sp-btn sp-btn-ghost";
	btnCancel.textContent = "Cancel";
	btnCancel.addEventListener("click", () => overlay.remove());

	const btnSelectAll = document.createElement("button");
	btnSelectAll.className = "sp-btn sp-btn-ghost";
	btnSelectAll.textContent = "Select All";
	btnSelectAll.addEventListener("click", () => {
		allItemRows.forEach(({ el, seName }) => {
			if (el.style.display !== "none") {
				const cb = el.querySelector("input");
				cb.checked = true;
				selectionMap[seName] = true;
			}
		});

		cardContainer.querySelectorAll(".sk-tree-cb").forEach((c) => {
			if (c.closest(".sk-tree-row, .sk-tree-gh, .sk-tree-csu")?.style.display !== "none") {
				c.checked = true;
				c.indeterminate = false;
			}
		});

		updateFooter();
	});

	const btnPrint = document.createElement("button");
	btnPrint.className = "sp-btn sp-btn-primary";
	btnPrint.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 6 2 18 2 18 9"/>
            <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
            <rect x="6" y="14" width="12" height="8"/>
        </svg>
        <span>Generate Labels</span>`;
	btnPrint.disabled = true;
	btnPrint.addEventListener("click", async () => {
		const selectedSes = Object.entries(selectionMap)
			.filter(([, v]) => v)
			.map(([k]) => k);
		if (!selectedSes.length) return;

		const perPage = parseInt(perPageSel.value, 10) || 2;
		const selectedItems = selectedSes.map((n) => itemByName[n]);

		overlay.remove();
		await generateLabels(farm, selectedItems, perPage);
	});

	footerBtns.append(btnCancel, btnSelectAll, btnPrint);
	footer.append(footerInfo, footerBtns);

	function updateFooter() {
		const count = Object.values(selectionMap).filter(Boolean).length;
		footerInfo.innerHTML = `<strong>${count}</strong> of <strong>${Object.keys(selectionMap).length}</strong> selected`;
		btnPrint.disabled = count === 0;
	}

	updateFooter();
}

// ═══════════════════════════════════════════════════════════════════
//  LABEL GENERATOR — server-side PDF from attached SE images
// ═══════════════════════════════════════════════════════════════════

async function generateLabels(farm, selectedItems, perPage) {
	const seNames = selectedItems.map((i) => i.seName);
	frappe.show_progress("Generating Labels", 30, 100, "Building label PDF…");

	let res;
	try {
		res = await frappe.call({
			method: "upande_scp.serverscripts.spray_plan_labels.generate_pdf",
			args: { se_names: JSON.stringify(seNames), per_page: perPage },
		});
	} catch (err) {
		frappe.hide_progress();
		console.error("Label generation error:", err);
		frappe.msgprint({
			title: "Error Generating Labels",
			message: `Failed: ${err.message || err}`,
			indicator: "red",
		});
		return;
	}

	frappe.hide_progress();

	const payload = res?.message || {};
	const { data, filename, label_count, skipped } = payload;

	if (!data || !label_count) {
		const skippedMsg = (skipped || [])
			.map((s) => `<li>${escapeHtml(s.se)} — ${escapeHtml(s.reason)}</li>`)
			.join("");
		frappe.msgprint({
			title: "No labels generated",
			message: skippedMsg
				? `<p>No labels were produced for the selected entries:</p><ul>${skippedMsg}</ul>`
				: "No image attachments found on the selected stock entries.",
			indicator: "orange",
		});
		return;
	}

	const byteChars = atob(data);
	const bytes = new Uint8Array(byteChars.length);
	for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
	const blob = new Blob([bytes], { type: "application/pdf" });
	const url = URL.createObjectURL(blob);

	const safeFarm = farm.replace(/[^a-z0-9]+/gi, "_");
	const a = document.createElement("a");
	a.href = url;
	a.download = filename || `${safeFarm}_spray_labels.pdf`;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);

	const skippedCount = (skipped || []).length;
	const suffix = skippedCount ? ` · ${skippedCount} SE${skippedCount !== 1 ? "s" : ""} skipped (no image)` : "";
	frappe.show_alert({
		message: `${label_count} label${label_count !== 1 ? "s" : ""} generated (${perPage} per page)${suffix}.`,
		indicator: skippedCount ? "orange" : "green",
	});
}


// ═══════════════════════════════════════════════════════════════════
//  DRAFT TRANSFER MODAL  (submit flow with date-range filter)
// ═══════════════════════════════════════════════════════════════════

async function openSkTransferModal(farm, seNames, woMap) {
	const overlay = buildOverlay();
	const modal = buildModal();
	overlay.appendChild(modal);
	document.body.appendChild(overlay);
	overlay.addEventListener("click", (e) => {
		if (e.target === overlay) overlay.remove();
	});
	modal.appendChild(buildHeader(`Submit Transfers — ${farm}`, () => overlay.remove()));

	const body = document.createElement("div");
	body.className = "sp-body";
	body.innerHTML = `<div class="sp-loading">Loading transfer details…</div>`;
	modal.appendChild(body);

	let stockEntries;
	try {
		stockEntries = await Promise.all(seNames.map((n) => frappe.db.get_doc("Stock Entry", n)));
	} catch (e) {
		body.innerHTML = `<div class="sp-error">Failed to load: ${escapeHtml(e.message || e)}</div>`;
		return;
	}
	body.innerHTML = "";

	// ── Date range filter ──────────────────────────────
	const { bar: filterBar } = buildDateRangeBar({
		onChange: (from, to) => filterByDateRange(from, to),
	});
	body.appendChild(filterBar);

	// ── Chemical totals card (recomputed on filter change) ──
	const summaryCard = document.createElement("div");
	summaryCard.className = "sk-summary-card";

	const summaryTitle = document.createElement("div");
	summaryTitle.className = "sk-summary-title";
	summaryCard.appendChild(summaryTitle);

	const summaryRange = document.createElement("div");
	summaryRange.className = "sk-summary-range";
	summaryCard.appendChild(summaryRange);

	const tilesWrap = document.createElement("div");
	tilesWrap.className = "sk-chem-tiles";
	summaryCard.appendChild(tilesWrap);

	body.appendChild(summaryCard);

	const divider = document.createElement("div");
	divider.className = "sk-divider";
	divider.textContent = "Select transfers to submit";
	body.appendChild(divider);

	// ── Group by greenhouse, render cards ──
	const byGH = {};
	stockEntries.forEach((se) => {
		const wo = woMap[se.work_order] || {};
		const gh = wo.custom_greenhouse || "Unknown";
		const rowDate = se.creation || "";
		if (!byGH[gh]) byGH[gh] = [];
		byGH[gh].push({ se, rowDate });
	});

	const allSections = {};
	const checkboxMap = {};

	Object.keys(byGH)
		.sort()
		.forEach((gh) => {
			const items = byGH[gh];
			const section = document.createElement("div");
			section.className = "sp-gh-section";
			allSections[gh] = section;

			const ghHeader = document.createElement("div");
			ghHeader.className = "sp-gh-header";
			const ghCheck = document.createElement("input");
			ghCheck.type = "checkbox";
			const ghName = document.createElement("span");
			ghName.className = "sp-gh-name";
			ghName.textContent = gh;
			const ghMeta = document.createElement("span");
			ghMeta.className = "sp-gh-meta";
			ghMeta.textContent = `${items.length} transfer${items.length !== 1 ? "s" : ""}`;
			ghHeader.append(ghCheck, ghName, ghMeta);
			section.appendChild(ghHeader);

			const ghCheckboxes = [];
			items.forEach(({ se, rowDate }) => {
				const cb = document.createElement("input");
				cb.type = "checkbox";
				cb.dataset.se = se.name;
				checkboxMap[se.name] = cb;
				ghCheckboxes.push(cb);
				cb.addEventListener("change", () => {
					syncGhCheckbox(ghCheck, ghCheckboxes);
					updateFooter();
				});
				section.appendChild(buildSeCard(se, cb, woMap[se.work_order], rowDate));
			});

			ghCheck.addEventListener("change", () => {
				ghCheckboxes.forEach((c) => {
					if (c.closest(".sp-wo-card")?.style.display !== "none")
						c.checked = ghCheck.checked;
				});
				ghCheck.indeterminate = false;
				updateFooter();
			});

			ghHeader.addEventListener("click", (e) => {
				if (e.target === ghCheck) return;
				ghCheck.checked = !ghCheck.checked;
				ghCheck.dispatchEvent(new Event("change"));
			});

			body.appendChild(section);
		});

	function isSeInRange(seName, fromIso, toIso) {
		const se = stockEntries.find((s) => s.name === seName);
		return inDateRange(se?.creation || "", fromIso, toIso);
	}

	function filterByDateRange(fromIso, toIso) {
		Object.keys(allSections).forEach((gh) => {
			const hasMatch = byGH[gh]?.some(({ rowDate }) =>
				inDateRange(rowDate, fromIso, toIso),
			);
			allSections[gh].style.display = hasMatch ? "block" : "none";
		});

		Object.keys(checkboxMap).forEach((seName) => {
			const card = checkboxMap[seName].closest(".sp-wo-card");
			if (!card) return;
			const visible = isSeInRange(seName, fromIso, toIso);
			card.style.display = visible ? "block" : "none";
			if (!visible && checkboxMap[seName].checked) {
				checkboxMap[seName].checked = false;
			}
		});

		// Resync GH parent checkboxes
		body.querySelectorAll(".sp-gh-section").forEach((section) => {
			const ghCb = section.querySelector(".sp-gh-header input[type=checkbox]");
			if (!ghCb) return;
			const childCbs = [...section.querySelectorAll(".sp-wo-card input[type=checkbox]")];
			syncGhCheckbox(
				ghCb,
				childCbs.filter((c) => c.closest(".sp-wo-card")?.style.display !== "none"),
			);
		});

		renderChemicalTotals(fromIso, toIso);
		updateFooter();
	}

	function renderChemicalTotals(fromIso, toIso) {
		const visibleSes = stockEntries.filter((se) =>
			inDateRange(se.creation || "", fromIso, toIso),
		);

		const chemTotals = {};
		visibleSes.forEach((se) => {
			const gh = woMap[se.work_order]?.custom_greenhouse || "Unknown";
			(se.items || []).forEach((item) => {
				const k = item.item_code;
				if (!chemTotals[k])
					chemTotals[k] = {
						name: item.item_name || k,
						uom: item.stock_uom,
						total: 0,
						byGH: {},
					};
				chemTotals[k].total += parseFloat(item.qty) || 0;
				chemTotals[k].byGH[gh] = (chemTotals[k].byGH[gh] || 0) + (parseFloat(item.qty) || 0);
			});
		});
		const sortedChems = Object.values(chemTotals).sort((a, b) => a.name.localeCompare(b.name));

		summaryTitle.textContent = `Chemical levels required — ${visibleSes.length} transfer${visibleSes.length !== 1 ? "s" : ""}, ${sortedChems.length} chemical${sortedChems.length !== 1 ? "s" : ""}`;

		if (fromIso || toIso) {
			const label = `${fromIso || "earliest"} → ${toIso || "latest"}`;
			summaryRange.textContent = `Date range: ${label}`;
			summaryRange.style.display = "block";
		} else {
			summaryRange.style.display = "none";
		}

		tilesWrap.innerHTML = "";
		if (!sortedChems.length) {
			const empty = document.createElement("div");
			empty.className = "sk-chem-empty";
			empty.textContent = "No transfers match the selected date range.";
			tilesWrap.appendChild(empty);
			return;
		}

		sortedChems.forEach((chem) => {
			const tile = document.createElement("div");
			tile.className = "sk-chem-tile";
			tile.innerHTML = `
                <div class="sk-chem-tile-name">${escapeHtml(chem.name)}</div>
                <div class="sk-chem-tile-total">
                    <span class="sk-chem-tile-qty">${fmtQty(chem.total)}</span>
                    <span class="sk-chem-tile-uom">${escapeHtml(chem.uom || "")}</span>
                </div>`;
			const breakdown = document.createElement("div");
			breakdown.className = "sk-chem-breakdown";
			Object.entries(chem.byGH)
				.sort()
				.forEach(([gh, qty]) => {
					const ghShort = gh.replace(/^.+?\s+(GH\s*\d+).*$/i, "$1") || gh;
					const row = document.createElement("div");
					row.className = "sk-chem-breakdown-row";
					row.innerHTML = `<span>${escapeHtml(ghShort)}</span><span>${fmtQty(qty)} ${escapeHtml(chem.uom || "")}</span>`;
					breakdown.appendChild(row);
				});
			tile.appendChild(breakdown);
			tilesWrap.appendChild(tile);
		});
	}

	const footer = document.createElement("div");
	footer.className = "sp-footer";
	modal.appendChild(footer);

	const footerInfo = document.createElement("div");
	footerInfo.className = "sp-footer-info";
	footerInfo.id = "sk-footer-info";

	const btnWrap = document.createElement("div");
	btnWrap.className = "sp-footer-btns";

	const btnCancel = document.createElement("button");
	btnCancel.className = "sp-btn sp-btn-ghost";
	btnCancel.textContent = "Cancel";
	btnCancel.addEventListener("click", () => overlay.remove());

	const btnSelectAll = document.createElement("button");
	btnSelectAll.className = "sp-btn sp-btn-ghost";
	btnSelectAll.textContent = "Select All";
	btnSelectAll.addEventListener("click", () => {
		Object.values(checkboxMap).forEach((cb) => {
			if (cb.closest(".sp-wo-card")?.style.display !== "none") cb.checked = true;
		});
		body.querySelectorAll(".sp-gh-header input[type=checkbox]").forEach((c) => {
			if (c.closest(".sp-gh-section")?.style.display !== "none") {
				c.checked = true;
				c.indeterminate = false;
			}
		});
		updateFooter();
	});

	const btnSubmit = document.createElement("button");
	btnSubmit.className = "sp-btn sp-btn-primary";
	btnSubmit.textContent = "Submit Selected";
	btnSubmit.disabled = true;
	btnSubmit.id = "sk-submit-btn";
	btnSubmit.addEventListener("click", () => {
		const selected = Object.entries(checkboxMap)
			.filter(([, cb]) => cb.checked && cb.closest(".sp-wo-card")?.style.display !== "none")
			.map(([n]) => n);
		if (selected.length) runSubmissions(selected, modal, footer, woMap);
	});

	btnWrap.append(btnCancel, btnSelectAll, btnSubmit);
	footer.append(footerInfo, btnWrap);

	function updateFooter() {
		const count = Object.entries(checkboxMap).filter(
			([, cb]) => cb.checked && cb.closest(".sp-wo-card")?.style.display !== "none",
		).length;
		const visible = Object.values(checkboxMap).filter(
			(cb) => cb.closest(".sp-wo-card")?.style.display !== "none",
		).length;
		document.getElementById("sk-footer-info").innerHTML =
			`<strong>${count}</strong> of <strong>${visible}</strong> selected (${stockEntries.length} total)`;
		const btn = document.getElementById("sk-submit-btn");
		if (btn) btn.disabled = count === 0;
	}

	// Initial render — no filter
	renderChemicalTotals("", "");
	updateFooter();
}

// ═══════════════════════════════════════════════════════════════════
//  SE Card builder
// ═══════════════════════════════════════════════════════════════════

function buildSeCard(se, checkbox, wo, rowDate) {
	wo = wo || {};
	const day = isoDay(rowDate || se.creation || "") || "—";
	const timeOnly = (rowDate || se.creation || "").split(" ")[1] || "";
	const chemicals = (se.items || []).map((item) => ({
		name: item.item_name || item.item_code,
		code: item.item_code,
		qty: item.qty,
		uom: item.stock_uom,
		from: item.s_warehouse,
		to: item.t_warehouse,
	}));

	const card = document.createElement("div");
	card.className = "sp-wo-card";

	const cardHead = document.createElement("div");
	cardHead.className = "sp-wo-card-head";

	// Build the label with proper DOM nodes — innerHTML += would destroy
	// the checkbox node and break its change listener.
	const cbWrap = document.createElement("label");
	cbWrap.className = "sp-wo-card-cb";
	cbWrap.appendChild(checkbox);

	const meta = document.createElement("span");
	meta.className = "sp-wo-card-meta";

	const top = document.createElement("span");
	top.className = "sp-wo-card-top";
	const seLink = document.createElement("a");
	seLink.href = `/app/stock-entry/${se.name}`;
	seLink.target = "_blank";
	seLink.className = "sp-wo-link";
	seLink.textContent = se.name;
	top.appendChild(seLink);
	if (wo.custom_spray_type) {
		const typeBadge = document.createElement("span");
		typeBadge.className = "sk-badge sk-badge-outline";
		typeBadge.textContent = wo.custom_spray_type;
		top.appendChild(typeBadge);
	}
	meta.appendChild(top);

	const sub = document.createElement("span");
	sub.className = "sp-wo-card-sub";
	sub.append("WO: ");
	const woLink = document.createElement("a");
	woLink.href = `/app/work-order/${se.work_order}`;
	woLink.target = "_blank";
	woLink.className = "sp-wo-sublink";
	woLink.textContent = se.work_order;
	sub.appendChild(woLink);
	meta.appendChild(sub);

	cbWrap.appendChild(meta);

	const rightMeta = document.createElement("div");
	rightMeta.className = "sp-wo-card-right";
	const schedBadge = document.createElement("span");
	schedBadge.className = "sk-badge";
	schedBadge.textContent = day;
	rightMeta.appendChild(schedBadge);
	if (timeOnly) {
		const tb = document.createElement("span");
		tb.className = "sp-wo-time";
		tb.textContent = timeOnly.slice(0, 5);
		rightMeta.appendChild(tb);
	}

	cardHead.appendChild(cbWrap);
	cardHead.appendChild(rightMeta);
	card.appendChild(cardHead);

	if (chemicals.length) {
		const whRow = document.createElement("div");
		whRow.className = "sp-wo-wh-row";
		whRow.innerHTML = `
            <span>From: <strong>${escapeHtml(chemicals[0].from || "—")}</strong></span>
            <span>To: <strong>${escapeHtml(chemicals[0].to || "—")}</strong></span>`;
		card.appendChild(whRow);
	}

	const chemWrap = document.createElement("div");
	chemWrap.className = "sp-wo-section";
	const tbl = document.createElement("table");
	tbl.className = "sp-chem-table";
	tbl.innerHTML = `<thead><tr><th>Chemical</th><th>Item Code</th><th class="sp-num">Qty</th><th>UoM</th></tr></thead>`;
	const tbody = document.createElement("tbody");
	chemicals.forEach((c) => {
		const tr = document.createElement("tr");
		tr.innerHTML = `
            <td class="sp-strong">${escapeHtml(c.name)}</td>
            <td class="sp-muted">${escapeHtml(c.code)}</td>
            <td class="sp-num sp-strong">${fmtQty(c.qty)}</td>
            <td>${escapeHtml(c.uom)}</td>`;
		tbody.appendChild(tr);
	});
	tbl.appendChild(tbody);
	chemWrap.appendChild(tbl);
	card.appendChild(chemWrap);
	return card;
}

// ═══════════════════════════════════════════════════════════════════
//  BULK SUBMIT
// ═══════════════════════════════════════════════════════════════════

async function runSubmissions(seNames, modal, footer, woMap) {
	footer.innerHTML = "";
	footer.classList.add("sp-footer-progress");

	const title = document.createElement("div");
	title.className = "sp-progress-title";
	title.textContent = `Submitting ${seNames.length} transfer${seNames.length !== 1 ? "s" : ""}…`;
	footer.appendChild(title);

	const progressWrap = document.createElement("div");
	progressWrap.className = "sp-progress-wrap";
	const progressBar = document.createElement("div");
	progressBar.className = "sp-progress-bar";
	progressBar.style.width = "0%";
	progressWrap.appendChild(progressBar);
	footer.appendChild(progressWrap);

	const log = document.createElement("div");
	log.className = "sp-status-log";
	footer.appendChild(log);

	const closeBtn = document.createElement("button");
	closeBtn.className = "sp-btn sp-btn-ghost sp-progress-close";
	closeBtn.textContent = "Close";
	closeBtn.addEventListener("click", () => {
		modal.closest(".sp-overlay").remove();
		if (typeof cur_list !== "undefined" && cur_list) cur_list.refresh();
	});
	footer.appendChild(closeBtn);

	const addLog = (html, cls = "") => {
		const line = document.createElement("div");
		if (cls) line.className = cls;
		line.innerHTML = html;
		log.appendChild(line);
		log.scrollTop = log.scrollHeight;
	};

	let done = 0,
		errors = 0;
	for (const seName of seNames) {
		try {
			const se = await frappe.db.get_doc("Stock Entry", seName);
			if (se.docstatus !== 0) {
				addLog(
					`⚠ <strong>${escapeHtml(seName)}</strong> — skipped (already submitted)`,
					"sp-log-warn",
				);
				errors++;
				advance();
				continue;
			}
			await frappe.call({ method: "frappe.client.submit", args: { doc: se } });
			addLog(
				`✓ <strong>${escapeHtml(seName)}</strong> — submitted to <strong>${escapeHtml(se.to_warehouse || "—")}</strong>`,
				"sp-log-ok",
			);
		} catch (err) {
			addLog(
				`✗ <strong>${escapeHtml(seName)}</strong> — ${escapeHtml(err.message || String(err))}`,
				"sp-log-err",
			);
			errors++;
		}
		advance();
	}

	title.textContent = `Done — ${done - errors} submitted, ${errors} failed.`;
	title.classList.toggle("sp-progress-title-ok", errors === 0);
	title.classList.toggle("sp-progress-title-err", errors === done);
	title.classList.toggle("sp-progress-title-mix", errors > 0 && errors < done);
	closeBtn.classList.add("sp-progress-close-show");

	function advance() {
		done++;
		progressBar.style.width = `${Math.round((done / seNames.length) * 100)}%`;
	}
}

// ═══════════════════════════════════════════════════════════════════
//  SHARED UTILITIES
// ═══════════════════════════════════════════════════════════════════

function deriveFarm(greenhouse) {
	if (!greenhouse) return null;
	const match = greenhouse.match(/^(.+?)\s+GH\b/i);
	return match ? match[1].trim() : greenhouse.split(" ")[0] || null;
}

function syncParentCb(parentCb, childCbs) {
	const visible = childCbs.filter((c) => c.closest(".sk-tree-row")?.style.display !== "none");
	const checked = visible.filter((c) => c.checked).length;
	parentCb.checked = checked > 0 && checked === visible.length;
	parentCb.indeterminate = checked > 0 && checked < visible.length;
}

function syncGhCheckbox(ghCheck, ghCheckboxes) {
	const visible = ghCheckboxes.filter(
		(cb) => cb.closest(".sp-wo-card")?.style.display !== "none",
	);
	const checked = visible.filter((c) => c.checked).length;
	ghCheck.checked = checked === visible.length && visible.length > 0;
	ghCheck.indeterminate = checked > 0 && checked < visible.length;
}

function buildOverlay() {
	const el = document.createElement("div");
	el.className = "sp-overlay";
	return el;
}

function buildModal() {
	const el = document.createElement("div");
	el.className = "sp-modal";
	return el;
}

function buildHeader(title, onClose) {
	const el = document.createElement("div");
	el.className = "sp-header";
	const h3 = document.createElement("h3");
	h3.textContent = title;
	const btn = document.createElement("button");
	btn.className = "sp-close";
	btn.innerHTML = "&times;";
	btn.setAttribute("aria-label", "Close");
	btn.addEventListener("click", onClose);
	el.append(h3, btn);
	return el;
}

function fmtQty(val) {
	if (val == null) return "—";
	const n = parseFloat(val);
	return isNaN(n) ? val : n % 1 === 0 ? n.toString() : n.toFixed(3).replace(/\.?0+$/, "");
}

function shorten(str, max) {
	if (!str) return "";
	const s = String(str);
	return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function escapeHtml(str) {
	if (str == null) return "";
	return String(str)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

// ═══════════════════════════════════════════════════════════════════
//  STYLES
// ═══════════════════════════════════════════════════════════════════

function injectSkStyles() {
	if (document.getElementById("sk-transfer-styles")) return;
	const style = document.createElement("style");
	style.id = "sk-transfer-styles";
	style.textContent = `
        .sp-overlay {
            position: fixed; inset: 0;
            background: rgba(17, 24, 39, 0.45);
            backdrop-filter: blur(2px);
            display: flex; align-items: center; justify-content: center;
            z-index: 1100;
        }
        .sp-modal {
            background: #fff;
            border-radius: 10px;
            width: 94vw; max-width: 1080px; max-height: 90vh;
            display: flex; flex-direction: column;
            box-shadow: 0 16px 48px rgba(17, 24, 39, 0.18), 0 2px 6px rgba(17, 24, 39, 0.06);
            overflow: hidden;
            border: 1px solid #e5e7eb;
        }

        .sp-header {
            padding: 14px 20px;
            background: #fff;
            border-bottom: 1px solid #e5e7eb;
            display: flex; justify-content: space-between; align-items: center;
            flex-shrink: 0;
        }
        .sp-header h3 {
            margin: 0;
            font-size: 0.95rem;
            font-weight: 600;
            color: #1f272e;
            letter-spacing: -0.01em;
        }
        .sp-close {
            background: transparent; border: none;
            font-size: 22px; color: #6c7680;
            cursor: pointer;
            width: 28px; height: 28px;
            display: flex; align-items: center; justify-content: center;
            border-radius: 6px;
            transition: all 0.15s;
        }
        .sp-close:hover { background: #f4f5f6; color: #1f272e; }

        .sp-body {
            padding: 20px;
            overflow-y: auto;
            flex: 1;
            background: #fafbfc;
        }
        .sp-loading, .sp-error {
            text-align: center; padding: 40px 20px;
            color: #6c7680; font-size: 0.88rem;
        }
        .sp-error { color: #b91c1c; }
        .sp-empty {
            padding: 14px 16px; color: #8d95a0;
            font-size: 0.82rem; font-style: italic;
            text-align: center;
            background: #fff; border: 1px dashed #e5e7eb; border-radius: 8px;
        }

        .sk-picker-section { margin-bottom: 4px; }
        .sk-picker-section-title {
            display: flex; align-items: center; gap: 8px;
            font-size: 0.82rem; font-weight: 600;
            color: #1f272e;
            margin-bottom: 10px;
            padding: 0 2px;
        }
        .sk-picker-section-title svg { color: #6c7680; }
        .sk-picker-desc {
            font-size: 0.76rem;
            color: #6c7680;
            margin: 0 0 12px 0;
            padding-left: 2px;
        }
        .sk-picker-divider {
            border: none; border-top: 1px solid #e5e7eb;
            margin: 22px 0 18px 0;
        }

        .sp-farm-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
            gap: 8px;
        }
        .sp-farm-btn {
            padding: 14px 14px;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            background: #fff;
            cursor: pointer;
            text-align: left;
            display: flex; flex-direction: column; gap: 3px;
            transition: all 0.15s;
            box-shadow: 0 1px 2px rgba(17, 24, 39, 0.04);
        }
        .sp-farm-btn:hover {
            border-color: #1f272e;
            box-shadow: 0 2px 6px rgba(17, 24, 39, 0.08);
            transform: translateY(-1px);
        }
        .sp-farm-btn-name {
            font-size: 0.88rem; font-weight: 600;
            color: #1f272e;
        }
        .sp-farm-btn-meta {
            font-size: 0.72rem;
            color: #6c7680;
        }

        .sp-filter-bar {
            display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap;
            margin-bottom: 18px;
            padding: 12px 14px;
            background: #fff;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
        }
        .sp-filter-field {
            display: flex; flex-direction: column; gap: 4px;
            flex: 1; min-width: 140px;
        }
        .sp-filter-field label {
            font-size: 0.7rem;
            font-weight: 500;
            color: #6c7680;
            text-transform: uppercase;
            letter-spacing: 0.04em;
        }
        .sp-filter-field input,
        .sp-filter-field select {
            padding: 7px 10px;
            border: 1px solid #d1d5db;
            border-radius: 6px;
            font-size: 0.82rem;
            color: #1f272e;
            background: #fff;
            outline: none;
            transition: border-color 0.15s, box-shadow 0.15s;
        }
        .sp-filter-field input:focus,
        .sp-filter-field select:focus {
            border-color: #1f272e;
            box-shadow: 0 0 0 3px rgba(31, 39, 46, 0.08);
        }

        .sk-tree-csu {
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            margin-bottom: 10px;
            overflow: hidden;
            background: #fff;
        }
        .sk-tree-csu-header {
            display: flex; align-items: center; gap: 10px;
            padding: 10px 14px;
            background: #f4f5f6;
            border-bottom: 1px solid #e5e7eb;
            user-select: none;
        }
        .sk-tree-csu-label {
            font-size: 0.82rem; font-weight: 600;
            color: #1f272e;
            flex: 1;
        }
        .sk-tree-gh {
            border-top: 1px solid #f4f5f6;
        }
        .sk-tree-gh:first-of-type { border-top: none; }
        .sk-tree-gh-header {
            display: flex; align-items: center; gap: 10px;
            padding: 8px 14px 8px 22px;
            background: #fafbfc;
            user-select: none;
        }
        .sk-tree-gh-label {
            font-size: 0.78rem; font-weight: 600;
            color: #374151;
            flex: 1;
        }
        .sk-tree-row {
            display: flex; align-items: center; gap: 10px;
            padding: 7px 14px 7px 32px;
            border-top: 1px solid #f4f5f6;
            transition: background 0.1s;
        }
        .sk-tree-row:hover { background: #fafbfc; }
        .sk-tree-cb {
            width: 14px; height: 14px;
            cursor: pointer;
            accent-color: #1f272e;
            flex-shrink: 0;
        }
        .sk-tree-se-link {
            font-size: 0.78rem; font-weight: 500;
            color: #2563eb;
            text-decoration: none;
            flex: 1;
        }
        .sk-tree-se-link:hover { text-decoration: underline; }
        .sk-tree-meta {
            font-size: 0.7rem;
            color: #6c7680;
            white-space: nowrap;
        }

        .sk-badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 0.7rem;
            font-weight: 500;
            color: #374151;
            background: #f4f5f6;
            border: 1px solid #e5e7eb;
            white-space: nowrap;
        }
        .sk-badge-outline {
            background: #fff;
            color: #6c7680;
        }

        .sk-summary-card {
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            overflow: hidden;
            margin-bottom: 18px;
            background: #fff;
        }
        .sk-summary-title {
            padding: 10px 14px;
            background: #f4f5f6;
            color: #1f272e;
            font-size: 0.82rem;
            font-weight: 600;
            border-bottom: 1px solid #e5e7eb;
        }
        .sk-summary-range {
            padding: 6px 14px;
            font-size: 0.72rem;
            color: #6c7680;
            background: #fafbfc;
            border-bottom: 1px solid #e5e7eb;
            display: none;
        }
        .sk-chem-empty {
            padding: 18px 14px;
            font-size: 0.78rem;
            color: #8d95a0;
            font-style: italic;
            text-align: center;
            width: 100%;
        }
        .sk-chem-tiles {
            display: flex; flex-wrap: wrap; gap: 10px;
            padding: 12px 14px;
        }
        .sk-chem-tile {
            flex: 1; min-width: 160px; max-width: 230px;
            background: #fafbfc;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            padding: 10px 12px;
        }
        .sk-chem-tile-name {
            font-size: 0.74rem; font-weight: 600;
            color: #374151;
            margin-bottom: 4px;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .sk-chem-tile-total {
            display: flex; align-items: baseline; gap: 5px;
            margin-bottom: 8px;
        }
        .sk-chem-tile-qty {
            font-size: 1.35rem; font-weight: 700;
            color: #1f272e;
            line-height: 1;
        }
        .sk-chem-tile-uom {
            font-size: 0.72rem; font-weight: 500;
            color: #6c7680;
        }
        .sk-chem-breakdown {
            border-top: 1px solid #e5e7eb;
            padding-top: 6px;
            display: flex; flex-direction: column; gap: 3px;
        }
        .sk-chem-breakdown-row {
            display: flex; justify-content: space-between;
            font-size: 0.7rem;
            color: #6c7680;
        }
        .sk-chem-breakdown-row :last-child { color: #374151; font-weight: 500; }

        .sk-divider {
            font-size: 0.72rem; font-weight: 600;
            color: #6c7680;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            padding: 10px 0 8px;
            border-bottom: 1px solid #e5e7eb;
            margin-bottom: 14px;
        }

        .sp-gh-section { margin-bottom: 16px; }
        .sp-gh-header {
            display: flex; align-items: center; gap: 10px;
            padding: 9px 12px;
            background: #f4f5f6;
            border: 1px solid #e5e7eb;
            border-radius: 6px;
            margin-bottom: 8px;
            cursor: pointer;
            user-select: none;
        }
        .sp-gh-header input[type=checkbox] {
            width: 14px; height: 14px;
            cursor: pointer;
            accent-color: #1f272e;
            flex-shrink: 0;
        }
        .sp-gh-name {
            font-weight: 600; font-size: 0.82rem;
            color: #1f272e;
            flex: 1;
        }
        .sp-gh-meta {
            font-size: 0.72rem;
            color: #6c7680;
        }

        .sp-wo-card {
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            margin-bottom: 8px;
            overflow: hidden;
            background: #fff;
            transition: border-color 0.15s;
        }
        .sp-wo-card:hover { border-color: #d1d5db; }
        .sp-wo-card-head {
            display: flex; justify-content: space-between; align-items: center;
            padding: 10px 14px;
            background: #fafbfc;
            border-bottom: 1px solid #f4f5f6;
            gap: 12px; flex-wrap: wrap;
        }
        .sp-wo-card-cb {
            display: flex; align-items: center; gap: 10px;
            cursor: pointer;
        }
        .sp-wo-card-cb input[type=checkbox] {
            width: 14px; height: 14px;
            cursor: pointer;
            accent-color: #1f272e;
            flex-shrink: 0;
        }
        .sp-wo-card-meta {
            display: flex; flex-direction: column; gap: 2px;
        }
        .sp-wo-card-top {
            display: flex; align-items: center; gap: 8px;
        }
        .sp-wo-card-sub {
            font-size: 0.72rem; color: #6c7680;
        }
        .sp-wo-link {
            color: #2563eb;
            font-weight: 600;
            text-decoration: none;
            font-size: 0.85rem;
        }
        .sp-wo-link:hover { text-decoration: underline; }
        .sp-wo-sublink {
            color: #6c7680;
            text-decoration: none;
        }
        .sp-wo-sublink:hover { text-decoration: underline; }
        .sp-wo-card-right {
            display: flex; flex-direction: column; align-items: flex-end;
            gap: 2px; flex-shrink: 0;
        }
        .sp-wo-time {
            font-size: 0.65rem; color: #8d95a0;
        }

        .sp-wo-wh-row {
            padding: 6px 14px;
            font-size: 0.72rem;
            color: #6c7680;
            border-bottom: 1px solid #f4f5f6;
            display: flex; gap: 16px;
        }
        .sp-wo-wh-row strong { color: #374151; font-weight: 600; }

        .sp-wo-section {
            padding: 6px 14px;
        }

        .sp-chem-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.76rem;
        }
        .sp-chem-table th {
            background: #fafbfc;
            color: #6c7680;
            padding: 6px 8px;
            text-align: left;
            font-weight: 500;
            font-size: 0.68rem;
            letter-spacing: 0.03em;
            text-transform: uppercase;
            border-bottom: 1px solid #e5e7eb;
        }
        .sp-chem-table td {
            padding: 6px 8px;
            border-bottom: 1px solid #f4f5f6;
            color: #374151;
        }
        .sp-chem-table tbody tr:last-child td { border-bottom: none; }
        .sp-chem-table .sp-num { text-align: right; }
        .sp-chem-table .sp-strong { font-weight: 600; color: #1f272e; }
        .sp-chem-table .sp-muted { color: #6c7680; }

        .sp-footer {
            padding: 12px 20px;
            border-top: 1px solid #e5e7eb;
            display: flex; justify-content: space-between; align-items: center;
            background: #fff;
            flex-shrink: 0;
            gap: 12px;
        }
        .sp-footer-info {
            font-size: 0.78rem;
            color: #6c7680;
        }
        .sp-footer-info strong { color: #1f272e; font-weight: 600; }
        .sp-footer-btns {
            display: flex; gap: 8px;
        }
        .sp-footer-progress {
            flex-direction: column; align-items: stretch;
        }

        .sp-btn {
            padding: 8px 16px;
            border-radius: 6px;
            border: 1px solid transparent;
            font-weight: 500;
            font-size: 0.8rem;
            cursor: pointer;
            transition: all 0.15s;
            display: inline-flex; align-items: center; gap: 6px;
            line-height: 1.2;
        }
        .sp-btn-ghost {
            background: #fff;
            color: #374151;
            border-color: #d1d5db;
        }
        .sp-btn-ghost:hover {
            background: #f4f5f6;
            border-color: #9ca3af;
        }
        .sp-btn-primary {
            background: #1f272e;
            color: #fff;
            border-color: #1f272e;
        }
        .sp-btn-primary:hover:not(:disabled) {
            background: #0f1418;
            border-color: #0f1418;
        }
        .sp-btn-primary:disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }

        .sp-progress-title {
            font-weight: 600;
            margin-bottom: 6px;
            color: #1f272e;
            font-size: 0.85rem;
        }
        .sp-progress-title-ok  { color: #047857; }
        .sp-progress-title-err { color: #b91c1c; }
        .sp-progress-title-mix { color: #92400e; }
        .sp-progress-wrap {
            width: 100%;
            background: #e5e7eb;
            border-radius: 4px;
            height: 4px;
            overflow: hidden;
            margin: 4px 0 10px;
        }
        .sp-progress-bar {
            height: 100%;
            background: #1f272e;
            border-radius: 4px;
            transition: width 0.25s;
        }
        .sp-status-log {
            max-height: 160px;
            overflow-y: auto;
            font-size: 0.76rem;
            line-height: 1.55;
            color: #374151;
            border: 1px solid #e5e7eb;
            border-radius: 6px;
            padding: 8px 10px;
            background: #fafbfc;
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        }
        .sp-log-ok   { color: #047857; }
        .sp-log-warn { color: #92400e; }
        .sp-log-err  { color: #b91c1c; }

        .sp-progress-close {
            margin-top: 10px;
            align-self: flex-end;
            display: none;
        }
        .sp-progress-close-show { display: inline-flex; }
    `;
	document.head.appendChild(style);
}
