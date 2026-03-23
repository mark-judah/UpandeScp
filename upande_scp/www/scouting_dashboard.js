var root_element = document.getElementById("scouting-dashboard-root") || document;

if (typeof Chart === "undefined") {
	const script = document.createElement("script");
	script.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";
	script.onload = initScoutingDashboard;
	document.head.appendChild(script);
} else {
	initScoutingDashboard();
}

let pestTrendChart, pestDistChart, pestSectionChart;
let diseaseTrendChart, diseaseDistChart, diseaseStageChart;
let trapTrendChart, trapPerfChart, trapPestChart;
let pestWeeklyTrendChart, diseaseWeeklyTrendChart, trapWeeklyTrendChart;
let overviewTimelineChart, overviewDonutChart, overviewAreaRadarChart;
let scoutingData = null;
let scoutingYearData = null;
let greenhouseFilter = "";
let activeTab = "pests";
let scoutingAnalysis = null;
let observationColors = { pests: {}, diseases: {} };
var SCOUTING_DASHBOARD_DEBUG = true;
if (SCOUTING_DASHBOARD_DEBUG) {
	console.log("Scouting dashboard: script loaded", { root_element: root_element });
}

function notifyUser(message) {
	if (window.frappe && typeof window.frappe.msgprint === "function") {
		window.frappe.msgprint(message);
		return;
	}
	alert(message);
}

function isNumericId(value) {
	if (value === null || value === undefined) return false;
	return /^[0-9]+$/.test(String(value).trim());
}

function toNumber(value) {
	if (value === null || value === undefined || value === "") return 0;
	var n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

function titleCaseWords(str) {
	return String(str)
		.split(/\s+/)
		.filter(Boolean)
		.map(function (w) {
			return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
		})
		.join(" ");
}

function scoutLabelFromEmail(email) {
	if (!email) return "";
	var raw = String(email).trim();
	var local = raw.includes("@") ? raw.split("@")[0] : raw;
	var cleaned = local.replace(/[._-]+/g, " ").trim();
	var label = titleCaseWords(cleaned);
	return label || raw;
}

function getScoutIdentity(entry) {
	var owner = entry?.owner ? String(entry.owner).trim() : "";
	var modifiedBy = entry?.modified_by ? String(entry.modified_by).trim() : "";
	var explicitName =
		(entry?.scout_name ? String(entry.scout_name).trim() : "") ||
		(entry?.scout ? String(entry.scout).trim() : "");
	var named = explicitName || (entry?.scouts_name ? String(entry.scouts_name).trim() : "");

	var emailCandidate = "";
	if (owner.includes("@")) emailCandidate = owner;
	else if (modifiedBy.includes("@")) emailCandidate = modifiedBy;

	if (explicitName && !isNumericId(explicitName)) {
		return { key: explicitName, label: explicitName };
	}

	if (named) {
		if (!isNumericId(named)) return { key: named, label: named };
	}

	if (emailCandidate) {
		return { key: emailCandidate.toLowerCase(), label: scoutLabelFromEmail(emailCandidate) };
	}

	if (named && isNumericId(named)) return { key: named, label: named };

	if (modifiedBy) return { key: modifiedBy, label: modifiedBy };
	if (owner) return { key: owner, label: owner };
	return { key: "", label: "" };
}

function normalizeScoutingEntries(rawEntries) {
	var entries = Array.isArray(rawEntries) ? rawEntries : [];
	var byName = {};
	var unnamed = [];

	function ensureEntry(row) {
		var key = row?.name ? String(row.name) : "";
		if (!key) return null;
		if (!byName[key]) {
			byName[key] = {
				name: key,
				date_of_capture: row?.date_of_capture || "",
				time_of_capture: row?.time_of_capture || "",
				greenhouse: row?.greenhouse || "",
				bed: row?.bed || "",
				zone: row?.zone || "",
				owner: row?.owner || "",
				modified_by: row?.modified_by || "",
				scouts_name: row?.scouts_name || row?.scout_name || row?.scout || "",
				pests_scouting_entry: [],
				diseases_scouting_entry: [],
				trap_scouting_entry: [],
			};
		} else {
			var existing = byName[key];
			if (!existing.date_of_capture && row?.date_of_capture) existing.date_of_capture = row.date_of_capture;
			if (!existing.time_of_capture && row?.time_of_capture) existing.time_of_capture = row.time_of_capture;
			if (!existing.greenhouse && row?.greenhouse) existing.greenhouse = row.greenhouse;
			if (!existing.bed && row?.bed) existing.bed = row.bed;
			if (!existing.zone && row?.zone) existing.zone = row.zone;
			if (!existing.owner && row?.owner) existing.owner = row.owner;
			if (!existing.modified_by && row?.modified_by) existing.modified_by = row.modified_by;
			if (!existing.scouts_name && (row?.scouts_name || row?.scout_name || row?.scout)) {
				existing.scouts_name = row.scouts_name || row.scout_name || row.scout;
			}
		}
		return byName[key];
	}

	function appendObservations(target, row) {
		var pests = Array.isArray(row?.pests_scouting_entry)
			? row.pests_scouting_entry
			: Array.isArray(row?.pests)
				? row.pests
				: [];
		var diseases = Array.isArray(row?.diseases_scouting_entry)
			? row.diseases_scouting_entry
			: Array.isArray(row?.diseases)
				? row.diseases
				: [];
		var traps = Array.isArray(row?.trap_scouting_entry)
			? row.trap_scouting_entry
			: Array.isArray(row?.traps)
				? row.traps
				: [];

		pests.forEach(function (p) {
			if (!p || !(p.pest || p.pest_name)) return;
			target.pests_scouting_entry.push({
				pest: p.pest || p.pest_name,
				plant_section: p.plant_section || p.section || p.pest_plant_section,
				stage: p.stage || p.pest_stage || "",
				count: toNumber(p.count ?? p.pest_count ?? 1),
			});
		});

		diseases.forEach(function (d) {
			if (!d || !(d.disease || d.disease_name)) return;
			target.diseases_scouting_entry.push({
				disease: d.disease || d.disease_name,
				plant_section: d.plant_section || d.section || d.disease_plant_section,
				stage: d.stage || d.severity_level || d.disease_stage || "",
				severity_level: d.severity_level || d.stage || "",
			});
		});

		traps.forEach(function (t) {
			if (!t || !(t.trap || t.trap_name)) return;
			target.trap_scouting_entry.push({
				trap: t.trap || t.trap_name,
				pest: t.pest || t.trap_pest,
				location: t.location || t.plant_section || t.trap_location,
				count: toNumber(t.count ?? t.trap_count ?? 0),
			});
		});

		var flatPestName = row?.pest_pest || row?.pest;
		if (flatPestName) {
			target.pests_scouting_entry.push({
				pest: flatPestName,
				plant_section: row?.pest_plant_section || row?.plant_section || row?.predator_plant_section || "",
				stage: row?.pest_stage || row?.stage || "",
				count: toNumber(row?.pest_count ?? row?.count ?? 1),
			});
		}

		var flatDiseaseName = row?.disease_disease || row?.disease;
		if (flatDiseaseName) {
			target.diseases_scouting_entry.push({
				disease: flatDiseaseName,
				plant_section: row?.disease_plant_section || row?.plant_section || "",
				stage: row?.disease_stage || row?.stage || row?.severity_level || "",
				severity_level: row?.disease_stage || row?.severity_level || row?.stage || "",
			});
		}

		var flatTrapId = row?.trap_trap || row?.trap || row?.trap_name;
		if (flatTrapId) {
			target.trap_scouting_entry.push({
				trap: flatTrapId,
				pest: row?.trap_pest || row?.pest || "",
				location: row?.trap_location || row?.location || row?.plant_section || "",
				count: toNumber(row?.trap_count ?? row?.count ?? 0),
			});
		}
	}

	entries.forEach(function (row) {
		var target = ensureEntry(row);
		if (!target) {
			unnamed.push(row);
			return;
		}
		appendObservations(target, row);
	});

	var merged = Object.values(byName)
		.filter(function (e) {
			var hasPests = Array.isArray(e.pests_scouting_entry) && e.pests_scouting_entry.length > 0;
			var hasDiseases =
				Array.isArray(e.diseases_scouting_entry) && e.diseases_scouting_entry.length > 0;
			var hasTraps = Array.isArray(e.trap_scouting_entry) && e.trap_scouting_entry.length > 0;
			return hasPests || hasDiseases || hasTraps;
		})
		.sort(function (a, b) {
			var da = a?.date_of_capture || "";
			var db = b?.date_of_capture || "";
			if (da !== db) return db.localeCompare(da);
			var ta = a?.time_of_capture || "";
			var tb = b?.time_of_capture || "";
			return tb.localeCompare(ta);
		});

	if (unnamed.length) {
		unnamed.forEach(function (row) {
			var hasObs =
				!!(row?.pest_pest || row?.pest || row?.disease_disease || row?.disease || row?.trap_trap || row?.trap);
			if (!hasObs) return;
			var synthetic = {
				name: row?.name || row?.id || "",
				date_of_capture: row?.date_of_capture || "",
				time_of_capture: row?.time_of_capture || "",
				greenhouse: row?.greenhouse || "",
				bed: row?.bed || "",
				zone: row?.zone || "",
				owner: row?.owner || "",
				modified_by: row?.modified_by || "",
				scouts_name: row?.scouts_name || row?.scout_name || row?.scout || "",
				pests_scouting_entry: [],
				diseases_scouting_entry: [],
				trap_scouting_entry: [],
			};
			appendObservations(synthetic, row);
			merged.push(synthetic);
		});
	}

	return merged;
}

function initScoutingDashboard() {
	var weekFromInput = root_element.querySelector("#scout-week-from");
	var weekToInput = root_element.querySelector("#scout-week-to");
	var refreshBtn = root_element.querySelector("#scout-refresh-btn");
	var greenhouseSelect = root_element.querySelector("#scout-greenhouse-filter");
	var debugFetchBtn = root_element.querySelector("#scout-debug-fetch-btn");

	if (!weekFromInput || !weekToInput || !refreshBtn || !greenhouseSelect) {
		if (SCOUTING_DASHBOARD_DEBUG) {
			console.error("Scouting dashboard: missing required DOM elements", {
				weekFromInput: !!weekFromInput,
				weekToInput: !!weekToInput,
				refreshBtn: !!refreshBtn,
				greenhouseSelect: !!greenhouseSelect,
			});
		}
		return;
	}

	var currentWeek = getIsoWeekString(new Date());
	weekFromInput.value = currentWeek;
	weekToInput.value = currentWeek;

	loadGreenhouseOptions();

	refreshBtn.addEventListener("click", refreshAllData);
	if (debugFetchBtn) {
		debugFetchBtn.addEventListener("click", exportFcmCsv);
	} else if (SCOUTING_DASHBOARD_DEBUG) {
		console.warn("Scouting dashboard: debug fetch button not found");
	}
	weekFromInput.addEventListener("change", refreshAllData);
	weekToInput.addEventListener("change", refreshAllData);
	greenhouseSelect.addEventListener("change", function (e) {
		greenhouseFilter = e.target.value;
		refreshAllData();
	});

	root_element.querySelectorAll(".dashboard-tabs .tab-btn").forEach(function (btn) {
		btn.addEventListener("click", function () {
			var tab = this.dataset.tab;
			switchTab(tab);
		});
	});

	root_element.querySelector("#scout-gh-modal-close").addEventListener("click", closeScoutModal);
	root_element.querySelector("#scout-gh-modal").addEventListener("click", function (e) {
		if (e.target === this) closeScoutModal();
	});

	setupWeeklyTrendFilterListeners();
	fetchScoutingData();
}

function setupWeeklyTrendFilterListeners() {
	var handlers = [
		{
			ids: ["#pest-weekly-pest-filter", "#pest-weekly-section-filter"],
			fn: function () {
				if (!scoutingYearData) return;
				updatePestWeeklyTrendChart();
			},
		},
		{
			ids: ["#disease-weekly-disease-filter", "#disease-weekly-section-filter"],
			fn: function () {
				if (!scoutingYearData) return;
				updateDiseaseWeeklyTrendChart();
			},
		},
		{
			ids: ["#trap-weekly-trap-filter", "#trap-weekly-pest-filter"],
			fn: function () {
				if (!scoutingYearData) return;
				updateTrapWeeklyTrendChart();
			},
		},
	];

	handlers.forEach(function (h) {
		h.ids.forEach(function (selector) {
			var el = root_element.querySelector(selector);
			if (!el) return;
			el.addEventListener("change", h.fn);
		});
	});
}

function parseWeekValue(weekValue) {
	if (!weekValue || typeof weekValue !== "string") return null;
	var match = weekValue.match(/^(\d{4})-W(\d{2})$/);
	if (!match) return null;
	var year = Number(match[1]);
	var week = Number(match[2]);
	if (!Number.isFinite(year) || !Number.isFinite(week)) return null;
	if (week < 1) week = 1;
	if (week > 52) week = 52;
	return { year: year, week: week, value: weekValue };
}

function formatDateYmd(dateObj) {
	var y = dateObj.getUTCFullYear();
	var m = String(dateObj.getUTCMonth() + 1).padStart(2, "0");
	var d = String(dateObj.getUTCDate()).padStart(2, "0");
	return y + "-" + m + "-" + d;
}

function getIsoWeekDateRange(year, week) {
	var simple = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
	var dow = simple.getUTCDay();
	var isoWeekStart = new Date(simple);
	if (dow <= 4) {
		isoWeekStart.setUTCDate(simple.getUTCDate() - (dow || 7) + 1);
	} else {
		isoWeekStart.setUTCDate(simple.getUTCDate() + 8 - dow);
	}
	var isoWeekEnd = new Date(isoWeekStart);
	isoWeekEnd.setUTCDate(isoWeekStart.getUTCDate() + 6);
	return { fromDate: formatDateYmd(isoWeekStart), toDate: formatDateYmd(isoWeekEnd) };
}

function compareIsoWeeks(a, b) {
	var ay = Number(a?.year) || 0;
	var by = Number(b?.year) || 0;
	if (ay !== by) return ay - by;
	return (Number(a?.week) || 0) - (Number(b?.week) || 0);
}

function getSelectedWeekRangeInfo() {
	var fromValue = root_element.querySelector("#scout-week-from")?.value;
	var toValue = root_element.querySelector("#scout-week-to")?.value;

	var fallback = getIsoWeekString(new Date());
	var fromParsed = parseWeekValue(fromValue) || parseWeekValue(fallback);
	var toParsed = parseWeekValue(toValue) || parseWeekValue(fallback);

	if (!fromParsed || !toParsed) return null;
	if (compareIsoWeeks(fromParsed, toParsed) > 0) {
		var tmp = fromParsed;
		fromParsed = toParsed;
		toParsed = tmp;
	}

	var fromRange = getIsoWeekDateRange(fromParsed.year, fromParsed.week);
	var toRange = getIsoWeekDateRange(toParsed.year, toParsed.week);

	return {
		from: fromParsed,
		to: toParsed,
		fromDate: fromRange.fromDate,
		toDate: toRange.toDate,
	};
}

function getWeekRangeAxis(rangeInfo) {
	if (!rangeInfo?.from || !rangeInfo?.to) return null;

	var sameYear = rangeInfo.from.year === rangeInfo.to.year;
	var labels = [];
	var keys = [];

	if (sameYear) {
		for (var w = rangeInfo.from.week; w <= rangeInfo.to.week; w++) {
			keys.push(rangeInfo.from.year + "-W" + String(w).padStart(2, "0"));
			labels.push(String(w));
		}
		return { sameYear: true, year: rangeInfo.from.year, keys: keys, labels: labels };
	}

	var start = new Date(rangeInfo.fromDate + "T00:00:00Z");
	var end = new Date(rangeInfo.toDate + "T00:00:00Z");
	for (var d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 7)) {
		var key = getIsoWeekString(d);
		keys.push(key);
		labels.push(key);
	}
	return { sameYear: false, keys: keys, labels: labels };
}

function csvEscape(value) {
	if (value === null || value === undefined) return "";
	var str = String(value);
	if (/[",\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
	return str;
}

function exportFcmCsv() {
	var rangeInfo = getSelectedWeekRangeInfo();
	var fromWeek = rangeInfo?.from?.value || getIsoWeekString(new Date());
	var toWeek = rangeInfo?.to?.value || getIsoWeekString(new Date());

	return callFrappe("upande_scp.serverscripts.get_trap_data.exportFcmCsv", {
		week_from: fromWeek,
		week_to: toWeek,
		greenhouse: greenhouseFilter,
	})
		.then(function (r) {
			var payload = r?.message || r || {};
			var csvText = payload.csv;
			if (!csvText) {
				notifyUser("No FCM data for selected range");
				return;
			}

			var blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
			var url = URL.createObjectURL(blob);
			var a = document.createElement("a");
			a.href = url;
			a.download = "FCM_export_" + fromWeek + "_to_" + toWeek + ".csv";
			document.body.appendChild(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);

			notifyUser("Exported FCM CSV (" + (payload.row_count || 0) + " rows)");
		})
		.catch(function (err) {
			if (SCOUTING_DASHBOARD_DEBUG) {
				console.error("Scouting dashboard: failed to export FCM CSV", err);
			}
			notifyUser("Failed to export FCM CSV");
		});
}

function loadGreenhouseOptions() {
	return callFrappe("frappe.client.get_list", {
		doctype: "Scouting Entry",
		fields: ["distinct greenhouse"],
		limit_page_length: 1000,
	})
		.then(function (r) {
			if (r.message) {
				var greenhouses = [...new Set(r.message.map((d) => d.greenhouse).filter(Boolean))];
				var select = root_element.querySelector("#scout-greenhouse-filter");
				greenhouses.sort().forEach((gh) => {
					var option = document.createElement("option");
					option.value = gh;
					option.textContent = gh;
					select.appendChild(option);
				});
			}
		})
		.catch(function (err) {
			if (SCOUTING_DASHBOARD_DEBUG) {
				console.error("Scouting dashboard: failed to load greenhouse options", err);
			}
		});
}

function switchTab(tab) {
	activeTab = tab;
	root_element.querySelectorAll(".dashboard-tabs .tab-btn").forEach(function (btn) {
		btn.classList.toggle("active", btn.dataset.tab === tab);
	});
	root_element.querySelectorAll(".tab-content").forEach(function (content) {
		content.classList.toggle("active", content.id === "tab-" + tab);
	});

	if (scoutingData) {
		updateTabData(tab);
	}
}

function refreshAllData() {
	fetchScoutingData();
}

function fetchScoutingData() {
	var rangeInfo = getSelectedWeekRangeInfo();
	if (!rangeInfo) return;
	var fromDate = rangeInfo.fromDate;
	var toDate = rangeInfo.toDate;
	var loading = root_element.querySelector("#scout-loading");
	var yearFrom = rangeInfo.from.year + "-01-01";
	var yearTo = rangeInfo.to.year + "-12-31";

	loading.classList.add("active");
	if (SCOUTING_DASHBOARD_DEBUG) {
		console.log("Scouting dashboard: fetching", {
			fromDate,
			toDate,
			greenhouseFilter,
			yearFrom,
			yearTo,
		});
	}

	Promise.all([
		fetchCompleteScoutingEntries(fromDate, toDate, greenhouseFilter),
		fetchCompleteScoutingEntries(yearFrom, yearTo, greenhouseFilter),
		fetchScoutingAnalysis(toDate),
		fetchScoutingReport(greenhouseFilter),
	])
		.then(function ([entries, yearEntries, analysis, report]) {
			if (SCOUTING_DASHBOARD_DEBUG) {
				console.log("Scouting dashboard: fetched payloads", {
					entriesCount: Array.isArray(entries) ? entries.length : null,
					yearEntriesCount: Array.isArray(yearEntries) ? yearEntries.length : null,
					analysis,
					report,
					entries,
					yearEntries,
				});
			}
			scoutingAnalysis = analysis;
			observationColors = extractObservationColors(report);
			scoutingYearData = buildScoutingData(yearEntries);
			processScoutingData(entries);
			loading.classList.remove("active");
		})
		.catch(function (err) {
			if (SCOUTING_DASHBOARD_DEBUG) {
				console.error("Scouting dashboard: failed to load", err);
			}
			loading.classList.remove("active");
			notifyUser("Failed to load scouting data");
		});
}

function buildScoutingData(entries, trapEntries) {
	entries = normalizeScoutingEntries(entries);
	var data = {
		entries: entries,
		pests: {},
		diseases: {},
		traps: {},
		greenhouses: {},
		scouts: {},
		daily: {},
	};

	var useTrapEntries = Array.isArray(trapEntries) && trapEntries.length > 0;

	entries.forEach((entry) => {
		var date = entry.date_of_capture;
		var greenhouse = entry.greenhouse;
		var scoutInfo = getScoutIdentity(entry);
		var scoutKey = scoutInfo.key;
		var scoutLabel = scoutInfo.label;
		var pests = entry.pests_scouting_entry || entry.pests || [];
		var diseases = entry.diseases_scouting_entry || entry.diseases || [];
		var traps = entry.trap_scouting_entry || entry.traps || [];

		if (!data.daily[date]) {
			data.daily[date] = { pests: 0, diseases: 0, traps: 0, total: 0 };
		}
		data.daily[date].total++;

		if (!data.greenhouses[greenhouse]) {
			data.greenhouses[greenhouse] = {
				name: greenhouse,
				pests: 0,
				diseases: 0,
				traps: 0,
				scouts: new Set(),
				alerts: 0,
			};
		}

		if (pests.length > 0) {
			data.daily[date].pests += pests.length;
			data.greenhouses[greenhouse].pests += pests.length;

			pests.forEach((pest) => {
				var pestName = pest.pest || "Unknown";
				var pestStage = pest.stage || "Unknown";
				if (!data.pests[pestName]) {
					data.pests[pestName] = {
						name: pestName,
						counts: [],
						stages: {},
						sections: {},
						severity: { low: 0, moderate: 0, high: 0 },
					};
				}
				data.pests[pestName].counts.push({
					date: date,
					count: toNumber(pest.count || 1),
					stage: pestStage,
					section: pest.plant_section,
					greenhouse: greenhouse,
				});

				if (!data.pests[pestName].stages[pestStage]) {
					data.pests[pestName].stages[pestStage] = 0;
				}
				data.pests[pestName].stages[pestStage] += toNumber(pest.count || 1);

				if (pest.plant_section) {
					if (!data.pests[pestName].sections[pest.plant_section]) {
						data.pests[pestName].sections[pest.plant_section] = 0;
					}
					data.pests[pestName].sections[pest.plant_section] += toNumber(pest.count || 1);
				}

				var pestCount = toNumber(pest.count || 0);
				if (pestCount > 15) data.pests[pestName].severity.high++;
				else if (pestCount > 5) data.pests[pestName].severity.moderate++;
				else data.pests[pestName].severity.low++;
			});
		}

		if (diseases.length > 0) {
			data.daily[date].diseases += diseases.length;
			data.greenhouses[greenhouse].diseases += diseases.length;

			diseases.forEach((disease) => {
				var diseaseName = disease.disease || "Unknown";
				var diseaseStage = disease.stage || disease.severity_level || "";
				var severityKey = (disease.severity_level || disease.stage || "").toLowerCase();
				if (!data.diseases[diseaseName]) {
					data.diseases[diseaseName] = {
						name: diseaseName,
						counts: [],
						stages: {},
						severity: { low: 0, moderate: 0, high: 0 },
					};
				}
				data.diseases[diseaseName].counts.push({
					date: date,
					stage: diseaseStage,
					section: disease.plant_section,
					greenhouse: greenhouse,
				});

				if (diseaseStage) {
					if (!data.diseases[diseaseName].stages[diseaseStage]) {
						data.diseases[diseaseName].stages[diseaseStage] = 0;
					}
					data.diseases[diseaseName].stages[diseaseStage]++;
				}

				if (
					severityKey.includes("high") ||
					severityKey.includes("severe") ||
					severityKey.includes("active")
				) {
					data.diseases[diseaseName].severity.high++;
				} else if (severityKey.includes("moderate") || severityKey.includes("medium")) {
					data.diseases[diseaseName].severity.moderate++;
				} else {
					data.diseases[diseaseName].severity.low++;
				}
			});
		}

		if (!useTrapEntries && traps.length > 0) {
			data.daily[date].traps += traps.length;
			data.greenhouses[greenhouse].traps += traps.length;

			traps.forEach((trap) => {
				var trapId = trap.trap || trap.trap_name || "Unknown";
				var pest = trap.pest || "Unknown";
				var key = trapId + "-" + pest;
				var location = trap.location || trap.plant_section;
				var trapCount = toNumber(trap.count || 0);

				if (!data.traps[key]) {
					data.traps[key] = {
						trap: trapId,
						pest: pest,
						location: location,
						counts: [],
						total: 0,
					};
				}
				data.traps[key].counts.push({
					date: date,
					count: trapCount,
					location: location,
					greenhouse: greenhouse,
				});
				data.traps[key].total += trapCount;

				if (trapCount > 10) {
					data.greenhouses[greenhouse].alerts++;
				}
			});
		}

		if (scoutKey) {
			data.greenhouses[greenhouse].scouts.add(scoutKey);
			if (!data.scouts[scoutKey]) {
				data.scouts[scoutKey] = { entries: 0, name: scoutLabel || scoutKey };
			}
			data.scouts[scoutKey].entries++;
		}
	});

	if (useTrapEntries) {
		trapEntries.forEach((trap) => {
			var date = trap.date_of_capture;
			var greenhouse = trap.greenhouse;

			if (!data.daily[date]) {
				data.daily[date] = { pests: 0, diseases: 0, traps: 0, total: 0 };
			}
			if (!data.greenhouses[greenhouse]) {
				data.greenhouses[greenhouse] = {
					name: greenhouse,
					pests: 0,
					diseases: 0,
					traps: 0,
					scouts: new Set(),
					alerts: 0,
				};
			}

			data.daily[date].traps += 1;
			data.greenhouses[greenhouse].traps += 1;

			var trapId = trap.trap;
			var pest = trap.pest || "Unknown";
			var key = trapId + "-" + pest;

			if (!data.traps[key]) {
				data.traps[key] = {
					trap: trapId,
					pest: pest,
					location: trap.location,
					counts: [],
					total: 0,
				};
			}
			data.traps[key].counts.push({
				date: date,
				count: trap.count || 0,
				location: trap.location,
				greenhouse: greenhouse,
			});
			data.traps[key].total += trap.count || 0;

			if (trap.count > 10) {
				data.greenhouses[greenhouse].alerts++;
			}
		});
	}

	Object.keys(data.greenhouses).forEach((gh) => {
		data.greenhouses[gh].scoutCount = data.greenhouses[gh].scouts.size;
	});

	return data;
}

function processScoutingData(entries, trapEntries) {
	scoutingData = buildScoutingData(entries, trapEntries);
	updateAllTabs();
}

function fetchCompleteScoutingEntries(fromDate, toDate, greenhouse) {
	return callFrappe(
		"upande_scp.serverscripts.get_complete_scouting_entries.getCompleteScoutingEntries",
		{
			from_date: fromDate,
			to_date: toDate,
			greenhouse: greenhouse,
		},
	).then(function (r) {
		return r.message?.entries || [];
	});
}

function fetchScoutingEntries(fromDate, toDate, greenhouse) {
	return callFrappe("frappe.client.get_list", {
		doctype: "Scouting Entry",
		fields: ["name", "date_of_capture", "greenhouse", "scouts_name", "bed", "zone"],
		filters: {
			date_of_capture: ["between", [fromDate, toDate]],
			...(greenhouse ? { greenhouse: greenhouse } : {}),
		},
		limit_page_length: 10000,
	}).then(function (r) {
		var entries = r.message || [];
		var names = entries.map((e) => e.name);
		if (!names.length) return [];

		return Promise.all([
			fetchChildRows("Pests Scouting Entry", names, [
				"parent",
				"pest",
				"plant_section",
				"stage",
				"count",
			]),
			fetchChildRows("Diseases Scouting Entry", names, [
				"parent",
				"disease",
				"plant_section",
				"stage",
			]),
			fetchChildRows("Trap Scouting Entry", names, [
				"parent",
				"trap",
				"pest",
				"location",
				"count",
			]),
		]).then(function ([pests, diseases, traps]) {
			var byParent = {};
			entries.forEach((e) => {
				byParent[e.name] = e;
				e.pests_scouting_entry = [];
				e.diseases_scouting_entry = [];
				e.trap_scouting_entry = [];
			});

			pests.forEach((row) => {
				if (byParent[row.parent]) byParent[row.parent].pests_scouting_entry.push(row);
			});
			diseases.forEach((row) => {
				if (byParent[row.parent]) byParent[row.parent].diseases_scouting_entry.push(row);
			});
			traps.forEach((row) => {
				if (byParent[row.parent]) byParent[row.parent].trap_scouting_entry.push(row);
			});

			return entries;
		});
	});
}

function fetchChildRows(doctype, parentNames, fields) {
	return callFrappe("frappe.client.get_list", {
		doctype: doctype,
		fields: fields,
		filters: {
			parent: ["in", parentNames],
			parenttype: "Scouting Entry",
		},
		limit_page_length: 10000,
	}).then(function (r) {
		return r.message || [];
	});
}

function fetchScoutingAnalysis(toDate) {
	if (!toDate) return Promise.resolve(null);
	return callFrappe("upande_scp.serverscripts.get_scouting_analysis.getScoutingAnalysis", {
		date: toDate,
	})
		.then(function (r) {
			return r.message || null;
		})
		.catch(function () {
			return null;
		});
}

function fetchScoutingReport(greenhouse) {
	if (!greenhouse) return Promise.resolve(null);
	return callFrappe("upande_scp.serverscripts.get_scouting_report.getScoutingData", {
		greenhouse: greenhouse,
	})
		.then(function (r) {
			return r.message || null;
		})
		.catch(function () {
			return null;
		});
}

function fetchTrapDataRange(fromDate, toDate) {
	var weeks = buildWeekList(fromDate, toDate);
	if (!weeks.length) return Promise.resolve([]);

	var requests = weeks.map(function (week) {
		return callFrappe("upande_scp.serverscripts.get_trap_data.getTrapData", {
			week: week,
		})
			.then(function (r) {
				return r.message?.trap_entries || [];
			})
			.catch(function () {
				return [];
			});
	});

	return Promise.all(requests).then(function (responses) {
		var merged = [];
		responses.forEach(function (rows) {
			merged = merged.concat(rows);
		});
		return merged.filter(function (row) {
			return row.date_of_capture >= fromDate && row.date_of_capture <= toDate;
		});
	});
}

function buildWeekList(fromDate, toDate) {
	if (!fromDate || !toDate) return [];
	var start = new Date(fromDate + "T00:00:00Z");
	var end = new Date(toDate + "T00:00:00Z");
	if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
	var weeks = new Set();
	while (start <= end) {
		weeks.add(getIsoWeekString(start));
		start.setUTCDate(start.getUTCDate() + 1);
	}
	return Array.from(weeks);
}

function getIsoWeekString(dateInput) {
	var date =
		typeof dateInput === "string" ? new Date(dateInput + "T00:00:00Z") : new Date(dateInput);
	var day = date.getUTCDay() || 7;
	date.setUTCDate(date.getUTCDate() + 4 - day);
	var yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
	var weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
	return date.getUTCFullYear() + "-W" + String(weekNo).padStart(2, "0");
}

function getYearFromDateString(dateString) {
	if (!dateString) return null;
	var date = new Date(dateString + "T00:00:00Z");
	if (Number.isNaN(date.getTime())) return null;
	return date.getUTCFullYear();
}

function getWeekNumber1to52(dateString, year) {
	if (!dateString) return null;
	var date = new Date(dateString + "T00:00:00Z");
	if (Number.isNaN(date.getTime())) return null;
	if (typeof year === "number" && date.getUTCFullYear() !== year) return null;
	var yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
	var dayOfYear = Math.floor((date - yearStart) / 86400000) + 1;
	var weekNo = Math.ceil(dayOfYear / 7);
	if (weekNo < 1) weekNo = 1;
	if (weekNo > 52) weekNo = 52;
	return weekNo;
}

function getWeekLabels1to52() {
	return Array.from({ length: 52 }, function (_, idx) {
		return String(idx + 1);
	});
}

function extractObservationColors(report) {
	var colors = { pests: {}, diseases: {} };
	if (!report?.observation_metadata?.all_observation_names) return colors;
	var pests = report.observation_metadata.all_observation_names.pests_scouting_entry || [];
	var diseases = report.observation_metadata.all_observation_names.diseases_scouting_entry || [];
	pests.forEach(function (p) {
		if (p.name && p.color) colors.pests[p.name] = p.color;
	});
	diseases.forEach(function (d) {
		if (d.name && d.color) colors.diseases[d.name] = d.color;
	});
	return colors;
}

function callFrappe(method, args) {
	if (window.frappe && typeof window.frappe.call === "function") {
		return new Promise(function (resolve, reject) {
			window.frappe.call({
				method: method,
				args: args,
				callback: function (r) {
					if (SCOUTING_DASHBOARD_DEBUG) {
						console.log("Scouting dashboard: frappe.call response", {
							method,
							args,
							r,
						});
					}
					resolve(r || {});
				},
				error: function (err) {
					if (SCOUTING_DASHBOARD_DEBUG) {
						console.error("Scouting dashboard: frappe.call error", {
							method,
							args,
							err,
						});
					}
					reject(err);
				},
			});
		});
	}

	var params = new URLSearchParams();
	Object.keys(args || {}).forEach(function (key) {
		var value = args[key];
		if (value === undefined || value === null) return;
		params.set(key, typeof value === "string" ? value : JSON.stringify(value));
	});

	var url = "/api/method/" + method;
	var qs = params.toString();
	if (qs) url = url + "?" + qs;

	if (SCOUTING_DASHBOARD_DEBUG) {
		console.log("Scouting dashboard: fetch call", { method, args, url });
	}

	return fetch(url, {
		method: "GET",
		credentials: "same-origin",
		headers: { Accept: "application/json" },
	}).then(function (res) {
		return res
			.json()
			.catch(function () {
				return null;
			})
			.then(function (data) {
				if (SCOUTING_DASHBOARD_DEBUG) {
					console.log("Scouting dashboard: fetch response", {
						method,
						status: res.status,
						ok: res.ok,
						data,
					});
				}

				if (!res.ok) {
					var errorMessage = data?.exc || data?.message || "Request failed";
					var err = new Error(errorMessage);
					err.response = data;
					throw err;
				}

				return data || {};
			});
	});
}

function updateAllTabs() {
	updatePestTab();
	updateDiseaseTab();
	updateTrapTab();
	updateOverviewTab();
}

function updateTabData(tab) {
	switch (tab) {
		case "pests":
			updatePestTab();
			break;
		case "diseases":
			updateDiseaseTab();
			break;
		case "traps":
			updateTrapTab();
			break;
		case "overview":
			updateOverviewTab();
			break;
	}
}

function updatePestTab() {
	if (!scoutingData) return;

	var pests = scoutingData.pests;
	var pestNames = Object.keys(pests);

	var totalEntries = scoutingData.entries.reduce((sum, e) => {
		var pests = e.pests_scouting_entry || e.pests || [];
		return sum + pests.length;
	}, 0);
	var activePests = pestNames.length;
	var highSeverity = pestNames.reduce((sum, p) => sum + pests[p].severity.high, 0);

	var topPest =
		pestNames.length > 0
			? pestNames.reduce((a, b) => (pests[a].counts.length > pests[b].counts.length ? a : b))
			: "None";

	root_element.querySelector("#pest-total-entries").textContent = formatNumber(totalEntries);
	root_element.querySelector("#pest-active-count").textContent = activePests;
	root_element.querySelector("#pest-high-severity").textContent = highSeverity;
	root_element.querySelector("#pest-top-name").textContent = topPest;
	root_element.querySelector("#pest-top-count").textContent =
		(pests[topPest]?.counts.length || 0) + " observations";

	updatePestTrendChart();
	updatePestWeeklyTrend();

	updatePestDistributionChart();

	updatePestSeverityMatrix();

	updatePestSectionChart();

	updatePestStagesTable();
}

function updatePestTrendChart() {
	var ctx = root_element.querySelector("#pest-trend-chart");
	if (pestTrendChart) pestTrendChart.destroy();

	var dates = Object.keys(scoutingData.daily).sort();
	var pestCounts = dates.map((d) => scoutingData.daily[d].pests);

	pestTrendChart = new Chart(ctx, {
		type: "line",
		data: {
			labels: dates.map((d) => d.slice(5)),
			datasets: [
				{
					label: "Pest Observations",
					data: pestCounts,
					borderColor: "#10b981",
					backgroundColor: "rgba(16, 185, 129, 0.1)",
					borderWidth: 2,
					fill: true,
					tension: 0.4,
					pointRadius: 4,
					pointBackgroundColor: "#10b981",
				},
			],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: { display: false },
			},
			scales: {
				x: { grid: { display: false } },
				y: { beginAtZero: true, grid: { color: "rgba(0,0,0,0.04)" } },
			},
		},
	});
}

function setSelectOptions(selectEl, options, preferredValue) {
	if (!selectEl) return;
	var current = preferredValue !== undefined ? preferredValue : selectEl.value;
	selectEl.innerHTML = "";

	options.forEach(function (opt) {
		var option = document.createElement("option");
		option.value = opt.value;
		option.textContent = opt.label;
		selectEl.appendChild(option);
	});

	var allowed = options.some(function (o) {
		return o.value === current;
	});
	selectEl.value = allowed ? current : options[0]?.value || "";
}

function getPaletteColor(index) {
	var hue = (index * 37) % 360;
	return {
		border: "hsl(" + hue + ", 70%, 45%)",
		background: "hsla(" + hue + ", 70%, 45%, 0.12)",
	};
}

function updatePestWeeklyTrend() {
	var pestSelect = root_element.querySelector("#pest-weekly-pest-filter");
	var sectionSelect = root_element.querySelector("#pest-weekly-section-filter");
	if (!pestSelect || !sectionSelect) return;
	if (!scoutingYearData) return;

	var pestNames = Object.keys(scoutingYearData.pests || {}).sort();
	setSelectOptions(
		pestSelect,
		[{ value: "", label: "All Pests" }].concat(
			pestNames.map(function (p) {
				return { value: p, label: p };
			}),
		),
	);

	var sectionsSet = new Set();
	Object.values(scoutingYearData.pests || {}).forEach(function (p) {
		(p.counts || []).forEach(function (c) {
			if (c.section) sectionsSet.add(c.section);
		});
	});
	var sections = Array.from(sectionsSet).sort();
	setSelectOptions(
		sectionSelect,
		[{ value: "", label: "All Sections" }].concat(
			sections.map(function (s) {
				return { value: s, label: s };
			}),
		),
	);

	updatePestWeeklyTrendChart();
}

function updatePestWeeklyTrendChart() {
	var ctx = root_element.querySelector("#pest-weekly-trend-chart");
	if (!ctx) return;
	if (pestWeeklyTrendChart) pestWeeklyTrendChart.destroy();
	if (!scoutingData) return;

	var rangeInfo = getSelectedWeekRangeInfo();
	if (!rangeInfo) return;
	var axis = getWeekRangeAxis(rangeInfo);
	if (!axis) return;
	var weekIndex = {};
	axis.keys.forEach(function (k, idx) {
		weekIndex[k] = idx;
	});

	var pestName = root_element.querySelector("#pest-weekly-pest-filter")?.value || "";
	var section = root_element.querySelector("#pest-weekly-section-filter")?.value || "";

	var weekLabels = axis.labels;
	var datasets = [];

	if (pestName) {
		var weeklyCounts = new Array(axis.labels.length).fill(0);
		(scoutingData.pests?.[pestName]?.counts || []).forEach(function (c) {
			if (section && c.section !== section) return;
			var k = getIsoWeekString(new Date(c.date + "T00:00:00Z"));
			var i = weekIndex[k];
			if (i === undefined) return;
			weeklyCounts[i] += Number(c.count || 1);
		});

		var accent = observationColors.pests[pestName] || "#10b981";
		var label = pestName;
		if (section) label += " (" + section + ")";

		datasets.push({
			label: label,
			data: weeklyCounts,
			borderColor: accent,
			backgroundColor: "rgba(16, 185, 129, 0.1)",
			borderWidth: 2,
			fill: false,
			tension: 0.35,
			pointRadius: 0,
			order: 0,
		});
	} else {
		var pestNames = Object.keys(scoutingData.pests || {}).sort();
		pestNames.forEach(function (p, idx) {
			var weeklyCounts = new Array(axis.labels.length).fill(0);
			(scoutingData.pests[p].counts || []).forEach(function (c) {
				if (section && c.section !== section) return;
				var k = getIsoWeekString(new Date(c.date + "T00:00:00Z"));
				var i = weekIndex[k];
				if (i === undefined) return;
				weeklyCounts[i] += Number(c.count || 1);
			});

			var total = weeklyCounts.reduce(function (a, b) {
				return a + b;
			}, 0);
			if (total <= 0) return;

			var palette = getPaletteColor(idx);
			var accent = observationColors.pests[p] || palette.border;
			datasets.push({
				label: p,
				data: weeklyCounts,
				borderColor: accent,
				backgroundColor: palette.background,
				borderWidth: 2,
				fill: false,
				tension: 0.35,
				pointRadius: 0,
				order: idx,
			});
		});
	}

	pestWeeklyTrendChart = new Chart(ctx, {
		type: "line",
		data: {
			labels: weekLabels,
			datasets: datasets,
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: {
					display: datasets.length > 1,
					position: "bottom",
					labels: { boxWidth: 10, boxHeight: 10, padding: 10, font: { size: 10 } },
				},
				tooltip: {
					mode: "index",
					intersect: false,
					callbacks: {
						title: function (items) {
							var idx = items?.[0]?.dataIndex;
							if (idx === undefined) return "";
							if (axis.sameYear)
								return "Week " + axis.labels[idx] + " (" + axis.year + ")";
							return axis.keys[idx];
						},
					},
				},
			},
			scales: {
				x: {
					grid: { display: false },
					ticks: { autoSkip: true, maxTicksLimit: 13 },
				},
				y: { beginAtZero: true, grid: { color: "rgba(0,0,0,0.04)" } },
			},
		},
	});
}

function updatePestDistributionChart() {
	var ctx = root_element.querySelector("#pest-distribution-chart");
	if (pestDistChart) pestDistChart.destroy();

	var pests = scoutingData.pests;
	var labels = Object.keys(pests).slice(0, 10);
	var data = labels.map((p) => pests[p].counts.length);
	var palette = [
		"#10b981",
		"#3b82f6",
		"#f59e0b",
		"#8b5cf6",
		"#ef4444",
		"#ec4899",
		"#14b8a6",
		"#f97316",
		"#6366f1",
		"#06b6d4",
	];
	var colors = labels.map(
		(label, idx) => observationColors.pests[label] || palette[idx % palette.length],
	);

	pestDistChart = new Chart(ctx, {
		type: "bar",
		data: {
			labels: labels,
			datasets: [
				{
					label: "Observations",
					data: data,
					backgroundColor: colors,
					borderRadius: 4,
				},
			],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: { display: false },
			},
			scales: {
				y: { beginAtZero: true, grid: { color: "rgba(0,0,0,0.04)" } },
			},
		},
	});
}

function updatePestSeverityMatrix() {
	var container = root_element.querySelector("#pest-severity-matrix");
	var pests = scoutingData.pests;

	var html = Object.keys(pests)
		.slice(0, 12)
		.map((pest) => {
			var p = pests[pest];
			var total = p.counts.length;
			var highPct = total > 0 ? Math.round((p.severity.high / total) * 100) : 0;
			var modPct = total > 0 ? Math.round((p.severity.moderate / total) * 100) : 0;
			var lowPct = total > 0 ? Math.round((p.severity.low / total) * 100) : 0;

			var severityClass =
				highPct > 50
					? "critical"
					: highPct > 20
						? "high"
						: modPct > 30
							? "moderate"
							: "low";

			return `
            <div class="severity-item">
                <div class="severity-name">${pest}</div>
                <div class="severity-bar">
                    <div class="severity-fill ${severityClass}" style="width: ${
						highPct + modPct + lowPct
					}%"></div>
                </div>
                <div class="severity-stats">
                    <span>High: ${p.severity.high}</span>
                    <span>Mod: ${p.severity.moderate}</span>
                    <span>Low: ${p.severity.low}</span>
                </div>
            </div>
        `;
		})
		.join("");

	container.innerHTML = html || '<div class="empty-state">No pest data available</div>';
}

function updatePestSectionChart() {
	var ctx = root_element.querySelector("#pest-section-chart");
	if (pestSectionChart) pestSectionChart.destroy();

	var sections = {};
	Object.keys(scoutingData.pests).forEach((pest) => {
		Object.keys(scoutingData.pests[pest].sections).forEach((section) => {
			if (!sections[section]) sections[section] = 0;
			sections[section] += scoutingData.pests[pest].sections[section];
		});
	});

	var labels = Object.keys(sections);
	var data = Object.values(sections);

	pestSectionChart = new Chart(ctx, {
		type: "doughnut",
		data: {
			labels: labels,
			datasets: [
				{
					data: data,
					backgroundColor: ["#10b981", "#3b82f6", "#f59e0b", "#8b5cf6", "#ef4444"],
				},
			],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: { position: "bottom" },
			},
		},
	});
}

function updatePestStagesTable() {
	var tbody = root_element.querySelector("#pest-stages-body");
	var stages = [];

	Object.keys(scoutingData.pests).forEach((pest) => {
		scoutingData.pests[pest].counts.slice(0, 20).forEach((c) => {
			stages.push({
				pest: pest,
				stage: c.stage || "N/A",
				count: c.count || 1,
				section: c.section || "N/A",
				date: c.date,
				greenhouse: c.greenhouse,
			});
		});
	});

	stages.sort((a, b) => new Date(b.date) - new Date(a.date));
	stages = stages.slice(0, 50);

	if (stages.length === 0) {
		tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No pest stages found</td></tr>';
		return;
	}

	tbody.innerHTML = stages
		.map(
			(s) => `
        <tr>
            <td><span class="pest-badge ${s.pest.toLowerCase().replace(" ", "-")}">${
				s.pest
			}</span></td>
            <td>${s.stage}</td>
            <td><strong>${s.count}</strong></td>
            <td>${s.section}</td>
            <td>${s.date}</td>
            <td>${s.greenhouse || "-"}</td>
        </tr>
    `,
		)
		.join("");
}

function updateDiseaseTab() {
	if (!scoutingData) return;

	var diseases = scoutingData.diseases;
	var diseaseNames = Object.keys(diseases);

	var totalEntries = scoutingData.entries.reduce((sum, e) => {
		var diseases = e.diseases_scouting_entry || e.diseases || [];
		return sum + diseases.length;
	}, 0);
	var activeDiseases = diseaseNames.length;
	var severeCases = diseaseNames.reduce((sum, d) => sum + diseases[d].severity.high, 0);

	var topDisease =
		diseaseNames.length > 0
			? diseaseNames.reduce((a, b) =>
					diseases[a].counts.length > diseases[b].counts.length ? a : b,
				)
			: "None";

	root_element.querySelector("#disease-total-entries").textContent = formatNumber(totalEntries);
	root_element.querySelector("#disease-active-count").textContent = activeDiseases;
	root_element.querySelector("#disease-severe-count").textContent = severeCases;
	root_element.querySelector("#disease-top-name").textContent = topDisease;
	root_element.querySelector("#disease-top-count").textContent =
		(diseases[topDisease]?.counts.length || 0) + " cases";

	updateDiseaseTrendChart();
	updateDiseaseWeeklyTrend();

	updateDiseaseDistributionChart();

	updateDiseaseSeverityBubbles();

	updateDiseaseStageChart();

	updateDiseaseIncidentsTable();
}

function updateDiseaseTrendChart() {
	var ctx = root_element.querySelector("#disease-trend-chart");
	if (diseaseTrendChart) diseaseTrendChart.destroy();

	var dates = Object.keys(scoutingData.daily).sort();
	var diseaseCounts = dates.map((d) => scoutingData.daily[d].diseases);

	diseaseTrendChart = new Chart(ctx, {
		type: "line",
		data: {
			labels: dates.map((d) => d.slice(5)),
			datasets: [
				{
					label: "Disease Observations",
					data: diseaseCounts,
					borderColor: "#f59e0b",
					backgroundColor: "rgba(245, 158, 11, 0.1)",
					borderWidth: 2,
					fill: true,
					tension: 0.4,
					pointRadius: 4,
					pointBackgroundColor: "#f59e0b",
				},
			],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: { display: false },
			},
			scales: {
				x: { grid: { display: false } },
				y: { beginAtZero: true, grid: { color: "rgba(0,0,0,0.04)" } },
			},
		},
	});
}

function updateDiseaseWeeklyTrend() {
	var diseaseSelect = root_element.querySelector("#disease-weekly-disease-filter");
	var sectionSelect = root_element.querySelector("#disease-weekly-section-filter");
	if (!diseaseSelect || !sectionSelect) return;
	if (!scoutingYearData) return;

	var diseaseNames = Object.keys(scoutingYearData.diseases || {}).sort();
	setSelectOptions(
		diseaseSelect,
		[{ value: "", label: "All Diseases" }].concat(
			diseaseNames.map(function (d) {
				return { value: d, label: d };
			}),
		),
	);

	var sectionsSet = new Set();
	Object.values(scoutingYearData.diseases || {}).forEach(function (d) {
		(d.counts || []).forEach(function (c) {
			if (c.section) sectionsSet.add(c.section);
		});
	});
	var sections = Array.from(sectionsSet).sort();
	setSelectOptions(
		sectionSelect,
		[{ value: "", label: "All Sections" }].concat(
			sections.map(function (s) {
				return { value: s, label: s };
			}),
		),
	);

	updateDiseaseWeeklyTrendChart();
}

function updateDiseaseWeeklyTrendChart() {
	var ctx = root_element.querySelector("#disease-weekly-trend-chart");
	if (!ctx) return;
	if (diseaseWeeklyTrendChart) diseaseWeeklyTrendChart.destroy();
	if (!scoutingData) return;

	var rangeInfo = getSelectedWeekRangeInfo();
	if (!rangeInfo) return;
	var axis = getWeekRangeAxis(rangeInfo);
	if (!axis) return;
	var weekIndex = {};
	axis.keys.forEach(function (k, idx) {
		weekIndex[k] = idx;
	});

	var diseaseName = root_element.querySelector("#disease-weekly-disease-filter")?.value || "";
	var section = root_element.querySelector("#disease-weekly-section-filter")?.value || "";

	var weekLabels = axis.labels;
	var datasets = [];

	if (diseaseName) {
		var weeklyCounts = new Array(axis.labels.length).fill(0);
		(scoutingData.diseases?.[diseaseName]?.counts || []).forEach(function (c) {
			if (section && c.section !== section) return;
			var k = getIsoWeekString(new Date(c.date + "T00:00:00Z"));
			var i = weekIndex[k];
			if (i === undefined) return;
			weeklyCounts[i] += 1;
		});

		var accent = observationColors.diseases[diseaseName] || "#f59e0b";
		var label = diseaseName;
		if (section) label += " (" + section + ")";
		datasets.push({
			label: label,
			data: weeklyCounts,
			borderColor: accent,
			backgroundColor: "rgba(245, 158, 11, 0.1)",
			borderWidth: 2,
			fill: false,
			tension: 0.35,
			pointRadius: 0,
			order: 0,
		});
	} else {
		var diseaseNames = Object.keys(scoutingData.diseases || {}).sort();
		diseaseNames.forEach(function (d, idx) {
			var weeklyCounts = new Array(axis.labels.length).fill(0);
			(scoutingData.diseases[d].counts || []).forEach(function (c) {
				if (section && c.section !== section) return;
				var k = getIsoWeekString(new Date(c.date + "T00:00:00Z"));
				var i = weekIndex[k];
				if (i === undefined) return;
				weeklyCounts[i] += 1;
			});

			var total = weeklyCounts.reduce(function (a, b) {
				return a + b;
			}, 0);
			if (total <= 0) return;

			var palette = getPaletteColor(idx);
			var accent = observationColors.diseases[d] || palette.border;
			datasets.push({
				label: d,
				data: weeklyCounts,
				borderColor: accent,
				backgroundColor: palette.background,
				borderWidth: 2,
				fill: false,
				tension: 0.35,
				pointRadius: 0,
				order: idx,
			});
		});
	}

	diseaseWeeklyTrendChart = new Chart(ctx, {
		type: "line",
		data: {
			labels: weekLabels,
			datasets: datasets,
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: {
					display: datasets.length > 1,
					position: "bottom",
					labels: { boxWidth: 10, boxHeight: 10, padding: 10, font: { size: 10 } },
				},
				tooltip: {
					mode: "index",
					intersect: false,
					callbacks: {
						title: function (items) {
							var idx = items?.[0]?.dataIndex;
							if (idx === undefined) return "";
							if (axis.sameYear)
								return "Week " + axis.labels[idx] + " (" + axis.year + ")";
							return axis.keys[idx];
						},
					},
				},
			},
			scales: {
				x: {
					grid: { display: false },
					ticks: { autoSkip: true, maxTicksLimit: 13 },
				},
				y: { beginAtZero: true, grid: { color: "rgba(0,0,0,0.04)" } },
			},
		},
	});
}

function updateDiseaseDistributionChart() {
	var ctx = root_element.querySelector("#disease-distribution-chart");
	if (diseaseDistChart) diseaseDistChart.destroy();

	var diseases = scoutingData.diseases;
	var labels = Object.keys(diseases).slice(0, 10);
	var data = labels.map((d) => diseases[d].counts.length);
	var palette = [
		"#f59e0b",
		"#ef4444",
		"#8b5cf6",
		"#10b981",
		"#3b82f6",
		"#ec4899",
		"#14b8a6",
		"#f97316",
		"#6366f1",
		"#06b6d4",
	];
	var colors = labels.map(
		(label, idx) => observationColors.diseases[label] || palette[idx % palette.length],
	);

	diseaseDistChart = new Chart(ctx, {
		type: "bar",
		data: {
			labels: labels,
			datasets: [
				{
					label: "Observations",
					data: data,
					backgroundColor: colors,
					borderRadius: 4,
				},
			],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: { display: false },
			},
			scales: {
				y: { beginAtZero: true, grid: { color: "rgba(0,0,0,0.04)" } },
			},
		},
	});
}

function updateDiseaseSeverityBubbles() {
	var container = root_element.querySelector("#disease-severity-bubbles");
	var diseases = scoutingData.diseases;

	var html = Object.keys(diseases)
		.slice(0, 12)
		.map((disease) => {
			var d = diseases[disease];
			var total = d.counts.length;
			var highPct = total > 0 ? d.severity.high / total : 0;
			var size = 60 + total * 2;
			size = Math.min(size, 120);

			return `
            <div class="bubble-item">
                <div class="bubble" style="width: ${size}px; height: ${size}px; background: ${
					highPct > 0.5 ? "#ef4444" : highPct > 0.2 ? "#f59e0b" : "#10b981"
				}">
                    <span>${Math.round(highPct * 100)}%</span>
                </div>
                <div class="bubble-label">${disease}</div>
                <div class="bubble-sub">${total} cases</div>
            </div>
        `;
		})
		.join("");

	container.innerHTML = html || '<div class="empty-state">No disease data available</div>';
}

function updateDiseaseStageChart() {
	var ctx = root_element.querySelector("#disease-stage-chart");
	if (diseaseStageChart) diseaseStageChart.destroy();

	var stages = {};
	Object.keys(scoutingData.diseases).forEach((disease) => {
		Object.keys(scoutingData.diseases[disease].stages).forEach((stage) => {
			if (!stages[stage]) stages[stage] = 0;
			stages[stage] += scoutingData.diseases[disease].stages[stage];
		});
	});

	var labels = Object.keys(stages);
	var data = Object.values(stages);

	diseaseStageChart = new Chart(ctx, {
		type: "doughnut",
		data: {
			labels: labels,
			datasets: [
				{
					data: data,
					backgroundColor: ["#f59e0b", "#3b82f6", "#ef4444", "#10b981", "#8b5cf6"],
				},
			],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: { position: "bottom" },
			},
		},
	});
}

function updateDiseaseIncidentsTable() {
	var tbody = root_element.querySelector("#disease-incidents-body");
	var incidents = [];

	Object.keys(scoutingData.diseases).forEach((disease) => {
		scoutingData.diseases[disease].counts.slice(0, 20).forEach((c) => {
			incidents.push({
				disease: disease,
				stage: c.stage || "N/A",
				severity: c.stage && c.stage.includes("Active") ? "High" : "Low",
				section: c.section || "N/A",
				date: c.date,
				greenhouse: c.greenhouse,
			});
		});
	});

	incidents.sort((a, b) => new Date(b.date) - new Date(a.date));
	incidents = incidents.slice(0, 50);

	if (incidents.length === 0) {
		tbody.innerHTML =
			'<tr><td colspan="6" class="empty-state">No disease incidents found</td></tr>';
		return;
	}

	tbody.innerHTML = incidents
		.map(
			(i) => `
        <tr>
            <td><span class="pest-badge">${i.disease}</span></td>
            <td>${i.stage}</td>
            <td><span class="severity-tag ${i.severity.toLowerCase()}">${i.severity}</span></td>
            <td>${i.section}</td>
            <td>${i.date}</td>
            <td>${i.greenhouse || "-"}</td>
        </tr>
    `,
		)
		.join("");
}

function updateTrapTab() {
	if (!scoutingData) return;

	var traps = scoutingData.traps;
	var trapKeys = Object.keys(traps);

	var totalEntries = trapKeys.reduce((sum, t) => sum + (traps[t].counts?.length || 0), 0);
	var totalCount = trapKeys.reduce((sum, t) => sum + traps[t].total, 0);
	var activeTraps = new Set(trapKeys.map((t) => traps[t].trap)).size;
	var fcmCount = trapKeys.reduce(
		(sum, t) => sum + (traps[t].pest === "FCM" ? traps[t].total : 0),
		0,
	);
	var avgPerTrap = activeTraps > 0 ? (totalCount / activeTraps).toFixed(1) : 0;

	root_element.querySelector("#trap-total-count").textContent = formatNumber(totalEntries);
	root_element.querySelector("#trap-active-count").textContent = activeTraps;
	root_element.querySelector("#trap-fcm-count").textContent = formatNumber(fcmCount);
	root_element.querySelector("#trap-avg-count").textContent = avgPerTrap;

	updateTrapTrendChart();
	updateTrapWeeklyTrend();

	updateTrapPerformanceChart();

	updateTrapHeatmap();

	updateTrapPestChart();

	updateTrapDetailsTable();
}

function updateTrapTrendChart() {
	var ctx = root_element.querySelector("#trap-trend-chart");
	if (trapTrendChart) trapTrendChart.destroy();

	var dates = Object.keys(scoutingData.daily).sort();
	var trapCounts = dates.map((d) => scoutingData.daily[d].traps);

	trapTrendChart = new Chart(ctx, {
		type: "line",
		data: {
			labels: dates.map((d) => d.slice(5)),
			datasets: [
				{
					label: "Trap Counts",
					data: trapCounts,
					borderColor: "#3b82f6",
					backgroundColor: "rgba(59, 130, 246, 0.1)",
					borderWidth: 2,
					fill: true,
					tension: 0.4,
					pointRadius: 4,
					pointBackgroundColor: "#3b82f6",
				},
			],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: { display: false },
			},
			scales: {
				x: { grid: { display: false } },
				y: { beginAtZero: true, grid: { color: "rgba(0,0,0,0.04)" } },
			},
		},
	});
}

function updateTrapWeeklyTrend() {
	var trapSelect = root_element.querySelector("#trap-weekly-trap-filter");
	var pestSelect = root_element.querySelector("#trap-weekly-pest-filter");
	if (!trapSelect || !pestSelect) return;
	if (!scoutingYearData) return;

	var trapsSet = new Set();
	var pestsSet = new Set();
	Object.values(scoutingYearData.traps || {}).forEach(function (t) {
		if (t.trap) trapsSet.add(t.trap);
		if (t.pest) pestsSet.add(t.pest);
	});

	var traps = Array.from(trapsSet).sort();
	var pests = Array.from(pestsSet).sort();

	setSelectOptions(
		trapSelect,
		[{ value: "", label: "All Traps" }].concat(
			traps.map(function (t) {
				return { value: t, label: t };
			}),
		),
	);
	setSelectOptions(
		pestSelect,
		[{ value: "", label: "All Pests" }].concat(
			pests.map(function (p) {
				return { value: p, label: p };
			}),
		),
	);

	updateTrapWeeklyTrendChart();
}

function updateTrapWeeklyTrendChart() {
	var ctx = root_element.querySelector("#trap-weekly-trend-chart");
	if (!ctx) return;
	if (trapWeeklyTrendChart) trapWeeklyTrendChart.destroy();
	if (!scoutingData) return;

	var rangeInfo = getSelectedWeekRangeInfo();
	if (!rangeInfo) return;
	var axis = getWeekRangeAxis(rangeInfo);
	if (!axis) return;
	var weekIndex = {};
	axis.keys.forEach(function (k, idx) {
		weekIndex[k] = idx;
	});

	var trapName = root_element.querySelector("#trap-weekly-trap-filter")?.value || "";
	var pestName = root_element.querySelector("#trap-weekly-pest-filter")?.value || "";

	var weekLabels = axis.labels;
	var datasets = [];

	if (pestName) {
		var weeklyCounts = new Array(axis.labels.length).fill(0);
		Object.keys(scoutingData.traps || {}).forEach(function (k) {
			var t = scoutingData.traps[k];
			if (!t) return;
			if (trapName && t.trap !== trapName) return;
			if (t.pest !== pestName) return;

			(t.counts || []).forEach(function (c) {
				var wk = getIsoWeekString(new Date(c.date + "T00:00:00Z"));
				var i = weekIndex[wk];
				if (i === undefined) return;
				weeklyCounts[i] += Number(c.count || 0);
			});
		});

		var accent = observationColors.pests[pestName] || "#3b82f6";
		var label = trapName ? trapName : "All Traps";
		label += " (" + pestName + ")";

		datasets.push({
			label: label,
			data: weeklyCounts,
			borderColor: accent,
			backgroundColor: "rgba(59, 130, 246, 0.1)",
			borderWidth: 2,
			fill: false,
			tension: 0.35,
			pointRadius: 0,
			order: 0,
		});
	} else {
		var weeklyByPest = {};
		Object.keys(scoutingData.traps || {}).forEach(function (k) {
			var t = scoutingData.traps[k];
			if (!t) return;
			if (trapName && t.trap !== trapName) return;
			var pest = t.pest || "Unknown";
			if (!weeklyByPest[pest]) weeklyByPest[pest] = new Array(axis.labels.length).fill(0);

			(t.counts || []).forEach(function (c) {
				var wk = getIsoWeekString(new Date(c.date + "T00:00:00Z"));
				var i = weekIndex[wk];
				if (i === undefined) return;
				weeklyByPest[pest][i] += Number(c.count || 0);
			});
		});

		Object.keys(weeklyByPest)
			.sort()
			.forEach(function (p, idx) {
				var weeklyCounts = weeklyByPest[p];
				var total = weeklyCounts.reduce(function (a, b) {
					return a + b;
				}, 0);
				if (total <= 0) return;

				var palette = getPaletteColor(idx);
				var accent = observationColors.pests[p] || palette.border;
				datasets.push({
					label: p,
					data: weeklyCounts,
					borderColor: accent,
					backgroundColor: palette.background,
					borderWidth: 2,
					fill: false,
					tension: 0.35,
					pointRadius: 0,
					order: idx,
				});
			});
	}

	trapWeeklyTrendChart = new Chart(ctx, {
		type: "line",
		data: {
			labels: weekLabels,
			datasets: datasets,
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: {
					display: datasets.length > 1,
					position: "bottom",
					labels: { boxWidth: 10, boxHeight: 10, padding: 10, font: { size: 10 } },
				},
				tooltip: {
					mode: "index",
					intersect: false,
					callbacks: {
						title: function (items) {
							var idx = items?.[0]?.dataIndex;
							if (idx === undefined) return "";
							if (axis.sameYear)
								return "Week " + axis.labels[idx] + " (" + axis.year + ")";
							return axis.keys[idx];
						},
					},
				},
			},
			scales: {
				x: {
					grid: { display: false },
					ticks: { autoSkip: true, maxTicksLimit: 13 },
				},
				y: { beginAtZero: true, grid: { color: "rgba(0,0,0,0.04)" } },
			},
		},
	});
}

function updateTrapPerformanceChart() {
	var ctx = root_element.querySelector("#trap-performance-chart");
	if (trapPerfChart) trapPerfChart.destroy();

	var locations = {};
	Object.keys(scoutingData.traps).forEach((trap) => {
		var loc = scoutingData.traps[trap].location || "Unknown";
		if (!locations[loc]) locations[loc] = 0;
		locations[loc] += scoutingData.traps[trap].total;
	});

	var labels = Object.keys(locations).slice(0, 10);
	var data = labels.map((l) => locations[l]);

	trapPerfChart = new Chart(ctx, {
		type: "bar",
		data: {
			labels: labels,
			datasets: [
				{
					label: "Total Count",
					data: data,
					backgroundColor: "#3b82f6",
					borderRadius: 4,
				},
			],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: { display: false },
			},
			scales: {
				y: { beginAtZero: true, grid: { color: "rgba(0,0,0,0.04)" } },
			},
		},
	});
}

function updateTrapHeatmap() {
	var container = root_element.querySelector("#trap-heatmap");
	var locations = {};

	Object.keys(scoutingData.traps).forEach((trap) => {
		var loc = scoutingData.traps[trap].location || "Unknown";
		if (!locations[loc]) locations[loc] = 0;
		locations[loc] += scoutingData.traps[trap].total;
	});

	var max = Math.max(...Object.values(locations), 1);

	var html = Object.keys(locations)
		.slice(0, 12)
		.map((loc) => {
			var count = locations[loc];
			var intensity = (count / max) * 100;
			var bgColor =
				count > max * 0.7 ? "#ef4444" : count > max * 0.4 ? "#f59e0b" : "#10b981";

			return `
            <div class="heatmap-cell">
                <div class="heatmap-location">${loc}</div>
                <div class="heatmap-value">${count}</div>
                <div class="heatmap-indicator" style="background: ${bgColor}; width: ${intensity}%"></div>
            </div>
        `;
		})
		.join("");

	container.innerHTML = html || '<div class="empty-state">No trap location data</div>';
}

function updateTrapPestChart() {
	var ctx = root_element.querySelector("#trap-pest-breakdown");
	if (trapPestChart) trapPestChart.destroy();

	var pests = {};
	Object.keys(scoutingData.traps).forEach((trap) => {
		var pest = scoutingData.traps[trap].pest || "Unknown";
		if (!pests[pest]) pests[pest] = 0;
		pests[pest] += scoutingData.traps[trap].total;
	});

	var labels = Object.keys(pests).slice(0, 10);
	var data = labels.map((p) => pests[p]);
	var colors = [
		"#3b82f6",
		"#ef4444",
		"#10b981",
		"#f59e0b",
		"#8b5cf6",
		"#ec4899",
		"#14b8a6",
		"#f97316",
		"#6366f1",
		"#06b6d4",
	];

	trapPestChart = new Chart(ctx, {
		type: "doughnut",
		data: {
			labels: labels,
			datasets: [
				{
					data: data,
					backgroundColor: colors.slice(0, labels.length),
				},
			],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: { position: "bottom" },
			},
		},
	});
}

function updateTrapDetailsTable() {
	var tbody = root_element.querySelector("#trap-details-body");
	var details = [];

	Object.keys(scoutingData.traps).forEach((trap) => {
		scoutingData.traps[trap].counts.slice(0, 20).forEach((c) => {
			details.push({
				trap: scoutingData.traps[trap].trap,
				pest: scoutingData.traps[trap].pest,
				count: c.count || 0,
				location: c.location || "N/A",
				date: c.date,
				greenhouse: c.greenhouse,
			});
		});
	});

	details.sort((a, b) => new Date(b.date) - new Date(a.date));
	details = details.slice(0, 50);

	if (details.length === 0) {
		tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No trap data found</td></tr>';
		return;
	}

	tbody.innerHTML = details
		.map(
			(d) => `
        <tr>
            <td>${d.trap}</td>
            <td>${d.pest}</td>
            <td><strong>${d.count}</strong></td>
            <td>${d.location}</td>
            <td>${d.date}</td>
            <td>${d.greenhouse || "-"}</td>
        </tr>
    `,
		)
		.join("");
}

function updateOverviewTab() {
	if (!scoutingData) return;

	var scoutNamesSet = new Set();
	scoutingData.entries.forEach(function (e) {
		var scoutInfo = getScoutIdentity(e);
		if (scoutInfo?.label) scoutNamesSet.add(scoutInfo.label);
	});
	var scoutNames = Array.from(scoutNamesSet).sort();
	var totalScouts = scoutNames.length;
	var totalEntries = scoutingData.entries.length;
	var greenhouseCount = Object.keys(scoutingData.greenhouses).length;
	var alerts = Object.keys(scoutingData.greenhouses).reduce(
		(sum, gh) => sum + scoutingData.greenhouses[gh].alerts,
		0,
	);

	root_element.querySelector("#overview-total-scouts").textContent = totalScouts;
	var scoutNamesEl = root_element.querySelector("#overview-scout-names");
	if (scoutNamesEl) {
		if (scoutNames.length <= 8) {
			scoutNamesEl.textContent = scoutNames.join(", ") || "—";
		} else {
			scoutNamesEl.textContent =
				scoutNames.slice(0, 8).join(", ") + " +" + (scoutNames.length - 8) + " more";
		}
	}
	root_element.querySelector("#overview-total-entries").textContent = formatNumber(totalEntries);
	root_element.querySelector("#overview-greenhouses").textContent = greenhouseCount;
	root_element.querySelector("#overview-alerts").textContent = alerts;

	updateOverviewTimelineChart();

	updateOverviewDonutChart();

	updateOverviewAreaRadarChart();

	updateGreenhouseHealth();

	updateAlertsList();

	updateTopScouts();

	updateRecentEntries();
}

function updateOverviewTimelineChart() {
	var ctx = root_element.querySelector("#overview-timeline-chart");
	if (overviewTimelineChart) overviewTimelineChart.destroy();

	var dates = Object.keys(scoutingData.daily).sort();
	var pestData = dates.map((d) => scoutingData.daily[d].pests);
	var diseaseData = dates.map((d) => scoutingData.daily[d].diseases);
	var trapData = dates.map((d) => scoutingData.daily[d].traps);

	overviewTimelineChart = new Chart(ctx, {
		type: "line",
		data: {
			labels: dates.map((d) => d.slice(5)),
			datasets: [
				{
					label: "Pests",
					data: pestData,
					borderColor: "#10b981",
					backgroundColor: "rgba(16, 185, 129, 0.1)",
					tension: 0.4,
				},
				{
					label: "Diseases",
					data: diseaseData,
					borderColor: "#f59e0b",
					backgroundColor: "rgba(245, 158, 11, 0.1)",
					tension: 0.4,
				},
				{
					label: "Traps",
					data: trapData,
					borderColor: "#3b82f6",
					backgroundColor: "rgba(59, 130, 246, 0.1)",
					tension: 0.4,
				},
			],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: { position: "bottom" },
			},
			scales: {
				x: { grid: { display: false } },
				y: { beginAtZero: true, grid: { color: "rgba(0,0,0,0.04)" } },
			},
		},
	});
}

function updateOverviewDonutChart() {
	var ctx = root_element.querySelector("#overview-donut-chart");
	if (overviewDonutChart) overviewDonutChart.destroy();

	var accent = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
	if (!accent) accent = "#030303";
	var gray600 = getComputedStyle(document.documentElement).getPropertyValue("--gray-600").trim();
	if (!gray600) gray600 = "#4b5563";
	var gray400 = getComputedStyle(document.documentElement).getPropertyValue("--gray-400").trim();
	if (!gray400) gray400 = "#9ca3af";

	var totalPests = Object.values(scoutingData.pests).reduce(
		(sum, p) => sum + p.counts.length,
		0,
	);
	var totalDiseases = Object.values(scoutingData.diseases).reduce(
		(sum, d) => sum + d.counts.length,
		0,
	);
	var totalTraps = Object.values(scoutingData.traps).reduce((sum, t) => sum + t.total, 0);
	var total = totalPests + totalDiseases + totalTraps;

	root_element.querySelector("#overview-donut-total").textContent = formatNumber(total);

	overviewDonutChart = new Chart(ctx, {
		type: "doughnut",
		data: {
			labels: ["Pests", "Diseases", "Traps"],
			datasets: [
				{
					data: [totalPests, totalDiseases, totalTraps],
					backgroundColor: [accent, gray600, gray400],
					borderWidth: 0,
				},
			],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			cutout: "70%",
			plugins: {
				legend: { position: "bottom" },
			},
		},
	});
}

function updateOverviewAreaRadarChart() {
	var ctx = root_element.querySelector("#overview-area-radar-chart");
	if (!ctx) return;
	if (overviewAreaRadarChart) overviewAreaRadarChart.destroy();

	var accent = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
	if (!accent) accent = "#030303";
	var gray600 = getComputedStyle(document.documentElement).getPropertyValue("--gray-600").trim();
	if (!gray600) gray600 = "#4b5563";

	var pestTotals = {};
	Object.values(scoutingData.pests).forEach((p) => {
		Object.keys(p.sections || {}).forEach((section) => {
			pestTotals[section] = (pestTotals[section] || 0) + (p.sections[section] || 0);
		});
	});

	var diseaseTotals = {};
	Object.values(scoutingData.diseases).forEach((d) => {
		(d.counts || []).forEach((c) => {
			var section = c.section || "Unknown";
			diseaseTotals[section] = (diseaseTotals[section] || 0) + 1;
		});
	});

	var allSections = Array.from(
		new Set([...Object.keys(pestTotals), ...Object.keys(diseaseTotals)]),
	).map((section) => ({
		section,
		total: (pestTotals[section] || 0) + (diseaseTotals[section] || 0),
	}));

	allSections.sort((a, b) => b.total - a.total);
	var topSections = allSections.slice(0, 8);
	var labels = topSections.map((s) => s.section);
	var pestData = labels.map((s) => pestTotals[s] || 0);
	var diseaseData = labels.map((s) => diseaseTotals[s] || 0);

	overviewAreaRadarChart = new Chart(ctx, {
		type: "radar",
		data: {
			labels: labels,
			datasets: [
				{
					label: "Pests",
					data: pestData,
					borderColor: accent,
					backgroundColor: "rgba(79, 70, 229, 0.12)",
					pointBackgroundColor: accent,
					borderWidth: 2,
				},
				{
					label: "Diseases",
					data: diseaseData,
					borderColor: gray600,
					backgroundColor: "rgba(75, 85, 99, 0.12)",
					pointBackgroundColor: gray600,
					borderWidth: 2,
				},
			],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: { legend: { position: "bottom" } },
			scales: {
				r: {
					beginAtZero: true,
					grid: { color: "rgba(0,0,0,0.12)" },
					angleLines: { color: "rgba(0,0,0,0.12)" },
					pointLabels: { color: "#111111", font: { size: 11 } },
					ticks: { color: "rgba(0,0,0,0.7)", backdropColor: "transparent" },
				},
			},
		},
	});
}

function updateGreenhouseHealth() {
	var container = root_element.querySelector("#overview-gh-health");
	var greenhouses = Object.values(scoutingData.greenhouses);

	var html = greenhouses
		.map((gh) => {
			var total = gh.pests + gh.diseases + gh.traps;
			var healthStatus = total > 50 ? "critical" : total > 20 ? "warning" : "good";

			return `
            <div class="gh-health-item" data-greenhouse="${gh.name}">
                <div class="gh-health-status ${healthStatus}"></div>
                <div class="gh-health-name">${gh.name}</div>
                <div class="gh-health-stats">
                    <span>${gh.pests} pests</span>
                    <span>${gh.diseases} diseases</span>
                    <span>${gh.traps} traps</span>
                </div>
            </div>
        `;
		})
		.join("");

	container.innerHTML = html || '<div class="empty-state">No greenhouse data</div>';

	root_element.querySelectorAll(".gh-health-item").forEach((item) => {
		item.addEventListener("click", function () {
			var greenhouse = this.dataset.greenhouse;
			showGreenhouseDetails(greenhouse);
		});
	});
}

function updateAlertsList() {
	var container = root_element.querySelector("#overview-alerts-list");
	var alerts = [];

	Object.keys(scoutingData.pests).forEach((pest) => {
		var p = scoutingData.pests[pest];
		if (p.severity.high > 5) {
			alerts.push({
				type: "pest",
				title: pest + " outbreak",
				count: p.severity.high,
				severity: "high",
			});
		}
	});

	Object.keys(scoutingData.diseases).forEach((disease) => {
		var d = scoutingData.diseases[disease];
		if (d.severity.high > 3) {
			alerts.push({
				type: "disease",
				title: disease + " severe cases",
				count: d.severity.high,
				severity: "high",
			});
		}
	});

	alerts = alerts.slice(0, 5);

	if (alerts.length === 0) {
		container.innerHTML = '<div class="empty-state">No active alerts</div>';
		return;
	}

	container.innerHTML = alerts
		.map(
			(a) => `
        <div class="alert-item">
            <div class="alert-icon">⚠️</div>
            <div class="alert-content">
                <div class="alert-title">${a.title}</div>
                <div class="alert-meta">
                    <span class="alert-severity ${a.severity}">${a.severity}</span>
                    <span>${a.count} cases</span>
                </div>
            </div>
        </div>
    `,
		)
		.join("");
}

function updateTopScouts() {
	var container = root_element.querySelector("#overview-top-scouts");
	var scouts = Object.values(scoutingData.scouts);

	scouts.sort((a, b) => b.entries - a.entries);
	scouts = scouts.slice(0, 5);

	if (scouts.length === 0) {
		container.innerHTML = '<div class="empty-state">No scout data</div>';
		return;
	}

	container.innerHTML = scouts
		.map((s, i) => {
			var rankClass = i === 0 ? "first" : i === 1 ? "second" : i === 2 ? "third" : "";

			return `
            <div class="item-row">
                <div class="item-rank ${rankClass}">${i + 1}</div>
                <div class="item-info">
                    <div class="item-name">${s.name || "Unknown"}</div>
                    <div class="item-meta">${s.entries} entries</div>
                </div>
            </div>
        `;
		})
		.join("");
}

function updateRecentEntries() {
	var container = root_element.querySelector("#overview-recent-entries");
	var entries = scoutingData.entries.slice(0, 10);

	if (entries.length === 0) {
		container.innerHTML = '<div class="empty-state">No recent entries</div>';
		return;
	}

	container.innerHTML = entries
		.map((e) => {
			var type = e.pests_scouting_entry?.length
				? "pest"
				: e.diseases_scouting_entry?.length
					? "disease"
					: "trap";
			var typeLabel = type === "pest" ? "Pest" : type === "disease" ? "Disease" : "Trap";
			var scoutLabel = getScoutIdentity(e)?.label || "Unknown scout";

			return `
            <div class="recent-entry">
                <div class="entry-type ${type}"></div>
                <div class="entry-info">
                    <div class="entry-title">${e.greenhouse || "Unknown"}</div>
                    <div class="entry-details">
                        <span>${typeLabel}</span>
                        <span>${scoutLabel}</span>
                    </div>
                </div>
                <div class="entry-time">${e.date_of_capture}</div>
            </div>
        `;
		})
		.join("");
}

function showGreenhouseDetails(greenhouse) {
	var ghData = scoutingData.greenhouses[greenhouse];
	if (!ghData) return;

	root_element.querySelector("#scout-gh-modal-title").textContent = greenhouse;

	var rangeInfo = getSelectedWeekRangeInfo();
	var fromWeek = rangeInfo?.from?.value || getIsoWeekString(new Date());
	var toWeek = rangeInfo?.to?.value || getIsoWeekString(new Date());
	root_element.querySelector("#scout-gh-modal-period").textContent =
		fromWeek + " to " + toWeek + " (" + rangeInfo.fromDate + " to " + rangeInfo.toDate + ")";

	root_element.querySelector("#ghk-pests").textContent = ghData.pests;
	root_element.querySelector("#ghk-diseases").textContent = ghData.diseases;
	root_element.querySelector("#ghk-traps").textContent = ghData.traps;
	root_element.querySelector("#ghk-scouts").textContent = ghData.scoutCount;
	root_element.querySelector("#ghk-alerts").textContent = ghData.alerts;

	var pestCounts = {};
	Object.keys(scoutingData.pests).forEach((pest) => {
		var counts = scoutingData.pests[pest].counts.filter((c) => c.greenhouse === greenhouse);
		if (counts.length) pestCounts[pest] = counts.length;
	});

	var pestHtml = Object.keys(pestCounts)
		.slice(0, 5)
		.map(
			(pest) => `
        <div class="gh-var-row">
            <div class="gh-var-name">${pest}</div>
            <div class="gh-var-count">${pestCounts[pest]}</div>
        </div>
    `,
		)
		.join("");

	root_element.querySelector("#scout-gh-pests").innerHTML =
		pestHtml || '<div style="padding:12px;color:var(--text-muted)">No pest data</div>';

	var diseaseCounts = {};
	Object.keys(scoutingData.diseases).forEach((disease) => {
		var counts = scoutingData.diseases[disease].counts.filter(
			(c) => c.greenhouse === greenhouse,
		);
		if (counts.length) diseaseCounts[disease] = counts.length;
	});

	var diseaseHtml = Object.keys(diseaseCounts)
		.slice(0, 5)
		.map(
			(disease) => `
        <div class="gh-disease-row">
            <div class="gh-disease-name">${disease}</div>
            <div class="gh-disease-count">${diseaseCounts[disease]}</div>
        </div>
    `,
		)
		.join("");

	root_element.querySelector("#scout-gh-diseases").innerHTML =
		diseaseHtml || '<div style="padding:12px;color:var(--text-muted)">No disease data</div>';

	var trapCounts = {};
	Object.keys(scoutingData.traps).forEach((trap) => {
		var counts = scoutingData.traps[trap].counts.filter((c) => c.greenhouse === greenhouse);
		if (counts.length) {
			var name = scoutingData.traps[trap].trap;
			if (!trapCounts[name]) trapCounts[name] = 0;
			trapCounts[name] += scoutingData.traps[trap].total;
		}
	});

	var trapHtml = Object.keys(trapCounts)
		.slice(0, 8)
		.map(
			(trap) => `
        <div class="gh-len-item">
            <div class="gh-len-val">${trapCounts[trap]}</div>
            <div class="gh-len-lbl">${trap}</div>
        </div>
    `,
		)
		.join("");

	root_element.querySelector("#scout-gh-traps").innerHTML =
		trapHtml || '<div style="padding:12px;color:var(--text-muted)">No trap data</div>';

	updateGreenhouseTrendChart(greenhouse);

	root_element.querySelector("#scout-gh-modal").classList.add("active");
}

function updateGreenhouseTrendChart(greenhouse) {
	var ctx = root_element.querySelector("#scout-gh-trend-chart");
	if (window.ghTrendChart) window.ghTrendChart.destroy();

	var dailyData = {};
	scoutingData.entries.forEach((entry) => {
		if (entry.greenhouse === greenhouse) {
			var date = entry.date_of_capture;
			if (!dailyData[date]) dailyData[date] = { pests: 0, diseases: 0, traps: 0 };
			dailyData[date].pests += entry.pests_scouting_entry?.length || 0;
			dailyData[date].diseases += entry.diseases_scouting_entry?.length || 0;
			dailyData[date].traps += entry.trap_scouting_entry?.length || 0;
		}
	});

	var dates = Object.keys(dailyData).sort().slice(-14);
	var pestData = dates.map((d) => dailyData[d].pests);
	var diseaseData = dates.map((d) => dailyData[d].diseases);
	var trapData = dates.map((d) => dailyData[d].traps);

	window.ghTrendChart = new Chart(ctx, {
		type: "line",
		data: {
			labels: dates.map((d) => d.slice(5)),
			datasets: [
				{ label: "Pests", data: pestData, borderColor: "#10b981", tension: 0.4 },
				{ label: "Diseases", data: diseaseData, borderColor: "#f59e0b", tension: 0.4 },
				{ label: "Traps", data: trapData, borderColor: "#3b82f6", tension: 0.4 },
			],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: { position: "bottom" },
			},
			scales: {
				x: { grid: { display: false } },
				y: { beginAtZero: true, grid: { color: "rgba(0,0,0,0.04)" } },
			},
		},
	});
}

function closeScoutModal() {
	root_element.querySelector("#scout-gh-modal").classList.remove("active");
}

function formatNumber(num) {
	if (num === null || num === undefined) return "0";
	num = Number(num);
	if (num >= 1000000) return (num / 1000000).toFixed(1) + "M";
	if (num >= 1000) return (num / 1000).toFixed(1) + "K";
	return num.toString();
}
