/* ================================================================
 *  SCOUTING DASHBOARD  –  Full Rewrite
 *  Includes:  Reports dropdown (5 CSV exports), UI polish,
 *             bug-fixes (normalizeFocusName .trim() typo, etc.)
 * ================================================================ */

var root_element =
	document.getElementById("scouting-dashboard-root") || document;

/* ---------- Chart.js bootstrap ---------- */
if (typeof Chart === "undefined") {
	var script = document.createElement("script");
	script.src =
		"https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";
	script.onload = initScoutingDashboard;
	document.head.appendChild(script);
} else {
	initScoutingDashboard();
}

/* ==========  GLOBAL STATE  ========== */

var pestTrendChart,
	pestDistChart,
	pestSectionChart;
var diseaseTrendChart,
	diseaseDistChart,
	diseaseStageChart;
var trapTrendChart,
	trapPerfChart,
	trapPestChart;
var pestWeeklyTrendChart,
	diseaseWeeklyTrendChart,
	trapWeeklyTrendChart;
var overviewTimelineChart,
	overviewDonutChart,
	overviewAreaRadarChart;

var scoutingData = null;
var scoutingYearData = null;
var greenhouseFilter = "";
var farmFilter = "";
var allGreenhouses = [];
var activeTab = "overview";          // default to overview on load
var scoutingAnalysis = null;
var observationColors = { pests: {}, diseases: {} };

var SCOUTING_DASHBOARD_DEBUG = true;

if (SCOUTING_DASHBOARD_DEBUG)
	console.log("Scouting dashboard: script loaded", { root_element: root_element });

/* ==========  UTILITY FUNCTIONS  ========== */

function notifyUser(message) {
	if (window.frappe && typeof window.frappe.msgprint === "function") {
		window.frappe.msgprint(message);
		return;
	}
	alert(message);
}

function getFarmFromGreenhouseName(greenhouseName) {
	var gh = (greenhouseName || "").toString().trim();
	if (!gh) return "";
	var match = gh.match(/^(.+?)\s+GH\s*\d+/i);
	if (match && match[1]) return match[1].trim();
	var parts = gh.split(/\s+GH\s+/i);
	if (parts.length > 1) return parts[0].trim();
	return "";
}

function applyFarmFilterToEntries(entries) {
	if (!farmFilter) return entries;
	return (Array.isArray(entries) ? entries : []).filter(function (e) {
		return getFarmFromGreenhouseName(e?.greenhouse) === farmFilter;
	});
}

function clearSelectOptions(selectEl, keepFirstOption) {
	if (!selectEl) return;
	var startIdx = keepFirstOption ? 1 : 0;
	while (selectEl.options.length > startIdx) selectEl.remove(startIdx);
}

function renderFarmOptions() {
	var select = root_element.querySelector("#scout-farm-filter");
	if (!select) return;
	var existingValue = select.value || "";
	clearSelectOptions(select, true);
	var farms = Array.from(
		new Set(
			(allGreenhouses || [])
				.map(function (gh) { return getFarmFromGreenhouseName(gh); })
				.filter(Boolean)
		)
	).sort();
	farms.forEach(function (farm) {
		var opt = document.createElement("option");
		opt.value = farm;
		opt.textContent = farm;
		select.appendChild(opt);
	});
	select.value =
		existingValue && farms.includes(existingValue)
			? existingValue
			: farmFilter && farms.includes(farmFilter)
				? farmFilter
				: "";
}

function renderGreenhouseOptionsForFarm() {
	var select = root_element.querySelector("#scout-greenhouse-filter");
	if (!select) return;
	var existingValue = select.value || "";
	clearSelectOptions(select, true);
	var filtered = (allGreenhouses || []).filter(function (gh) {
		return !farmFilter || getFarmFromGreenhouseName(gh) === farmFilter;
	});
	filtered.sort().forEach(function (gh) {
		var opt = document.createElement("option");
		opt.value = gh;
		opt.textContent = gh;
		select.appendChild(opt);
	});
	if (existingValue && filtered.includes(existingValue)) {
		select.value = existingValue;
	} else {
		select.value = "";
		greenhouseFilter = "";
	}
}

function updateGreenhouseSelectState() {
	var ghSelect = root_element.querySelector("#scout-greenhouse-filter");
	if (!ghSelect) return;
	if (!farmFilter) {
		ghSelect.disabled = true;
		if (ghSelect.options.length > 0) ghSelect.options[0].textContent = "Select farm first";
	} else {
		ghSelect.disabled = false;
		if (ghSelect.options.length > 0) ghSelect.options[0].textContent = "All Greenhouses";
	}
}

function isNumericId(value) {
	if (value == null) return false;
	return /^[0-9]+$/.test(String(value).trim());
}

function toNumber(value) {
	if (value == null || value === "") return 0;
	var n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

function titleCaseWords(str) {
	return String(str)
		.split(/\s+/)
		.filter(Boolean)
		.map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); })
		.join(" ");
}

function scoutLabelFromEmail(email) {
	if (!email) return "";
	var raw = String(email).trim();
	var local = raw.includes("@") ? raw.split("@")[0] : raw;
	return titleCaseWords(local.replace(/[._-]+/g, " ").trim()) || raw;
}

function getScoutIdentity(entry) {
	var owner = entry?.owner ? String(entry.owner).trim() : "";
	var modifiedBy = entry?.modified_by ? String(entry.modified_by).trim() : "";
	var explicitName =
		(entry?.scout_name ? String(entry.scout_name).trim() : "") ||
		(entry?.scout ? String(entry.scout).trim() : "");
	var named =
		explicitName ||
		(entry?.scouts_name ? String(entry.scouts_name).trim() : "");
	var emailCandidate = owner.includes("@")
		? owner
		: modifiedBy.includes("@")
			? modifiedBy
			: "";

	if (explicitName && !isNumericId(explicitName))
		return { key: explicitName, label: explicitName };
	if (named && !isNumericId(named))
		return { key: named, label: named };
	if (emailCandidate)
		return { key: emailCandidate.toLowerCase(), label: scoutLabelFromEmail(emailCandidate) };
	if (named && isNumericId(named))
		return { key: named, label: named };
	if (modifiedBy) return { key: modifiedBy, label: modifiedBy };
	if (owner) return { key: owner, label: owner };
	return { key: "", label: "" };
}

function formatNumber(num) {
	if (num == null) return "0";
	num = Number(num);
	if (num >= 1e6) return (num / 1e6).toFixed(1) + "M";
	if (num >= 1e3) return (num / 1e3).toFixed(1) + "K";
	return num.toString();
}

function csvEscape(value) {
	if (value == null) return "";
	var str = String(value);
	if (/[",\n\r]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
	return str;
}

function csvRow(cells) {
	return cells.map(csvEscape).join(",");
}

/* ---------- ISO week helpers ---------- */

function getIsoWeekString(dateInput) {
	var date =
		typeof dateInput === "string"
			? new Date(dateInput + "T00:00:00Z")
			: new Date(dateInput);
	var day = date.getUTCDay() || 7;
	date.setUTCDate(date.getUTCDate() + 4 - day);
	var yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
	var weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
	return date.getUTCFullYear() + "-W" + String(weekNo).padStart(2, "0");
}

function parseWeekValue(weekValue) {
	if (!weekValue || typeof weekValue !== "string") return null;
	var match = weekValue.match(/^(\d{4})-W(\d{2})$/);
	if (!match) return null;
	var year = Number(match[1]);
	var week = Math.max(1, Math.min(53, Number(match[2])));
	if (!Number.isFinite(year) || !Number.isFinite(week)) return null;
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
	if (dow <= 4) isoWeekStart.setUTCDate(simple.getUTCDate() - (dow || 7) + 1);
	else isoWeekStart.setUTCDate(simple.getUTCDate() + 8 - dow);
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
		var tmp = fromParsed; fromParsed = toParsed; toParsed = tmp;
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
	var labels = [], keys = [];
	if (rangeInfo.from.year === rangeInfo.to.year) {
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

function getYearFromDateString(ds) {
	if (!ds) return null;
	var d = new Date(ds + "T00:00:00Z");
	return Number.isNaN(d.getTime()) ? null : d.getUTCFullYear();
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

/* ---------- Distribution / bed helpers ---------- */

function getDistributionBedKey(row) {
	var gh = row?.greenhouse || "";
	var bed = row?.bed || "";
	var zone = row?.zone || "";
	if (bed) return gh + "::bed::" + bed;
	if (zone) return gh + "::zone::" + zone;
	return "";
}

function getTotalBedsForDistribution(entries) {
	var s = new Set();
	(entries || []).forEach(function (e) {
		var k = getDistributionBedKey(e);
		if (k) s.add(k);
	});
	return s.size;
}

function toBedInfectionPercent(infectedCount, total) {
	if (!total) return 0;
	return Number(((infectedCount / total) * 100).toFixed(2));
}

function buildDailyBedInfectionMap(entries, observationType) {
	var map = {};
	(entries || []).forEach(function (entry) {
		var obs =
			observationType === "pests"
				? entry.pests_scouting_entry || entry.pests || []
				: entry.diseases_scouting_entry || entry.diseases || [];
		if (!obs.length) return;
		var date = entry?.date_of_capture || "";
		if (!date) return;
		var bedKey = getDistributionBedKey(entry);
		if (!bedKey) return;
		if (!map[date]) map[date] = new Set();
		map[date].add(bedKey);
	});
	return map;
}

function buildWeeklyBedInfectionSeries(counts, axis, weekIndex, totalBeds, includeFn) {
	var weeklySets = axis.keys.map(function () { return new Set(); });
	(counts || []).forEach(function (c) {
		if (includeFn && !includeFn(c)) return;
		var wk = getIsoWeekString(new Date(c.date + "T00:00:00Z"));
		var idx = weekIndex[wk];
		if (idx === undefined) return;
		var bedKey = getDistributionBedKey(c);
		if (!bedKey) return;
		weeklySets[idx].add(bedKey);
	});
	return weeklySets.map(function (s) {
		return toBedInfectionPercent(s.size, totalBeds);
	});
}

/* ---------- Chart palette ---------- */

function getPaletteColor(index) {
	var hue = (index * 37) % 360;
	return {
		border: "hsl(" + hue + ", 70%, 45%)",
		background: "hsla(" + hue + ", 70%, 45%, 0.12)",
	};
}

function setSelectOptions(selectEl, options, preferredValue) {
	if (!selectEl) return;
	var current = preferredValue !== undefined ? preferredValue : selectEl.value;
	selectEl.innerHTML = "";
	options.forEach(function (opt) {
		var o = document.createElement("option");
		o.value = opt.value;
		o.textContent = opt.label;
		selectEl.appendChild(o);
	});
	var allowed = options.some(function (o) { return o.value === current; });
	selectEl.value = allowed ? current : options[0]?.value || "";
}

/* ---------- Color extraction from scouting report ---------- */

function extractObservationColors(report) {
	var colors = { pests: {}, diseases: {} };
	if (!report?.observation_metadata?.all_observation_names) return colors;
	var pests = report.observation_metadata.all_observation_names.pests_scouting_entry || [];
	var diseases = report.observation_metadata.all_observation_names.diseases_scouting_entry || [];
	pests.forEach(function (p) { if (p.name && p.color) colors.pests[p.name] = p.color; });
	diseases.forEach(function (d) { if (d.name && d.color) colors.diseases[d.name] = d.color; });
	return colors;
}


/* ==========  NORMALIZE SCOUTING ENTRIES  ========== */

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
			var ex = byName[key];
			if (!ex.date_of_capture && row?.date_of_capture) ex.date_of_capture = row.date_of_capture;
			if (!ex.time_of_capture && row?.time_of_capture) ex.time_of_capture = row.time_of_capture;
			if (!ex.greenhouse && row?.greenhouse) ex.greenhouse = row.greenhouse;
			if (!ex.bed && row?.bed) ex.bed = row.bed;
			if (!ex.zone && row?.zone) ex.zone = row.zone;
			if (!ex.owner && row?.owner) ex.owner = row.owner;
			if (!ex.modified_by && row?.modified_by) ex.modified_by = row.modified_by;
			if (!ex.scouts_name && (row?.scouts_name || row?.scout_name || row?.scout))
				ex.scouts_name = row.scouts_name || row.scout_name || row.scout;
		}
		return byName[key];
	}

	function appendObservations(target, row) {
		var pests = Array.isArray(row?.pests_scouting_entry) ? row.pests_scouting_entry
			: Array.isArray(row?.pests) ? row.pests : [];
		var diseases = Array.isArray(row?.diseases_scouting_entry) ? row.diseases_scouting_entry
			: Array.isArray(row?.diseases) ? row.diseases : [];
		var traps = Array.isArray(row?.trap_scouting_entry) ? row.trap_scouting_entry
			: Array.isArray(row?.traps) ? row.traps : [];

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

		/* flat pest/disease/trap fields */
		var flatPest = row?.pest_pest || row?.pest;
		if (flatPest) {
			target.pests_scouting_entry.push({
				pest: flatPest,
				plant_section: row?.pest_plant_section || row?.plant_section || row?.predator_plant_section || "",
				stage: row?.pest_stage || row?.stage || "",
				count: toNumber(row?.pest_count ?? row?.count ?? 1),
			});
		}
		var flatDisease = row?.disease_disease || row?.disease;
		if (flatDisease) {
			target.diseases_scouting_entry.push({
				disease: flatDisease,
				plant_section: row?.disease_plant_section || row?.plant_section || "",
				stage: row?.disease_stage || row?.stage || row?.severity_level || "",
				severity_level: row?.disease_stage || row?.severity_level || row?.stage || "",
			});
		}
		var flatTrap = row?.trap_trap || row?.trap || row?.trap_name;
		if (flatTrap) {
			target.trap_scouting_entry.push({
				trap: flatTrap,
				pest: row?.trap_pest || row?.pest || "",
				location: row?.trap_location || row?.location || row?.plant_section || "",
				count: toNumber(row?.trap_count ?? row?.count ?? 0),
			});
		}
	}

	entries.forEach(function (row) {
		var target = ensureEntry(row);
		if (!target) { unnamed.push(row); return; }
		appendObservations(target, row);
	});

	var merged = Object.values(byName)
		.filter(function (e) {
			return (
				(e.pests_scouting_entry && e.pests_scouting_entry.length > 0) ||
				(e.diseases_scouting_entry && e.diseases_scouting_entry.length > 0) ||
				(e.trap_scouting_entry && e.trap_scouting_entry.length > 0)
			);
		})
		.sort(function (a, b) {
			var da = a?.date_of_capture || "";
			var db = b?.date_of_capture || "";
			if (da !== db) return db.localeCompare(da);
			return (b?.time_of_capture || "").localeCompare(a?.time_of_capture || "");
		});

	unnamed.forEach(function (row) {
		var hasObs = !!(row?.pest_pest || row?.pest || row?.disease_disease || row?.disease || row?.trap_trap || row?.trap);
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

	return merged;
}

/* ==========  FRAPPE API  ========== */

function callFrappe(method, args) {
	if (window.frappe && typeof window.frappe.call === "function") {
		return new Promise(function (resolve, reject) {
			window.frappe.call({
				method: method,
				args: args,
				callback: function (r) {
					if (SCOUTING_DASHBOARD_DEBUG)
						console.log("frappe.call OK", { method: method, args: args, r: r });
					resolve(r || {});
				},
				error: function (err) {
					if (SCOUTING_DASHBOARD_DEBUG)
						console.error("frappe.call ERR", { method: method, err: err });
					reject(err);
				},
			});
		});
	}
	/* fallback: REST */
	var params = new URLSearchParams();
	Object.keys(args || {}).forEach(function (key) {
		var v = args[key];
		if (v == null) return;
		params.set(key, typeof v === "string" ? v : JSON.stringify(v));
	});
	var url = "/api/method/" + method;
	var qs = params.toString();
	if (qs) url += "?" + qs;
	if (SCOUTING_DASHBOARD_DEBUG) console.log("fetch call", { method: method, url: url });
	return fetch(url, {
		method: "GET",
		credentials: "same-origin",
		headers: { Accept: "application/json" },
	}).then(function (res) {
		return res.json().catch(function () { return null; }).then(function (data) {
			if (!res.ok) {
				var err = new Error(data?.exc || data?.message || "Request failed");
				err.response = data;
				throw err;
			}
			return data || {};
		});
	});
}

function fetchCompleteScoutingEntries(fromDate, toDate, greenhouse) {
	return callFrappe(
		"upande_scp.serverscripts.get_complete_scouting_entries.getCompleteScoutingEntries",
		{ from_date: fromDate, to_date: toDate, greenhouse: greenhouse }
	).then(function (r) { return r.message?.entries || []; });
}

function loadGreenhouseOptions() {
	return callFrappe("frappe.client.get_list", {
		doctype: "Scouting Entry",
		fields: ["greenhouse"],
		group_by: "greenhouse",
		order_by: "greenhouse asc",
		limit_page_length: 5000,
	}).then(function (r) {
		if (r.message) {
			allGreenhouses = [...new Set(r.message.map(function (d) { return d.greenhouse; }).filter(Boolean))];
			renderFarmOptions();
			renderGreenhouseOptionsForFarm();
		}
	}).catch(function () {
		return callFrappe("frappe.client.get_list", {
			doctype: "Scouting Entry",
			fields: ["greenhouse"],
			order_by: "greenhouse asc",
			limit_page_length: 5000,
		}).then(function (r) {
			if (r.message) {
				allGreenhouses = [...new Set(r.message.map(function (d) { return d.greenhouse; }).filter(Boolean))];
				renderFarmOptions();
				renderGreenhouseOptionsForFarm();
			}
		}).catch(function () { /* silent */ });
	});
}

function setDefaultWeekInputsToLatestScouting(weekFromInput, weekToInput) {
	var currentWeek = getIsoWeekString(new Date());
	weekFromInput.value = currentWeek;
	weekToInput.value = currentWeek;
	return callFrappe("frappe.client.get_list", {
		doctype: "Scouting Entry",
		fields: ["date_of_capture"],
		order_by: "date_of_capture desc",
		limit_page_length: 1,
	}).then(function (r) {
		var latest = r?.message?.[0]?.date_of_capture;
		if (!latest) return;
		var dt = new Date(String(latest) + "T00:00:00Z");
		if (!Number.isFinite(dt.getTime())) return;
		var week = getIsoWeekString(dt);
		weekFromInput.value = week;
		weekToInput.value = week;
	}).catch(function () { /* use defaults */ });
}


/* ==========  DATA BUILD  ========== */

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

	entries.forEach(function (entry) {
		var date = entry.date_of_capture;
		var greenhouse = entry.greenhouse;
		var si = getScoutIdentity(entry);
		var scoutKey = si.key;
		var scoutLabel = si.label;
		var pests = entry.pests_scouting_entry || [];
		var diseases = entry.diseases_scouting_entry || [];
		var traps = entry.trap_scouting_entry || [];

		if (!data.daily[date]) data.daily[date] = { pests: 0, diseases: 0, traps: 0, total: 0 };
		data.daily[date].total++;
		if (!data.greenhouses[greenhouse])
			data.greenhouses[greenhouse] = { name: greenhouse, pests: 0, diseases: 0, traps: 0, scouts: new Set(), alerts: 0 };

		/* pests */
		if (pests.length) {
			data.daily[date].pests += pests.length;
			data.greenhouses[greenhouse].pests += pests.length;
			pests.forEach(function (p) {
				var name = p.pest || "Unknown";
				var stage = p.stage || "Unknown";
				if (!data.pests[name])
					data.pests[name] = { name: name, counts: [], stages: {}, sections: {}, severity: { low: 0, moderate: 0, high: 0 } };
				var count = toNumber(p.count || 1);
				data.pests[name].counts.push({
					date: date, count: count, stage: stage, section: p.plant_section,
					greenhouse: greenhouse, bed: entry.bed || "", zone: entry.zone || "",
				});
				data.pests[name].stages[stage] = (data.pests[name].stages[stage] || 0) + count;
				if (p.plant_section)
					data.pests[name].sections[p.plant_section] = (data.pests[name].sections[p.plant_section] || 0) + count;
				if (count > 15) data.pests[name].severity.high++;
				else if (count > 5) data.pests[name].severity.moderate++;
				else data.pests[name].severity.low++;
			});
		}
		/* diseases */
		if (diseases.length) {
			data.daily[date].diseases += diseases.length;
			data.greenhouses[greenhouse].diseases += diseases.length;
			diseases.forEach(function (d) {
				var name = d.disease || "Unknown";
				var stage = d.stage || d.severity_level || "";
				var sevKey = (d.severity_level || d.stage || "").toLowerCase();
				if (!data.diseases[name])
					data.diseases[name] = { name: name, counts: [], stages: {}, severity: { low: 0, moderate: 0, high: 0 } };
				data.diseases[name].counts.push({
					date: date, stage: stage, section: d.plant_section,
					greenhouse: greenhouse, bed: entry.bed || "", zone: entry.zone || "",
				});
				if (stage) data.diseases[name].stages[stage] = (data.diseases[name].stages[stage] || 0) + 1;
				if (sevKey.includes("high") || sevKey.includes("severe") || sevKey.includes("active"))
					data.diseases[name].severity.high++;
				else if (sevKey.includes("moderate") || sevKey.includes("medium"))
					data.diseases[name].severity.moderate++;
				else data.diseases[name].severity.low++;
			});
		}
		/* traps (from scouting entries, unless separate trap dataset provided) */
		if (!useTrapEntries && traps.length) {
			data.daily[date].traps += traps.length;
			data.greenhouses[greenhouse].traps += traps.length;
			traps.forEach(function (t) {
				var trapId = t.trap || t.trap_name || "Unknown";
				var pest = t.pest || "Unknown";
				var key = trapId + "-" + pest;
				var loc = t.location || t.plant_section;
				var cnt = toNumber(t.count || 0);
				if (!data.traps[key])
					data.traps[key] = { trap: trapId, pest: pest, location: loc, counts: [], total: 0 };
				data.traps[key].counts.push({ date: date, count: cnt, location: loc, greenhouse: greenhouse });
				data.traps[key].total += cnt;
				if (cnt > 10) data.greenhouses[greenhouse].alerts++;
			});
		}
		/* scouts */
		if (scoutKey) {
			data.greenhouses[greenhouse].scouts.add(scoutKey);
			if (!data.scouts[scoutKey]) data.scouts[scoutKey] = { entries: 0, name: scoutLabel || scoutKey };
			data.scouts[scoutKey].entries++;
		}
	});

	/* separate trap entries */
	if (useTrapEntries) {
		trapEntries.forEach(function (trap) {
			var date = trap.date_of_capture;
			var gh = trap.greenhouse;
			if (!data.daily[date]) data.daily[date] = { pests: 0, diseases: 0, traps: 0, total: 0 };
			if (!data.greenhouses[gh])
				data.greenhouses[gh] = { name: gh, pests: 0, diseases: 0, traps: 0, scouts: new Set(), alerts: 0 };
			data.daily[date].traps++;
			data.greenhouses[gh].traps++;
			var key = trap.trap + "-" + (trap.pest || "Unknown");
			if (!data.traps[key])
				data.traps[key] = { trap: trap.trap, pest: trap.pest || "Unknown", location: trap.location, counts: [], total: 0 };
			data.traps[key].counts.push({ date: date, count: trap.count || 0, location: trap.location, greenhouse: gh });
			data.traps[key].total += trap.count || 0;
			if (trap.count > 10) data.greenhouses[gh].alerts++;
		});
	}

	Object.keys(data.greenhouses).forEach(function (gh) {
		data.greenhouses[gh].scoutCount = data.greenhouses[gh].scouts.size;
	});
	return data;
}

function processScoutingData(entries, trapEntries) {
	scoutingData = buildScoutingData(entries, trapEntries);
	updateAllTabs();
}

function logSelectedPeriodObservations(entries, fromDate, toDate) {
	var norm = normalizeScoutingEntries(entries);
	var p = [], d = [], t = [];
	norm.forEach(function (e) {
		var meta = { entry: e.name, date: e.date_of_capture, greenhouse: e.greenhouse, bed: e.bed, zone: e.zone };
		(e.pests_scouting_entry || []).forEach(function (x) {
			p.push(Object.assign({}, meta, { pest: x.pest, stage: x.stage, plant_section: x.plant_section, count: toNumber(x.count) }));
		});
		(e.diseases_scouting_entry || []).forEach(function (x) {
			d.push(Object.assign({}, meta, { disease: x.disease, stage: x.stage || x.severity_level, plant_section: x.plant_section }));
		});
		(e.trap_scouting_entry || []).forEach(function (x) {
			t.push(Object.assign({}, meta, { trap: x.trap, pest: x.pest, location: x.location, count: toNumber(x.count) }));
		});
	});
	console.group("Scouting observations " + fromDate + " to " + toDate);
	console.log("pests_only", p);
	console.log("diseases_only", d);
	console.log("traps_only", t);
	console.groupEnd();
}


/* ==========  INIT  ========== */

function initScoutingDashboard() {
	var weekFromInput = root_element.querySelector("#scout-week-from");
	var weekToInput = root_element.querySelector("#scout-week-to");
	var refreshBtn = root_element.querySelector("#scout-refresh-btn");
	var greenhouseSelect = root_element.querySelector("#scout-greenhouse-filter");
	var farmSelect = root_element.querySelector("#scout-farm-filter");

	if (!weekFromInput || !weekToInput || !refreshBtn || !greenhouseSelect || !farmSelect) {
		if (SCOUTING_DASHBOARD_DEBUG)
			console.error("Scouting dashboard: missing required DOM elements");
		return;
	}

	/* ── Reports dropdown (replaces old debug/export button) ── */
	initReportsDropdown();

	Promise.all([
		loadGreenhouseOptions(),
		setDefaultWeekInputsToLatestScouting(weekFromInput, weekToInput),
	]).then(function () { fetchScoutingData(); });

	refreshBtn.addEventListener("click", refreshAllData);
	weekFromInput.addEventListener("change", refreshAllData);
	weekToInput.addEventListener("change", refreshAllData);
	/* Farm-first: greenhouse select is disabled until a farm is chosen */
	updateGreenhouseSelectState();

	farmSelect.addEventListener("change", function (e) {
		farmFilter = e.target.value || "";
		greenhouseFilter = "";
		renderGreenhouseOptionsForFarm();
		updateGreenhouseSelectState();
		refreshAllData();
	});
	greenhouseSelect.addEventListener("change", function (e) {
		greenhouseFilter = e.target.value;
		refreshAllData();
	});

	root_element.querySelectorAll(".dashboard-tabs .tab-btn").forEach(function (btn) {
		btn.addEventListener("click", function () { switchTab(this.dataset.tab); });
	});

	var modalClose = root_element.querySelector("#scout-gh-modal-close");
	var modal = root_element.querySelector("#scout-gh-modal");
	if (modalClose) modalClose.addEventListener("click", closeScoutModal);
	if (modal) modal.addEventListener("click", function (e) { if (e.target === this) closeScoutModal(); });

	setupWeeklyTrendFilterListeners();
}

function setupWeeklyTrendFilterListeners() {
	var handlers = [
		{ ids: ["#pest-weekly-pest-filter", "#pest-weekly-section-filter"], fn: function () { if (scoutingYearData) updatePestWeeklyTrendChart(); } },
		{ ids: ["#disease-weekly-disease-filter", "#disease-weekly-section-filter"], fn: function () { if (scoutingYearData) updateDiseaseWeeklyTrendChart(); } },
		{ ids: ["#trap-weekly-trap-filter", "#trap-weekly-pest-filter"], fn: function () { if (scoutingYearData) updateTrapWeeklyTrendChart(); } },
	];
	handlers.forEach(function (h) {
		h.ids.forEach(function (sel) {
			var el = root_element.querySelector(sel);
			if (el) el.addEventListener("change", h.fn);
		});
	});
}

function switchTab(tab) {
	activeTab = tab;
	root_element.querySelectorAll(".dashboard-tabs .tab-btn").forEach(function (btn) {
		btn.classList.toggle("active", btn.dataset.tab === tab);
	});
	root_element.querySelectorAll(".tab-content").forEach(function (c) {
		c.classList.toggle("active", c.id === "tab-" + tab);
	});
	if (scoutingData) updateTabData(tab);
}

function refreshAllData() { fetchScoutingData(); }

function fetchScoutingData() {
	var rangeInfo = getSelectedWeekRangeInfo();
	if (!rangeInfo) return;
	var fromDate = rangeInfo.fromDate;
	var toDate = rangeInfo.toDate;
	var loading = root_element.querySelector("#scout-loading");
	var yearFrom = rangeInfo.from.year + "-01-01";
	var yearTo = rangeInfo.to.year + "-12-31";

	if (loading) loading.classList.add("active");

	Promise.all([
		fetchCompleteScoutingEntries(fromDate, toDate, greenhouseFilter),
		fetchCompleteScoutingEntries(yearFrom, yearTo, greenhouseFilter),
	]).then(function (results) {
		var entries = results[0];
		var yearEntries = results[1];
		scoutingAnalysis = null;
		observationColors = { pests: {}, diseases: {} };
		var farmEntries = applyFarmFilterToEntries(entries);
		var farmYearEntries = applyFarmFilterToEntries(yearEntries);
		logSelectedPeriodObservations(farmEntries, fromDate, toDate);
		scoutingYearData = buildScoutingData(farmYearEntries);
		processScoutingData(farmEntries);
		if (loading) loading.classList.remove("active");
	}).catch(function (err) {
		if (SCOUTING_DASHBOARD_DEBUG) console.error("Failed to load scouting data", err);
		if (loading) loading.classList.remove("active");
		notifyUser("Failed to load scouting data");
	});
}


/* ==========  TAB UPDATE DISPATCH  ========== */

function updateAllTabs() {
	updateOverviewTab();
	updatePestTab();
	updateDiseaseTab();
	updateTrapTab();
	updateFcmTab();
}

function updateTabData(tab) {
	switch (tab) {
		case "overview": updateOverviewTab(); break;
		case "pests": updatePestTab(); break;
		case "diseases": updateDiseaseTab(); break;
		case "traps": updateTrapTab(); break;
		case "fcm": updateFcmTab(); break;
	}
}


/* ==========  OVERVIEW TAB  ========== */

function updateOverviewTab() {
	if (!scoutingData) return;

	var scoutNamesSet = new Set();
	scoutingData.entries.forEach(function (e) {
		var si = getScoutIdentity(e);
		if (si?.label) scoutNamesSet.add(si.label);
	});
	var scoutNames = Array.from(scoutNamesSet).sort();

	_setText("#overview-total-scouts", scoutNames.length);
	var namesEl = root_element.querySelector("#overview-scout-names");
	if (namesEl) {
		namesEl.textContent = scoutNames.length <= 8
			? (scoutNames.join(", ") || "—")
			: scoutNames.slice(0, 8).join(", ") + " +" + (scoutNames.length - 8) + " more";
	}
	_setText("#overview-total-entries", formatNumber(scoutingData.entries.length));
	_setText("#overview-greenhouses", Object.keys(scoutingData.greenhouses).length);
	_setText("#overview-alerts", Object.keys(scoutingData.greenhouses).reduce(function (s, gh) { return s + scoutingData.greenhouses[gh].alerts; }, 0));

	updateOverviewTimelineChart();
	updateOverviewDonutChart();
	updateOverviewAreaRadarChart();
	updateGreenhouseHealth();
	updateAlertsList();
	updateTopScouts();
	updateRecentEntries();
}

function _setText(selector, value) {
	var el = root_element.querySelector(selector);
	if (el) el.textContent = value;
}

function updateOverviewTimelineChart() {
	var ctx = root_element.querySelector("#overview-timeline-chart");
	if (!ctx) return;
	if (overviewTimelineChart) overviewTimelineChart.destroy();
	var dates = Object.keys(scoutingData.daily).sort();
	overviewTimelineChart = new Chart(ctx, {
		type: "line",
		data: {
			labels: dates.map(function (d) { return d.slice(5); }),
			datasets: [
				{ label: "Pests", data: dates.map(function (d) { return scoutingData.daily[d].pests; }), borderColor: "#10b981", backgroundColor: "rgba(16,185,129,.1)", tension: 0.4 },
				{ label: "Diseases", data: dates.map(function (d) { return scoutingData.daily[d].diseases; }), borderColor: "#f59e0b", backgroundColor: "rgba(245,158,11,.1)", tension: 0.4 },
				{ label: "Traps", data: dates.map(function (d) { return scoutingData.daily[d].traps; }), borderColor: "#3b82f6", backgroundColor: "rgba(59,130,246,.1)", tension: 0.4 },
			],
		},
		options: {
			responsive: true, maintainAspectRatio: false,
			plugins: { legend: { position: "bottom" } },
			scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: "rgba(0,0,0,.04)" } } },
		},
	});
}

function updateOverviewDonutChart() {
	var ctx = root_element.querySelector("#overview-donut-chart");
	if (!ctx) return;
	if (overviewDonutChart) overviewDonutChart.destroy();
	var totalPests = Object.values(scoutingData.pests).reduce(function (s, p) { return s + p.counts.length; }, 0);
	var totalDiseases = Object.values(scoutingData.diseases).reduce(function (s, d) { return s + d.counts.length; }, 0);
	var totalTraps = Object.values(scoutingData.traps).reduce(function (s, t) { return s + t.total; }, 0);
	_setText("#overview-donut-total", formatNumber(totalPests + totalDiseases + totalTraps));
	overviewDonutChart = new Chart(ctx, {
		type: "doughnut",
		data: {
			labels: ["Pests", "Diseases", "Traps"],
			datasets: [{ data: [totalPests, totalDiseases, totalTraps], backgroundColor: ["#10b981", "#f59e0b", "#3b82f6"], borderWidth: 0 }],
		},
		options: { responsive: true, maintainAspectRatio: false, cutout: "70%", plugins: { legend: { position: "bottom" } } },
	});
}

function updateOverviewAreaRadarChart() {
	var ctx = root_element.querySelector("#overview-area-radar-chart");
	if (!ctx) return;
	if (overviewAreaRadarChart) overviewAreaRadarChart.destroy();
	var pestTotals = {}, diseaseTotals = {};
	Object.values(scoutingData.pests).forEach(function (p) {
		Object.keys(p.sections || {}).forEach(function (sec) { pestTotals[sec] = (pestTotals[sec] || 0) + p.sections[sec]; });
	});
	Object.values(scoutingData.diseases).forEach(function (d) {
		(d.counts || []).forEach(function (c) { var s = c.section || "Unknown"; diseaseTotals[s] = (diseaseTotals[s] || 0) + 1; });
	});
	var allSecs = Array.from(new Set([...Object.keys(pestTotals), ...Object.keys(diseaseTotals)]))
		.map(function (s) { return { section: s, total: (pestTotals[s] || 0) + (diseaseTotals[s] || 0) }; })
		.sort(function (a, b) { return b.total - a.total; })
		.slice(0, 8);
	var labels = allSecs.map(function (s) { return s.section; });
	overviewAreaRadarChart = new Chart(ctx, {
		type: "radar",
		data: {
			labels: labels,
			datasets: [
				{ label: "Pests", data: labels.map(function (l) { return pestTotals[l] || 0; }), borderColor: "#10b981", backgroundColor: "rgba(16,185,129,.12)", pointBackgroundColor: "#10b981", borderWidth: 2 },
				{ label: "Diseases", data: labels.map(function (l) { return diseaseTotals[l] || 0; }), borderColor: "#f59e0b", backgroundColor: "rgba(245,158,11,.12)", pointBackgroundColor: "#f59e0b", borderWidth: 2 },
			],
		},
		options: {
			responsive: true, maintainAspectRatio: false,
			plugins: { legend: { position: "bottom" } },
			scales: { r: { beginAtZero: true, grid: { color: "rgba(0,0,0,.12)" }, angleLines: { color: "rgba(0,0,0,.12)" }, pointLabels: { font: { size: 11 } } } },
		},
	});
}

function updateGreenhouseHealth() {
	var container = root_element.querySelector("#overview-gh-health");
	if (!container) return;
	var ghs = Object.values(scoutingData.greenhouses);
	container.innerHTML = ghs.map(function (gh) {
		var total = gh.pests + gh.diseases + gh.traps;
		var status = total > 50 ? "critical" : total > 20 ? "warning" : "good";
		return '<div class="gh-health-item" data-greenhouse="' + gh.name + '">'
			+ '<div class="gh-health-status ' + status + '"></div>'
			+ '<div class="gh-health-name">' + gh.name + '</div>'
			+ '<div class="gh-health-stats"><span>' + gh.pests + ' pests</span><span>' + gh.diseases + ' diseases</span><span>' + gh.traps + ' traps</span></div>'
			+ '</div>';
	}).join("") || '<div class="empty-state">No greenhouse data</div>';
	root_element.querySelectorAll(".gh-health-item").forEach(function (item) {
		item.addEventListener("click", function () { showGreenhouseDetails(this.dataset.greenhouse); });
	});
}

function updateAlertsList() {
	var container = root_element.querySelector("#overview-alerts-list");
	if (!container) return;
	var alerts = [];
	Object.keys(scoutingData.pests).forEach(function (pest) {
		var p = scoutingData.pests[pest];
		if (p.severity.high > 5) alerts.push({ type: "pest", title: pest + " outbreak", count: p.severity.high, severity: "high" });
	});
	Object.keys(scoutingData.diseases).forEach(function (dis) {
		var d = scoutingData.diseases[dis];
		if (d.severity.high > 3) alerts.push({ type: "disease", title: dis + " severe cases", count: d.severity.high, severity: "high" });
	});
	alerts = alerts.slice(0, 5);
	container.innerHTML = alerts.length === 0
		? '<div class="empty-state">No active alerts</div>'
		: alerts.map(function (a) {
			return '<div class="alert-item"><div class="alert-icon">⚠️</div><div class="alert-content"><div class="alert-title">' + a.title + '</div><div class="alert-meta"><span class="alert-severity ' + a.severity + '">' + a.severity + '</span><span>' + a.count + ' cases</span></div></div></div>';
		}).join("");
}

function updateTopScouts() {
	var container = root_element.querySelector("#overview-top-scouts");
	if (!container) return;
	var scouts = Object.values(scoutingData.scouts).sort(function (a, b) { return b.entries - a.entries; }).slice(0, 5);
	container.innerHTML = scouts.length === 0
		? '<div class="empty-state">No scout data</div>'
		: scouts.map(function (s, i) {
			var cls = i === 0 ? "first" : i === 1 ? "second" : i === 2 ? "third" : "";
			return '<div class="item-row"><div class="item-rank ' + cls + '">' + (i + 1) + '</div><div class="item-info"><div class="item-name">' + (s.name || "Unknown") + '</div><div class="item-meta">' + s.entries + ' entries</div></div></div>';
		}).join("");
}

function updateRecentEntries() {
	var container = root_element.querySelector("#overview-recent-entries");
	if (!container) return;
	var entries = scoutingData.entries.slice(0, 10);
	container.innerHTML = entries.length === 0
		? '<div class="empty-state">No recent entries</div>'
		: entries.map(function (e) {
			var type = e.pests_scouting_entry?.length ? "pest" : e.diseases_scouting_entry?.length ? "disease" : "trap";
			var label = type === "pest" ? "Pest" : type === "disease" ? "Disease" : "Trap";
			return '<div class="recent-entry"><div class="entry-type ' + type + '"></div><div class="entry-info"><div class="entry-title">' + (e.greenhouse || "Unknown") + '</div><div class="entry-details"><span>' + label + '</span><span>' + (getScoutIdentity(e)?.label || "Unknown") + '</span></div></div><div class="entry-time">' + e.date_of_capture + '</div></div>';
		}).join("");
}


/* ==========  PEST TAB  ========== */

function updatePestTab() {
	if (!scoutingData) return;
	var pests = scoutingData.pests;
	var names = Object.keys(pests);
	var totalObs = scoutingData.entries.reduce(function (s, e) { return s + (e.pests_scouting_entry || []).length; }, 0);
	var highSev = names.reduce(function (s, p) { return s + pests[p].severity.high; }, 0);
	var topPest = names.length ? names.reduce(function (a, b) { return pests[a].counts.length > pests[b].counts.length ? a : b; }) : "None";

	_setText("#pest-total-entries", formatNumber(totalObs));
	_setText("#pest-active-count", names.length);
	_setText("#pest-high-severity", highSev);
	_setText("#pest-top-name", topPest);
	_setText("#pest-top-count", (pests[topPest]?.counts.length || 0) + " observations");

	updatePestTrendChart();
	updatePestWeeklyTrend();
	updatePestDistributionChart();
	updatePestSeverityMatrix();
	updatePestSectionChart();
	updatePestStagesTable();
}

function updatePestTrendChart() {
	var ctx = root_element.querySelector("#pest-trend-chart");
	if (!ctx) return;
	if (pestTrendChart) pestTrendChart.destroy();
	var dates = Object.keys(scoutingData.daily).sort();
	var totalBeds = getTotalBedsForDistribution(scoutingData.entries);
	var map = buildDailyBedInfectionMap(scoutingData.entries, "pests");
	pestTrendChart = new Chart(ctx, {
		type: "line",
		data: {
			labels: dates.map(function (d) { return d.slice(5); }),
			datasets: [{
				label: "Beds Infected (%)", data: dates.map(function (d) { return toBedInfectionPercent(map[d]?.size || 0, totalBeds); }),
				borderColor: "#10b981", backgroundColor: "rgba(16,185,129,.1)", borderWidth: 2, fill: true, tension: 0.4, pointRadius: 4, pointBackgroundColor: "#10b981",
			}],
		},
		options: {
			responsive: true, maintainAspectRatio: false,
			plugins: { legend: { display: false } },
			scales: { x: { grid: { display: false } }, y: { beginAtZero: true, max: 100, grid: { color: "rgba(0,0,0,.04)" }, ticks: { callback: function (v) { return v + "%"; } } } },
		},
	});
}

function updatePestWeeklyTrend() {
	var pestSel = root_element.querySelector("#pest-weekly-pest-filter");
	var secSel = root_element.querySelector("#pest-weekly-section-filter");
	if (!pestSel || !secSel || !scoutingYearData) return;
	var pNames = Object.keys(scoutingYearData.pests || {}).sort();
	setSelectOptions(pestSel, [{ value: "", label: "All Pests" }].concat(pNames.map(function (p) { return { value: p, label: p }; })));
	var secs = new Set();
	Object.values(scoutingYearData.pests || {}).forEach(function (p) { (p.counts || []).forEach(function (c) { if (c.section) secs.add(c.section); }); });
	setSelectOptions(secSel, [{ value: "", label: "All Sections" }].concat(Array.from(secs).sort().map(function (s) { return { value: s, label: s }; })));
	updatePestWeeklyTrendChart();
}

function updatePestWeeklyTrendChart() {
	var ctx = root_element.querySelector("#pest-weekly-trend-chart");
	if (!ctx || !scoutingData) return;
	if (pestWeeklyTrendChart) pestWeeklyTrendChart.destroy();
	var rangeInfo = getSelectedWeekRangeInfo();
	if (!rangeInfo) return;
	var axis = getWeekRangeAxis(rangeInfo);
	if (!axis) return;
	var weekIndex = {};
	axis.keys.forEach(function (k, i) { weekIndex[k] = i; });
	var pestName = root_element.querySelector("#pest-weekly-pest-filter")?.value || "";
	var section = root_element.querySelector("#pest-weekly-section-filter")?.value || "";
	var datasets = [];
	var totalBeds = getTotalBedsForDistribution(scoutingData.entries);
	var includeFn = function (c) { return !(section && c.section !== section); };

	if (pestName) {
		var d = buildWeeklyBedInfectionSeries(scoutingData.pests?.[pestName]?.counts || [], axis, weekIndex, totalBeds, includeFn);
		datasets.push({ label: pestName + (section ? " (" + section + ")" : ""), data: d, borderColor: observationColors.pests[pestName] || "#10b981", backgroundColor: "rgba(16,185,129,.1)", borderWidth: 2, fill: false, tension: 0.35, pointRadius: 0 });
	} else {
		Object.keys(scoutingData.pests || {}).sort().forEach(function (p, idx) {
			var d = buildWeeklyBedInfectionSeries(scoutingData.pests[p].counts || [], axis, weekIndex, totalBeds, includeFn);
			if (!d.some(function (v) { return v > 0; })) return;
			var pal = getPaletteColor(idx);
			datasets.push({ label: p, data: d, borderColor: observationColors.pests[p] || pal.border, backgroundColor: pal.background, borderWidth: 2, fill: false, tension: 0.35, pointRadius: 0, order: idx });
		});
	}
	pestWeeklyTrendChart = new Chart(ctx, {
		type: "line",
		data: { labels: axis.labels, datasets: datasets },
		options: {
			responsive: true, maintainAspectRatio: false,
			plugins: {
				legend: { display: datasets.length > 1, position: "bottom", labels: { boxWidth: 10, boxHeight: 10, padding: 10, font: { size: 10 } } },
				tooltip: { mode: "index", intersect: false, callbacks: { title: function (items) { var i = items?.[0]?.dataIndex; if (i === undefined) return ""; return axis.sameYear ? "Week " + axis.labels[i] + " (" + axis.year + ")" : axis.keys[i]; } } },
			},
			scales: { x: { grid: { display: false }, ticks: { autoSkip: true, maxTicksLimit: 13 } }, y: { beginAtZero: true, max: 100, grid: { color: "rgba(0,0,0,.04)" }, ticks: { callback: function (v) { return v + "%"; } } } },
		},
	});
}

function updatePestDistributionChart() {
	var ctx = root_element.querySelector("#pest-distribution-chart");
	if (!ctx) return;
	if (pestDistChart) pestDistChart.destroy();
	var pests = scoutingData.pests;
	var labels = Object.keys(pests).slice(0, 10);
	var totalBeds = getTotalBedsForDistribution(scoutingData.entries);
	var palette = ["#10b981", "#3b82f6", "#f59e0b", "#8b5cf6", "#ef4444", "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#06b6d4"];
	var data = labels.map(function (p) {
		var beds = new Set();
		(pests[p].counts || []).forEach(function (c) { var k = getDistributionBedKey(c); if (k) beds.add(k); });
		return totalBeds ? Number(((beds.size / totalBeds) * 100).toFixed(2)) : 0;
	});
	pestDistChart = new Chart(ctx, {
		type: "bar",
		data: { labels: labels, datasets: [{ label: "Beds Infected (%)", data: data, backgroundColor: labels.map(function (l, i) { return observationColors.pests[l] || palette[i % palette.length]; }), borderRadius: 4 }] },
		options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, max: 100, grid: { color: "rgba(0,0,0,.04)" }, ticks: { callback: function (v) { return v + "%"; } } } } },
	});
}

function updatePestSeverityMatrix() {
	var container = root_element.querySelector("#pest-severity-matrix");
	if (!container) return;
	var pests = scoutingData.pests;
	container.innerHTML = Object.keys(pests).slice(0, 12).map(function (pest) {
		var p = pests[pest];
		var total = p.counts.length;
		var highPct = total ? Math.round((p.severity.high / total) * 100) : 0;
		var modPct = total ? Math.round((p.severity.moderate / total) * 100) : 0;
		var lowPct = total ? Math.round((p.severity.low / total) * 100) : 0;
		var cls = highPct > 50 ? "critical" : highPct > 20 ? "high" : modPct > 30 ? "moderate" : "low";
		return '<div class="severity-item"><div class="severity-name">' + pest + '</div><div class="severity-bar"><div class="severity-fill ' + cls + '" style="width:' + (highPct + modPct + lowPct) + '%"></div></div><div class="severity-stats"><span>High: ' + p.severity.high + '</span><span>Mod: ' + p.severity.moderate + '</span><span>Low: ' + p.severity.low + '</span></div></div>';
	}).join("") || '<div class="empty-state">No pest data available</div>';
}

function updatePestSectionChart() {
	var ctx = root_element.querySelector("#pest-section-chart");
	if (!ctx) return;
	if (pestSectionChart) pestSectionChart.destroy();
	var sections = {};
	Object.keys(scoutingData.pests).forEach(function (pest) {
		Object.keys(scoutingData.pests[pest].sections).forEach(function (sec) { sections[sec] = (sections[sec] || 0) + scoutingData.pests[pest].sections[sec]; });
	});
	pestSectionChart = new Chart(ctx, {
		type: "doughnut",
		data: { labels: Object.keys(sections), datasets: [{ data: Object.values(sections), backgroundColor: ["#10b981", "#3b82f6", "#f59e0b", "#8b5cf6", "#ef4444"] }] },
		options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } },
	});
}

function updatePestStagesTable() {
	var tbody = root_element.querySelector("#pest-stages-body");
	if (!tbody) return;
	var stages = [];
	Object.keys(scoutingData.pests).forEach(function (pest) {
		scoutingData.pests[pest].counts.slice(0, 20).forEach(function (c) {
			stages.push({ pest: pest, stage: c.stage || "N/A", count: c.count || 1, section: c.section || "N/A", date: c.date, greenhouse: c.greenhouse });
		});
	});
	stages.sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
	stages = stages.slice(0, 50);
	tbody.innerHTML = stages.length === 0
		? '<tr><td colspan="6" class="empty-state">No pest stages found</td></tr>'
		: stages.map(function (s) {
			return '<tr><td><span class="pest-badge">' + s.pest + '</span></td><td>' + s.stage + '</td><td><strong>' + s.count + '</strong></td><td>' + s.section + '</td><td>' + s.date + '</td><td>' + (s.greenhouse || "-") + '</td></tr>';
		}).join("");
}


/* ==========  DISEASE TAB  ========== */

function updateDiseaseTab() {
	if (!scoutingData) return;
	var diseases = scoutingData.diseases;
	var names = Object.keys(diseases);
	var totalObs = scoutingData.entries.reduce(function (s, e) { return s + (e.diseases_scouting_entry || []).length; }, 0);
	var severe = names.reduce(function (s, d) { return s + diseases[d].severity.high; }, 0);
	var topDisease = names.length ? names.reduce(function (a, b) { return diseases[a].counts.length > diseases[b].counts.length ? a : b; }) : "None";

	_setText("#disease-total-entries", formatNumber(totalObs));
	_setText("#disease-active-count", names.length);
	_setText("#disease-severe-count", severe);
	_setText("#disease-top-name", topDisease);
	_setText("#disease-top-count", (diseases[topDisease]?.counts.length || 0) + " cases");

	updateDiseaseTrendChart();
	updateDiseaseWeeklyTrend();
	updateDiseaseDistributionChart();
	updateDiseaseSeverityBubbles();
	updateDiseaseStageChart();
	updateDiseaseIncidentsTable();
}

function updateDiseaseTrendChart() {
	var ctx = root_element.querySelector("#disease-trend-chart");
	if (!ctx) return;
	if (diseaseTrendChart) diseaseTrendChart.destroy();
	var dates = Object.keys(scoutingData.daily).sort();
	var totalBeds = getTotalBedsForDistribution(scoutingData.entries);
	var map = buildDailyBedInfectionMap(scoutingData.entries, "diseases");
	diseaseTrendChart = new Chart(ctx, {
		type: "line",
		data: {
			labels: dates.map(function (d) { return d.slice(5); }),
			datasets: [{ label: "Beds Infected (%)", data: dates.map(function (d) { return toBedInfectionPercent(map[d]?.size || 0, totalBeds); }), borderColor: "#f59e0b", backgroundColor: "rgba(245,158,11,.1)", borderWidth: 2, fill: true, tension: 0.4, pointRadius: 4, pointBackgroundColor: "#f59e0b" }],
		},
		options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, max: 100, grid: { color: "rgba(0,0,0,.04)" }, ticks: { callback: function (v) { return v + "%"; } } } } },
	});
}

function updateDiseaseWeeklyTrend() {
	var disSel = root_element.querySelector("#disease-weekly-disease-filter");
	var secSel = root_element.querySelector("#disease-weekly-section-filter");
	if (!disSel || !secSel || !scoutingYearData) return;
	var dNames = Object.keys(scoutingYearData.diseases || {}).sort();
	setSelectOptions(disSel, [{ value: "", label: "All Diseases" }].concat(dNames.map(function (d) { return { value: d, label: d }; })));
	var secs = new Set();
	Object.values(scoutingYearData.diseases || {}).forEach(function (d) { (d.counts || []).forEach(function (c) { if (c.section) secs.add(c.section); }); });
	setSelectOptions(secSel, [{ value: "", label: "All Sections" }].concat(Array.from(secs).sort().map(function (s) { return { value: s, label: s }; })));
	updateDiseaseWeeklyTrendChart();
}

function updateDiseaseWeeklyTrendChart() {
	var ctx = root_element.querySelector("#disease-weekly-trend-chart");
	if (!ctx || !scoutingData) return;
	if (diseaseWeeklyTrendChart) diseaseWeeklyTrendChart.destroy();
	var rangeInfo = getSelectedWeekRangeInfo();
	if (!rangeInfo) return;
	var axis = getWeekRangeAxis(rangeInfo);
	if (!axis) return;
	var weekIndex = {};
	axis.keys.forEach(function (k, i) { weekIndex[k] = i; });
	var diseaseName = root_element.querySelector("#disease-weekly-disease-filter")?.value || "";
	var section = root_element.querySelector("#disease-weekly-section-filter")?.value || "";
	var datasets = [];
	var totalBeds = getTotalBedsForDistribution(scoutingData.entries);
	var includeFn = function (c) { return !(section && c.section !== section); };

	if (diseaseName) {
		var d = buildWeeklyBedInfectionSeries(scoutingData.diseases?.[diseaseName]?.counts || [], axis, weekIndex, totalBeds, includeFn);
		datasets.push({ label: diseaseName + (section ? " (" + section + ")" : ""), data: d, borderColor: observationColors.diseases[diseaseName] || "#f59e0b", backgroundColor: "rgba(245,158,11,.1)", borderWidth: 2, fill: false, tension: 0.35, pointRadius: 0 });
	} else {
		Object.keys(scoutingData.diseases || {}).sort().forEach(function (dn, idx) {
			var d = buildWeeklyBedInfectionSeries(scoutingData.diseases[dn].counts || [], axis, weekIndex, totalBeds, includeFn);
			if (!d.some(function (v) { return v > 0; })) return;
			var pal = getPaletteColor(idx);
			datasets.push({ label: dn, data: d, borderColor: observationColors.diseases[dn] || pal.border, backgroundColor: pal.background, borderWidth: 2, fill: false, tension: 0.35, pointRadius: 0, order: idx });
		});
	}
	diseaseWeeklyTrendChart = new Chart(ctx, {
		type: "line",
		data: { labels: axis.labels, datasets: datasets },
		options: {
			responsive: true, maintainAspectRatio: false,
			plugins: {
				legend: { display: datasets.length > 1, position: "bottom", labels: { boxWidth: 10, boxHeight: 10, padding: 10, font: { size: 10 } } },
				tooltip: { mode: "index", intersect: false, callbacks: { title: function (items) { var i = items?.[0]?.dataIndex; if (i === undefined) return ""; return axis.sameYear ? "Week " + axis.labels[i] + " (" + axis.year + ")" : axis.keys[i]; } } },
			},
			scales: { x: { grid: { display: false }, ticks: { autoSkip: true, maxTicksLimit: 13 } }, y: { beginAtZero: true, max: 100, grid: { color: "rgba(0,0,0,.04)" }, ticks: { callback: function (v) { return v + "%"; } } } },
		},
	});
}

function updateDiseaseDistributionChart() {
	var ctx = root_element.querySelector("#disease-distribution-chart");
	if (!ctx) return;
	if (diseaseDistChart) diseaseDistChart.destroy();
	var diseases = scoutingData.diseases;
	var labels = Object.keys(diseases).slice(0, 10);
	var totalBeds = getTotalBedsForDistribution(scoutingData.entries);
	var palette = ["#f59e0b", "#ef4444", "#8b5cf6", "#10b981", "#3b82f6", "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#06b6d4"];
	var data = labels.map(function (d) {
		var beds = new Set();
		(diseases[d].counts || []).forEach(function (c) { var k = getDistributionBedKey(c); if (k) beds.add(k); });
		return totalBeds ? Number(((beds.size / totalBeds) * 100).toFixed(2)) : 0;
	});
	diseaseDistChart = new Chart(ctx, {
		type: "bar",
		data: { labels: labels, datasets: [{ label: "Beds Infected (%)", data: data, backgroundColor: labels.map(function (l, i) { return observationColors.diseases[l] || palette[i % palette.length]; }), borderRadius: 4 }] },
		options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, max: 100, grid: { color: "rgba(0,0,0,.04)" }, ticks: { callback: function (v) { return v + "%"; } } } } },
	});
}

function updateDiseaseSeverityBubbles() {
	var container = root_element.querySelector("#disease-severity-bubbles");
	if (!container) return;
	var diseases = scoutingData.diseases;
	container.innerHTML = Object.keys(diseases).slice(0, 12).map(function (dis) {
		var d = diseases[dis];
		var total = d.counts.length;
		var highPct = total ? d.severity.high / total : 0;
		var size = Math.min(60 + total * 2, 120);
		return '<div class="bubble-item"><div class="bubble" style="width:' + size + 'px;height:' + size + 'px;background:' + (highPct > 0.5 ? "#ef4444" : highPct > 0.2 ? "#f59e0b" : "#10b981") + '"><span>' + Math.round(highPct * 100) + '%</span></div><div class="bubble-label">' + dis + '</div><div class="bubble-sub">' + total + ' cases</div></div>';
	}).join("") || '<div class="empty-state">No disease data available</div>';
}

function updateDiseaseStageChart() {
	var ctx = root_element.querySelector("#disease-stage-chart");
	if (!ctx) return;
	if (diseaseStageChart) diseaseStageChart.destroy();
	var stages = {};
	Object.keys(scoutingData.diseases).forEach(function (dis) {
		Object.keys(scoutingData.diseases[dis].stages).forEach(function (st) { stages[st] = (stages[st] || 0) + scoutingData.diseases[dis].stages[st]; });
	});
	diseaseStageChart = new Chart(ctx, {
		type: "doughnut",
		data: { labels: Object.keys(stages), datasets: [{ data: Object.values(stages), backgroundColor: ["#f59e0b", "#3b82f6", "#ef4444", "#10b981", "#8b5cf6"] }] },
		options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } },
	});
}

function updateDiseaseIncidentsTable() {
	var tbody = root_element.querySelector("#disease-incidents-body");
	if (!tbody) return;
	var incidents = [];
	Object.keys(scoutingData.diseases).forEach(function (dis) {
		scoutingData.diseases[dis].counts.slice(0, 20).forEach(function (c) {
			incidents.push({ disease: dis, stage: c.stage || "N/A", severity: c.stage && c.stage.includes("Active") ? "High" : "Low", section: c.section || "N/A", date: c.date, greenhouse: c.greenhouse });
		});
	});
	incidents.sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
	incidents = incidents.slice(0, 50);
	tbody.innerHTML = incidents.length === 0
		? '<tr><td colspan="6" class="empty-state">No disease incidents found</td></tr>'
		: incidents.map(function (i) {
			return '<tr><td><span class="pest-badge">' + i.disease + '</span></td><td>' + i.stage + '</td><td><span class="severity-tag ' + i.severity.toLowerCase() + '">' + i.severity + '</span></td><td>' + i.section + '</td><td>' + i.date + '</td><td>' + (i.greenhouse || "-") + '</td></tr>';
		}).join("");
}


/* ==========  TRAP TAB  ========== */

function updateTrapTab() {
	if (!scoutingData) return;
	var traps = scoutingData.traps;
	var keys = Object.keys(traps);
	var totalEntries = keys.reduce(function (s, t) { return s + (traps[t].counts?.length || 0); }, 0);
	var totalCount = keys.reduce(function (s, t) { return s + traps[t].total; }, 0);
	var activeTraps = new Set(keys.map(function (t) { return traps[t].trap; })).size;
	var fcmCount = keys.reduce(function (s, t) { return s + (traps[t].pest === "FCM" ? traps[t].total : 0); }, 0);

	_setText("#trap-total-count", formatNumber(totalEntries));
	_setText("#trap-active-count", activeTraps);
	_setText("#trap-fcm-count", formatNumber(fcmCount));
	_setText("#trap-avg-count", activeTraps ? (totalCount / activeTraps).toFixed(1) : 0);

	updateTrapTrendChart();
	updateTrapWeeklyTrend();
	updateTrapPerformanceChart();
	updateTrapHeatmap();
	updateTrapPestChart();
	updateTrapDetailsTable();
}

function updateTrapTrendChart() {
	var ctx = root_element.querySelector("#trap-trend-chart");
	if (!ctx) return;
	if (trapTrendChart) trapTrendChart.destroy();
	var dates = Object.keys(scoutingData.daily).sort();
	trapTrendChart = new Chart(ctx, {
		type: "line",
		data: {
			labels: dates.map(function (d) { return d.slice(5); }),
			datasets: [{ label: "Trap Counts", data: dates.map(function (d) { return scoutingData.daily[d].traps; }), borderColor: "#3b82f6", backgroundColor: "rgba(59,130,246,.1)", borderWidth: 2, fill: true, tension: 0.4, pointRadius: 4, pointBackgroundColor: "#3b82f6" }],
		},
		options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: "rgba(0,0,0,.04)" } } } },
	});
}

function updateTrapWeeklyTrend() {
	var trapSel = root_element.querySelector("#trap-weekly-trap-filter");
	var pestSel = root_element.querySelector("#trap-weekly-pest-filter");
	if (!trapSel || !pestSel || !scoutingYearData) return;
	var trapsSet = new Set(), pestsSet = new Set();
	Object.values(scoutingYearData.traps || {}).forEach(function (t) { if (t.trap) trapsSet.add(t.trap); if (t.pest) pestsSet.add(t.pest); });
	setSelectOptions(trapSel, [{ value: "", label: "All Traps" }].concat(Array.from(trapsSet).sort().map(function (t) { return { value: t, label: t }; })));
	setSelectOptions(pestSel, [{ value: "", label: "All Pests" }].concat(Array.from(pestsSet).sort().map(function (p) { return { value: p, label: p }; })));
	updateTrapWeeklyTrendChart();
}

function updateTrapWeeklyTrendChart() {
	var ctx = root_element.querySelector("#trap-weekly-trend-chart");
	if (!ctx || !scoutingData) return;
	if (trapWeeklyTrendChart) trapWeeklyTrendChart.destroy();
	var rangeInfo = getSelectedWeekRangeInfo();
	if (!rangeInfo) return;
	var axis = getWeekRangeAxis(rangeInfo);
	if (!axis) return;
	var weekIndex = {};
	axis.keys.forEach(function (k, i) { weekIndex[k] = i; });
	var trapName = root_element.querySelector("#trap-weekly-trap-filter")?.value || "";
	var pestName = root_element.querySelector("#trap-weekly-pest-filter")?.value || "";
	var datasets = [];

	if (pestName) {
		var weeklyCounts = new Array(axis.labels.length).fill(0);
		Object.keys(scoutingData.traps || {}).forEach(function (k) {
			var t = scoutingData.traps[k];
			if (trapName && t.trap !== trapName) return;
			if (t.pest !== pestName) return;
			(t.counts || []).forEach(function (c) {
				var wk = getIsoWeekString(new Date(c.date + "T00:00:00Z"));
				var i = weekIndex[wk];
				if (i !== undefined) weeklyCounts[i] += Number(c.count || 0);
			});
		});
		datasets.push({ label: (trapName || "All Traps") + " (" + pestName + ")", data: weeklyCounts, borderColor: observationColors.pests[pestName] || "#3b82f6", backgroundColor: "rgba(59,130,246,.1)", borderWidth: 2, fill: false, tension: 0.35, pointRadius: 0 });
	} else {
		var byPest = {};
		Object.keys(scoutingData.traps || {}).forEach(function (k) {
			var t = scoutingData.traps[k];
			if (trapName && t.trap !== trapName) return;
			var pest = t.pest || "Unknown";
			if (!byPest[pest]) byPest[pest] = new Array(axis.labels.length).fill(0);
			(t.counts || []).forEach(function (c) {
				var wk = getIsoWeekString(new Date(c.date + "T00:00:00Z"));
				var i = weekIndex[wk];
				if (i !== undefined) byPest[pest][i] += Number(c.count || 0);
			});
		});
		Object.keys(byPest).sort().forEach(function (p, idx) {
			var total = byPest[p].reduce(function (a, b) { return a + b; }, 0);
			if (total <= 0) return;
			var pal = getPaletteColor(idx);
			datasets.push({ label: p, data: byPest[p], borderColor: observationColors.pests[p] || pal.border, backgroundColor: pal.background, borderWidth: 2, fill: false, tension: 0.35, pointRadius: 0, order: idx });
		});
	}
	trapWeeklyTrendChart = new Chart(ctx, {
		type: "line",
		data: { labels: axis.labels, datasets: datasets },
		options: {
			responsive: true, maintainAspectRatio: false,
			plugins: {
				legend: { display: datasets.length > 1, position: "bottom", labels: { boxWidth: 10, boxHeight: 10, padding: 10, font: { size: 10 } } },
				tooltip: { mode: "index", intersect: false, callbacks: { title: function (items) { var i = items?.[0]?.dataIndex; if (i === undefined) return ""; return axis.sameYear ? "Week " + axis.labels[i] + " (" + axis.year + ")" : axis.keys[i]; } } },
			},
			scales: { x: { grid: { display: false }, ticks: { autoSkip: true, maxTicksLimit: 13 } }, y: { beginAtZero: true, grid: { color: "rgba(0,0,0,.04)" } } },
		},
	});
}

function updateTrapPerformanceChart() {
	var ctx = root_element.querySelector("#trap-performance-chart");
	if (!ctx) return;
	if (trapPerfChart) trapPerfChart.destroy();
	var locs = {};
	Object.keys(scoutingData.traps).forEach(function (k) { var l = scoutingData.traps[k].location || "Unknown"; locs[l] = (locs[l] || 0) + scoutingData.traps[k].total; });
	var labels = Object.keys(locs).slice(0, 10);
	trapPerfChart = new Chart(ctx, {
		type: "bar",
		data: { labels: labels, datasets: [{ label: "Total Count", data: labels.map(function (l) { return locs[l]; }), backgroundColor: "#3b82f6", borderRadius: 4 }] },
		options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, grid: { color: "rgba(0,0,0,.04)" } } } },
	});
}

function updateTrapHeatmap() {
	var container = root_element.querySelector("#trap-heatmap");
	if (!container) return;
	var locs = {};
	Object.keys(scoutingData.traps).forEach(function (k) { var l = scoutingData.traps[k].location || "Unknown"; locs[l] = (locs[l] || 0) + scoutingData.traps[k].total; });
	var max = Math.max.apply(null, Object.values(locs).concat([1]));
	container.innerHTML = Object.keys(locs).slice(0, 12).map(function (loc) {
		var count = locs[loc];
		var pct = (count / max) * 100;
		var color = count > max * 0.7 ? "#ef4444" : count > max * 0.4 ? "#f59e0b" : "#10b981";
		return '<div class="heatmap-cell"><div class="heatmap-location">' + loc + '</div><div class="heatmap-value">' + count + '</div><div class="heatmap-indicator" style="background:' + color + ';width:' + pct + '%"></div></div>';
	}).join("") || '<div class="empty-state">No trap location data</div>';
}

function updateTrapPestChart() {
	var ctx = root_element.querySelector("#trap-pest-breakdown");
	if (!ctx) return;
	if (trapPestChart) trapPestChart.destroy();
	var pests = {};
	Object.keys(scoutingData.traps).forEach(function (k) { var p = scoutingData.traps[k].pest || "Unknown"; pests[p] = (pests[p] || 0) + scoutingData.traps[k].total; });
	var labels = Object.keys(pests).slice(0, 10);
	var colors = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#06b6d4"];
	trapPestChart = new Chart(ctx, {
		type: "doughnut",
		data: { labels: labels, datasets: [{ data: labels.map(function (l) { return pests[l]; }), backgroundColor: colors.slice(0, labels.length) }] },
		options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } },
	});
}

function updateTrapDetailsTable() {
	var tbody = root_element.querySelector("#trap-details-body");
	if (!tbody) return;
	var details = [];
	Object.keys(scoutingData.traps).forEach(function (k) {
		scoutingData.traps[k].counts.slice(0, 20).forEach(function (c) {
			details.push({ trap: scoutingData.traps[k].trap, pest: scoutingData.traps[k].pest, count: c.count || 0, location: c.location || "N/A", date: c.date, greenhouse: c.greenhouse });
		});
	});
	details.sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
	details = details.slice(0, 50);
	tbody.innerHTML = details.length === 0
		? '<tr><td colspan="6" class="empty-state">No trap data found</td></tr>'
		: details.map(function (d) {
			return '<tr><td>' + d.trap + '</td><td>' + d.pest + '</td><td><strong>' + d.count + '</strong></td><td>' + d.location + '</td><td>' + d.date + '</td><td>' + (d.greenhouse || "-") + '</td></tr>';
		}).join("");
}


/* ==========  FCM / FOCUS PESTS TAB  ========== */

function normalizeFocusName(name) {
	return (name || "").toString().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function matchesAny(normalized, terms) {
	return terms.some(function (t) { return normalized.includes(t); });
}

var FOCUS_PESTS = [
	{ key: "fcm", label: "FCM", matches: function (n) { return matchesAny(normalizeFocusName(n), ["fcm", "false codling", "false codling moth"]); } },
	{ key: "helicoverpa", label: "Helicoverpa", matches: function (n) { return matchesAny(normalizeFocusName(n), ["helicoverpa", "helioverpa"]); } },
	{ key: "duponchella", label: "Duponchella", matches: function (n) { return matchesAny(normalizeFocusName(n), ["duponchella", "duponchelia", "duponchel"]); } },
	{ key: "spodoptera", label: "Spodoptera", matches: function (n) { return matchesAny(normalizeFocusName(n), ["spodoptera", "armyworm", "fall armyworm"]); } },
	{ key: "unidentified_moth", label: "Unidentified moth", matches: function (n) { var s = normalizeFocusName(n); return matchesAny(s, ["unidentified moth", "unknown moth"]) || (s.includes("unidentified") && s.includes("moth")); } },
];

function getFocusKey(name) {
	for (var i = 0; i < FOCUS_PESTS.length; i++) {
		if (FOCUS_PESTS[i].matches(name)) return FOCUS_PESTS[i].key;
	}
	return null;
}

function getFocusLabel(key) {
	var f = FOCUS_PESTS.find(function (x) { return x.key === key; });
	return f ? f.label : key;
}

function updateFcmTab() {
	if (!scoutingData) return;

	var trapTotals = {}, pestTotals = {};
	Object.values(scoutingData.traps || {}).forEach(function (t) {
		var key = getFocusKey(t.pest || "");
		if (key) trapTotals[key] = (trapTotals[key] || 0) + toNumber(t.total);
	});
	Object.keys(scoutingData.pests || {}).forEach(function (pn) {
		var key = getFocusKey(pn);
		if (!key) return;
		(scoutingData.pests[pn].counts || []).forEach(function (c) { pestTotals[key] = (pestTotals[key] || 0) + toNumber(c.count); });
	});

	var trapSum = Object.values(trapTotals).reduce(function (a, b) { return a + b; }, 0);
	var pestSum = Object.values(pestTotals).reduce(function (a, b) { return a + b; }, 0);

	var impacted = [], impactedGhs = new Set();
	(scoutingData.entries || []).forEach(function (e) {
		var has = false;
		(e.trap_scouting_entry || []).forEach(function (t) { if (!has && getFocusKey(t?.pest || "")) has = true; });
		(e.pests_scouting_entry || []).forEach(function (p) { if (!has && getFocusKey(p?.pest || "")) has = true; });
		if (has) { impacted.push(e); if (e?.greenhouse) impactedGhs.add(e.greenhouse); }
	});

	_setText("#fcm-trap-total", formatNumber(trapSum));
	_setText("#fcm-pest-total", formatNumber(pestSum));
	_setText("#fcm-entry-count", formatNumber(impacted.length));
	_setText("#fcm-greenhouse-count", impactedGhs.size);

	function buildRows(totals) {
		return FOCUS_PESTS.map(function (f) { return { key: f.key, label: f.label, total: toNumber(totals[f.key] || 0) }; })
			.filter(function (r) { return r.total > 0; })
			.sort(function (a, b) { return b.total - a.total; });
	}

	var trapRows = buildRows(trapTotals);
	var pestRows = buildRows(pestTotals);

	var trapBody = root_element.querySelector("#fcm-trap-body");
	if (trapBody) {
		trapBody.innerHTML = !trapRows.length
			? '<tr><td colspan="2" class="empty-state">No focus pests in traps</td></tr>'
			: trapRows.map(function (r) { return '<tr><td><span class="pest-badge">' + r.label + '</span></td><td><strong>' + formatNumber(r.total) + '</strong></td></tr>'; }).join("");
	}

	var pestBody = root_element.querySelector("#fcm-pest-body");
	if (pestBody) {
		pestBody.innerHTML = !pestRows.length
			? '<tr><td colspan="2" class="empty-state">No focus pests in pest scouting</td></tr>'
			: pestRows.map(function (r) { return '<tr><td><span class="pest-badge">' + r.label + '</span></td><td><strong>' + formatNumber(r.total) + '</strong></td></tr>'; }).join("");
	}

	var recentEl = root_element.querySelector("#fcm-recent-entries");
	if (recentEl) {
		var recent = impacted.slice(0, 10);
		recentEl.innerHTML = !recent.length
			? '<div class="empty-state">No recent focus entries</div>'
			: recent.map(function (e) {
				var focusNames = [];
				(e.trap_scouting_entry || []).forEach(function (t) { var k = getFocusKey(t?.pest || ""); if (k) focusNames.push(getFocusLabel(k)); });
				(e.pests_scouting_entry || []).forEach(function (p) { var k = getFocusKey(p?.pest || ""); if (k) focusNames.push(getFocusLabel(k)); });
				focusNames = Array.from(new Set(focusNames)).slice(0, 3);
				return '<div class="recent-entry"><div class="entry-type trap"></div><div class="entry-info"><div class="entry-title">' + (e.greenhouse || "Unknown") + '</div><div class="entry-details"><span>' + (focusNames.join(", ") || "—") + '</span><span>' + (getScoutIdentity(e)?.label || "Unknown") + '</span></div></div><div class="entry-time">' + e.date_of_capture + '</div></div>';
			}).join("");
	}
}


/* ==========  GREENHOUSE MODAL  ========== */

function showGreenhouseDetails(greenhouse) {
	var ghData = scoutingData.greenhouses[greenhouse];
	if (!ghData) return;
	_setText("#scout-gh-modal-title", greenhouse);
	var rangeInfo = getSelectedWeekRangeInfo();
	var fromWeek = rangeInfo?.from?.value || getIsoWeekString(new Date());
	var toWeek = rangeInfo?.to?.value || getIsoWeekString(new Date());
	_setText("#scout-gh-modal-period", fromWeek + " to " + toWeek + " (" + rangeInfo.fromDate + " to " + rangeInfo.toDate + ")");
	_setText("#ghk-pests", ghData.pests);
	_setText("#ghk-diseases", ghData.diseases);
	_setText("#ghk-traps", ghData.traps);
	_setText("#ghk-scouts", ghData.scoutCount);
	_setText("#ghk-alerts", ghData.alerts);

	/* pests */
	var pestCounts = {};
	Object.keys(scoutingData.pests).forEach(function (pest) {
		var cnt = scoutingData.pests[pest].counts.filter(function (c) { return c.greenhouse === greenhouse; }).length;
		if (cnt) pestCounts[pest] = cnt;
	});
	var pestEl = root_element.querySelector("#scout-gh-pests");
	if (pestEl)
		pestEl.innerHTML = Object.keys(pestCounts).slice(0, 5).map(function (p) {
			return '<div class="gh-var-row"><div class="gh-var-name">' + p + '</div><div class="gh-var-count">' + pestCounts[p] + '</div></div>';
		}).join("") || '<div style="padding:12px;color:var(--text-muted)">No pest data</div>';

	/* diseases */
	var disCounts = {};
	Object.keys(scoutingData.diseases).forEach(function (dis) {
		var cnt = scoutingData.diseases[dis].counts.filter(function (c) { return c.greenhouse === greenhouse; }).length;
		if (cnt) disCounts[dis] = cnt;
	});
	var disEl = root_element.querySelector("#scout-gh-diseases");
	if (disEl)
		disEl.innerHTML = Object.keys(disCounts).slice(0, 5).map(function (d) {
			return '<div class="gh-disease-row"><div class="gh-disease-name">' + d + '</div><div class="gh-disease-count">' + disCounts[d] + '</div></div>';
		}).join("") || '<div style="padding:12px;color:var(--text-muted)">No disease data</div>';

	/* traps */
	var trapCounts = {};
	Object.keys(scoutingData.traps).forEach(function (k) {
		var cnt = scoutingData.traps[k].counts.filter(function (c) { return c.greenhouse === greenhouse; }).length;
		if (cnt) { var name = scoutingData.traps[k].trap; trapCounts[name] = (trapCounts[name] || 0) + scoutingData.traps[k].total; }
	});
	var trapEl = root_element.querySelector("#scout-gh-traps");
	if (trapEl)
		trapEl.innerHTML = Object.keys(trapCounts).slice(0, 8).map(function (t) {
			return '<div class="gh-len-item"><div class="gh-len-val">' + trapCounts[t] + '</div><div class="gh-len-lbl">' + t + '</div></div>';
		}).join("") || '<div style="padding:12px;color:var(--text-muted)">No trap data</div>';

	updateGreenhouseTrendChart(greenhouse);
	var modal = root_element.querySelector("#scout-gh-modal");
	if (modal) modal.classList.add("active");
}

function updateGreenhouseTrendChart(greenhouse) {
	var ctx = root_element.querySelector("#scout-gh-trend-chart");
	if (!ctx) return;
	if (window.ghTrendChart) window.ghTrendChart.destroy();
	var daily = {};
	scoutingData.entries.forEach(function (e) {
		if (e.greenhouse !== greenhouse) return;
		var d = e.date_of_capture;
		if (!daily[d]) daily[d] = { pests: 0, diseases: 0, traps: 0 };
		daily[d].pests += (e.pests_scouting_entry || []).length;
		daily[d].diseases += (e.diseases_scouting_entry || []).length;
		daily[d].traps += (e.trap_scouting_entry || []).length;
	});
	var dates = Object.keys(daily).sort().slice(-14);
	window.ghTrendChart = new Chart(ctx, {
		type: "line",
		data: {
			labels: dates.map(function (d) { return d.slice(5); }),
			datasets: [
				{ label: "Pests", data: dates.map(function (d) { return daily[d].pests; }), borderColor: "#10b981", tension: 0.4 },
				{ label: "Diseases", data: dates.map(function (d) { return daily[d].diseases; }), borderColor: "#f59e0b", tension: 0.4 },
				{ label: "Traps", data: dates.map(function (d) { return daily[d].traps; }), borderColor: "#3b82f6", tension: 0.4 },
			],
		},
		options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: "rgba(0,0,0,.04)" } } } },
	});
}

function closeScoutModal() {
	var modal = root_element.querySelector("#scout-gh-modal");
	if (modal) modal.classList.remove("active");
}


/* ================================================================
 *  REPORTS MODULE
 *  "Reports ▾" dropdown with CSV + PDF export options.
 *  PDF reports include embedded Chart.js graphs and color-coded tables.
 * ================================================================ */

var SCOUTING_REPORTS_CSV = [
	{ key: "weekly_summary",       label: "Weekly Summary (Trap Counts)",  desc: "Light & pheromone trap moth counts per week",      fn: reportWeeklySummary },
	{ key: "scouting_summary",     label: "Scouting Summary",             desc: "Pest scouting (eggs/larvae/damages) per GH/week",  fn: reportScoutingSummary },
	{ key: "intake_qc",            label: "Intake QC Report",             desc: "Intake QC observations per GH per week",            fn: reportIntakeQc },
	{ key: "fcm_daily_monitoring", label: "FCM Daily Monitoring",         desc: "Trap-level FCM counts per GH per week",             fn: reportFcmDailyMonitoring },
	{ key: "fcm_risk_profiling",   label: "FCM Risk Profiling",           desc: "Greenhouse-level FCM risk scores",                  fn: reportFcmRiskProfiling },
];

var SCOUTING_REPORTS_PDF = [
	{ key: "pdf_full_report",      label: "Full Scouting Report",         desc: "Charts + tables for pests, diseases, traps",        fn: pdfFullReport },
	{ key: "pdf_pest_report",      label: "Pest Report",                  desc: "Pest trends, distribution & severity tables",       fn: pdfPestReport },
	{ key: "pdf_disease_report",   label: "Disease Report",               desc: "Disease trends, severity & incidents",              fn: pdfDiseaseReport },
	{ key: "pdf_trap_report",      label: "Trap & FCM Report",            desc: "Trap trends, FCM risk profiling table",             fn: pdfTrapReport },
];

/* jsPDF + autoTable lazy loader */
var _jsPdfLoaded = false;
var _jsPdfLoadPromise = null;

function ensureJsPdf() {
	if (_jsPdfLoaded && window.jspdf && window.jspdf.jsPDF) return Promise.resolve();
	if (_jsPdfLoadPromise) return _jsPdfLoadPromise;
	_jsPdfLoadPromise = new Promise(function (resolve, reject) {
		var s1 = document.createElement("script");
		s1.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.2/jspdf.umd.min.js";
		s1.onload = function () {
			var s2 = document.createElement("script");
			s2.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.4/jspdf.plugin.autotable.min.js";
			s2.onload = function () { _jsPdfLoaded = true; resolve(); };
			s2.onerror = function () { reject(new Error("Failed to load jspdf-autotable")); };
			document.head.appendChild(s2);
		};
		s1.onerror = function () { reject(new Error("Failed to load jsPDF")); };
		document.head.appendChild(s1);
	});
	return _jsPdfLoadPromise;
}

/* ── UI: dropdown with CSV + PDF sections ── */
function initReportsDropdown() {
	var oldBtn = root_element.querySelector("#scout-debug-fetch-btn");
	if (oldBtn) oldBtn.style.display = "none";
	var refreshBtn = root_element.querySelector("#scout-refresh-btn");
	if (!refreshBtn) return;
	var parent = refreshBtn.parentElement;

	var wrapper = document.createElement("div");
	wrapper.className = "scout-reports-dropdown";
	wrapper.style.cssText = "position:relative;display:inline-block;margin-left:8px;";

	var trigger = document.createElement("button");
	trigger.className = "btn btn-default btn-sm";
	trigger.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>Reports &#9662;';
	trigger.style.cssText = "padding:6px 14px;font-size:13px;border:1px solid var(--sd-border,#e4e4e7);border-radius:6px;cursor:pointer;background:var(--sd-card,#fff);color:var(--sd-text,#09090b);font-weight:500;display:inline-flex;align-items:center;gap:4px;transition:box-shadow .15s,border-color .15s;font-family:var(--sd-font,sans-serif);";
	trigger.addEventListener("mouseenter", function () { this.style.borderColor = "var(--sd-accent,#18181b)"; this.style.boxShadow = "0 0 0 2px rgba(24,24,27,.12)"; });
	trigger.addEventListener("mouseleave", function () { this.style.borderColor = "var(--sd-border,#e4e4e7)"; this.style.boxShadow = "none"; });

	var menu = document.createElement("div");
	menu.style.cssText = "display:none;position:absolute;right:0;top:calc(100% + 6px);min-width:320px;background:var(--sd-card,#fff);border:1px solid var(--sd-border,#e4e4e7);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.14);z-index:9999;padding:0;overflow:hidden;";

	function addSection(text) {
		var h = document.createElement("div");
		h.style.cssText = "padding:10px 16px 6px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--sd-muted,#71717a);border-top:1px solid var(--sd-border,#e4e4e7);";
		h.textContent = text;
		menu.appendChild(h);
	}

	function addItem(report, format) {
		var item = document.createElement("div");
		item.style.cssText = "padding:9px 16px;cursor:pointer;transition:background .1s;display:flex;align-items:center;gap:10px;";
		var badge = document.createElement("span");
		badge.textContent = format.toUpperCase();
		badge.style.cssText = format === "pdf"
			? "font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;background:#18181b;color:#fff;letter-spacing:.3px;flex-shrink:0;"
			: "font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;background:#e4e4e7;color:#3f3f46;letter-spacing:.3px;flex-shrink:0;";
		var tw = document.createElement("div");
		tw.style.cssText = "flex:1;min-width:0;";
		tw.innerHTML = '<div style="font-weight:500;font-size:12px;color:var(--sd-text,#09090b)">' + report.label + '</div><div style="font-size:10px;color:var(--sd-muted,#71717a);margin-top:1px">' + report.desc + '</div>';
		item.appendChild(badge);
		item.appendChild(tw);
		item.addEventListener("mouseenter", function () { this.style.background = "var(--sd-bg,#fafafa)"; });
		item.addEventListener("mouseleave", function () { this.style.background = "transparent"; });
		item.addEventListener("click", function () {
			menu.style.display = "none";
			if (format === "csv") handleReportExport(report.key);
			else handlePdfExport(report.key);
		});
		menu.appendChild(item);
	}

	addSection("CSV Exports");
	SCOUTING_REPORTS_CSV.forEach(function (r) { addItem(r, "csv"); });
	addSection("PDF Reports (with charts)");
	SCOUTING_REPORTS_PDF.forEach(function (r) { addItem(r, "pdf"); });

	trigger.addEventListener("click", function (e) { e.stopPropagation(); menu.style.display = menu.style.display === "none" ? "block" : "none"; });
	document.addEventListener("click", function () { menu.style.display = "none"; });
	wrapper.appendChild(trigger);
	wrapper.appendChild(menu);
	parent.appendChild(wrapper);
}

/* ── CSV Dispatch ── */
function handleReportExport(reportKey) {
	if (!scoutingData || !scoutingData.entries?.length) { notifyUser("No scouting data loaded."); return; }
	var report = SCOUTING_REPORTS_CSV.find(function (r) { return r.key === reportKey; });
	if (!report) return;
	try {
		var csv = report.fn(scoutingData, scoutingYearData);
		if (!csv) { notifyUser("No data for " + report.label); return; }
		downloadCsvBlob(csv, report.key);
	} catch (err) { console.error("CSV error:", err); notifyUser("Failed: " + err.message); }
}

function downloadCsvBlob(csvText, reportKey) {
	var ri = getSelectedWeekRangeInfo();
	var fname = (farmFilter || "ALL") + "_" + reportKey + "_" + (ri?.from?.value || "x") + "_to_" + (ri?.to?.value || "x") + ".csv";
	var blob = new Blob(["\uFEFF" + csvText], { type: "text/csv;charset=utf-8" });
	var url = URL.createObjectURL(blob);
	var a = document.createElement("a"); a.href = url; a.download = fname;
	document.body.appendChild(a); a.click(); a.remove();
	URL.revokeObjectURL(url);
	notifyUser("Downloaded: " + fname);
}

/* ── PDF Dispatch ── */
function handlePdfExport(reportKey) {
	if (!scoutingData || !scoutingData.entries?.length) { notifyUser("No scouting data loaded."); return; }
	var report = SCOUTING_REPORTS_PDF.find(function (r) { return r.key === reportKey; });
	if (!report) return;
	notifyUser("Generating PDF — please wait…");
	ensureJsPdf().then(function () {
		try { report.fn(scoutingData, scoutingYearData); }
		catch (err) { console.error("PDF error:", err); notifyUser("Failed: " + err.message); }
	}).catch(function (err) { notifyUser("Could not load PDF library. Check connection."); });
}

/* ════════════════════════════════════════
   PDF HELPERS
   ════════════════════════════════════════ */
var PDF_C = {
	black: [24,24,27], dark: [63,63,70], mid: [113,113,122], light: [228,228,231],
	bg: [250,250,250], white: [255,255,255],
	redBg: [254,226,226], redTx: [185,28,28],
	amberBg: [254,243,199], amberTx: [146,64,14],
	greenBg: [220,252,231], greenTx: [22,101,52],
};

function pdfNew() { return new (window.jspdf.jsPDF)({ orientation: "landscape", unit: "mm", format: "a4" }); }

function pdfHeader(doc, title, sub) {
	var ri = getSelectedWeekRangeInfo();
	var farm = farmFilter || "All Farms";
	var period = ri ? ri.from.value + " → " + ri.to.value : "";
	doc.setFontSize(16); doc.setTextColor.apply(doc, PDF_C.black); doc.text(title, 14, 15);
	doc.setFontSize(8); doc.setTextColor.apply(doc, PDF_C.mid);
	doc.text(farm + "  ·  " + period + (sub ? "  ·  " + sub : ""), 14, 21);
	doc.setDrawColor.apply(doc, PDF_C.light); doc.line(14, 24, doc.internal.pageSize.getWidth() - 14, 24);
	return 30;
}

function pdfSection(doc, y, text) {
	doc.setFontSize(11); doc.setTextColor.apply(doc, PDF_C.black); doc.text(text, 14, y); return y + 6;
}

function pdfChart(doc, canvasId, y, maxH) {
	var c = root_element.querySelector("#" + canvasId);
	if (!c) return y;
	try {
		var img = c.toDataURL("image/png", 1.0);
		var pw = doc.internal.pageSize.getWidth() - 28;
		var r = c.height / c.width;
		var iw = pw, ih = iw * r;
		if (maxH && ih > maxH) { ih = maxH; iw = ih / r; }
		if (y + ih + 8 > doc.internal.pageSize.getHeight() - 10) { doc.addPage(); y = 14; }
		doc.addImage(img, "PNG", 14, y, iw, ih);
		return y + ih + 5;
	} catch (e) { return y; }
}

function pdfTwoCharts(doc, y, id1, id2, maxH) {
	var pw = doc.internal.pageSize.getWidth() - 28;
	var half = (pw - 6) / 2;
	var mh = maxH || 58;
	if (y + mh + 8 > doc.internal.pageSize.getHeight() - 10) { doc.addPage(); y = 14; }
	[{ id: id1, x: 14 }, { id: id2, x: 14 + half + 6 }].forEach(function (o) {
		var c = root_element.querySelector("#" + o.id);
		if (!c) return;
		try {
			var img = c.toDataURL("image/png", 1.0);
			var r = c.height / c.width;
			var ih = Math.min(half * r, mh);
			doc.addImage(img, "PNG", o.x, y, ih / r, ih);
		} catch (e) { /* skip */ }
	});
	return y + mh + 5;
}

function pdfPageCheck(doc, y, need) {
	if (y + need > doc.internal.pageSize.getHeight() - 12) { doc.addPage(); return 14; }
	return y;
}

function pdfFilename(key) {
	var ri = getSelectedWeekRangeInfo();
	return (farmFilter || "ALL") + "_" + key + "_" + (ri?.from?.value || "x") + "_to_" + (ri?.to?.value || "x") + ".pdf";
}

function pdfRiskColors(cat) {
	var c = (cat || "").toUpperCase();
	if (c.includes("HIGH")) return { f: PDF_C.redBg, t: PDF_C.redTx };
	if (c.includes("MEDIUM")) return { f: PDF_C.amberBg, t: PDF_C.amberTx };
	return { f: PDF_C.greenBg, t: PDF_C.greenTx };
}

/* color-coded severity cell hook */
function pdfSevHook(hookData, colIdx) {
	if (hookData.section !== "body") return;
	if (hookData.column.index === colIdx) {
		var v = (hookData.cell.raw || "").toLowerCase();
		if (v.includes("high") || v === "alert" || v.includes("critical")) { hookData.cell.styles.fillColor = PDF_C.redBg; hookData.cell.styles.textColor = PDF_C.redTx; }
		else if (v.includes("moderate") || v === "watch" || v.includes("medium")) { hookData.cell.styles.fillColor = PDF_C.amberBg; hookData.cell.styles.textColor = PDF_C.amberTx; }
		else { hookData.cell.styles.fillColor = PDF_C.greenBg; hookData.cell.styles.textColor = PDF_C.greenTx; }
	}
	if (hookData.column.index !== colIdx && hookData.row.index % 2 === 0) {
		hookData.cell.styles.fillColor = PDF_C.bg;
	}
}

var AT_BASE = { theme: "grid", styles: { fontSize: 7, cellPadding: 2, font: "helvetica" }, headStyles: { fillColor: PDF_C.black, textColor: PDF_C.white, fontStyle: "bold", fontSize: 7 }, margin: { left: 14, right: 14 } };

/* ════════════════════════════════════════
   PDF TABLE BUILDERS
   ════════════════════════════════════════ */
function _pdfPestTable(doc, y, data) {
	var rows = [];
	Object.keys(data.pests).forEach(function (p) {
		data.pests[p].counts.slice(0, 30).forEach(function (c) {
			var cnt = c.count || 1;
			rows.push([p, c.stage || "N/A", String(cnt), c.section || "N/A", c.date || "", c.greenhouse || "", cnt > 15 ? "High" : cnt > 5 ? "Moderate" : "Low"]);
		});
	});
	rows.sort(function (a, b) { return Number(b[2]) - Number(a[2]); });
	rows = rows.slice(0, 60);
	doc.autoTable(Object.assign({}, AT_BASE, {
		startY: y,
		head: [["Pest", "Stage", "Count", "Section", "Date", "Greenhouse", "Severity"]],
		body: rows,
		columnStyles: { 2: { halign: "center", fontStyle: "bold" }, 6: { halign: "center", fontStyle: "bold" } },
		didParseCell: function (h) { pdfSevHook(h, 6); },
	}));
	return doc.lastAutoTable.finalY + 4;
}

function _pdfDiseaseTable(doc, y, data) {
	var rows = [];
	Object.keys(data.diseases).forEach(function (d) {
		data.diseases[d].counts.slice(0, 30).forEach(function (c) {
			var sev = (c.stage || "").toLowerCase().includes("active") ? "High" : "Low";
			rows.push([d, c.stage || "N/A", sev, c.section || "N/A", c.date || "", c.greenhouse || ""]);
		});
	});
	rows.sort(function (a, b) { return b[4].localeCompare(a[4]); });
	rows = rows.slice(0, 60);
	doc.autoTable(Object.assign({}, AT_BASE, {
		startY: y,
		head: [["Disease", "Stage", "Severity", "Section", "Date", "Greenhouse"]],
		body: rows,
		columnStyles: { 2: { halign: "center", fontStyle: "bold" } },
		didParseCell: function (h) { pdfSevHook(h, 2); },
	}));
	return doc.lastAutoTable.finalY + 4;
}

function _pdfTrapTable(doc, y, data) {
	var rows = [];
	Object.keys(data.traps).forEach(function (k) {
		var t = data.traps[k];
		t.counts.slice(0, 20).forEach(function (c) {
			var cnt = c.count || 0;
			rows.push([t.trap, t.pest, String(cnt), c.location || "N/A", c.date || "", c.greenhouse || "", cnt > 10 ? "Alert" : cnt > 3 ? "Watch" : "Normal"]);
		});
	});
	rows.sort(function (a, b) { return Number(b[2]) - Number(a[2]); });
	rows = rows.slice(0, 60);
	doc.autoTable(Object.assign({}, AT_BASE, {
		startY: y,
		head: [["Trap ID", "Pest", "Count", "Location", "Date", "Greenhouse", "Status"]],
		body: rows,
		columnStyles: { 2: { halign: "center", fontStyle: "bold" }, 6: { halign: "center", fontStyle: "bold" } },
		didParseCell: function (h) { pdfSevHook(h, 6); },
	}));
	return doc.lastAutoTable.finalY + 4;
}

function _pdfRiskTable(doc, y, data, yearData) {
	var src = yearData || data;
	var ghNums = _rGetAllGhNumbers(src);
	var scores = {};
	ghNums.forEach(function (n) { scores[n] = { ghNum: n, variety: "", score: 0 }; });
	(src.entries || []).forEach(function (e) {
		var n = _rGetGhNumber(e.greenhouse);
		if (!n || !scores[n]) return;
		var vm = (e.greenhouse || "").match(/[-\u2013]\s*(.+)$/);
		if (vm && !scores[n].variety) scores[n].variety = vm[1].trim().toUpperCase();
		(e.pests_scouting_entry || []).forEach(function (p) { if (_rClassifyPest(p.pest || "") === "fcm") scores[n].score += toNumber(p.count || 1); });
		(e.trap_scouting_entry || []).forEach(function (t) { if (_rClassifyPest(t.pest || "") === "fcm") scores[n].score += toNumber(t.count || 0); });
	});
	var sorted = Object.values(scores).sort(function (a, b) { return b.score - a.score; });
	var rows = sorted.map(function (g) {
		var cat = g.score >= 8 ? "HIGH RISK" : g.score >= 4 ? "MEDIUM RISK" : "LOW RISK";
		return [String(g.ghNum), "GH " + g.ghNum + (g.variety ? " - " + g.variety : ""), String(g.score), cat, cat === "HIGH RISK" ? "Immediate spray + monitoring" : cat === "MEDIUM RISK" ? "Planned spray + egg crushing" : "Routine monitoring"];
	});
	doc.autoTable(Object.assign({}, AT_BASE, {
		startY: y, styles: { fontSize: 7.5, cellPadding: 2.5, font: "helvetica" },
		head: [["No.", "Greenhouse / Variety", "Score", "Category", "Corrective Action"]],
		body: rows,
		columnStyles: { 0: { halign: "center", cellWidth: 12 }, 2: { halign: "center", fontStyle: "bold", cellWidth: 16 }, 3: { halign: "center", fontStyle: "bold", cellWidth: 30 } },
		didParseCell: function (h) {
			if (h.section !== "body") return;
			if (h.column.index === 3) { var rc = pdfRiskColors(h.cell.raw); h.cell.styles.fillColor = rc.f; h.cell.styles.textColor = rc.t; }
			if (h.column.index === 2) {
				var s = Number(h.cell.raw) || 0;
				if (s >= 8) { h.cell.styles.fillColor = PDF_C.redBg; h.cell.styles.textColor = PDF_C.redTx; }
				else if (s >= 4) { h.cell.styles.fillColor = PDF_C.amberBg; h.cell.styles.textColor = PDF_C.amberTx; }
				else { h.cell.styles.fillColor = PDF_C.greenBg; h.cell.styles.textColor = PDF_C.greenTx; }
			}
			if (h.column.index !== 2 && h.column.index !== 3 && h.row.index % 2 === 0) h.cell.styles.fillColor = PDF_C.bg;
		},
	}));
	return doc.lastAutoTable.finalY + 4;
}

/* ════════════════════════════════════════
   PDF REPORT GENERATORS
   ════════════════════════════════════════ */
function pdfFullReport(data, yearData) {
	var doc = pdfNew();
	var y = pdfHeader(doc, "Scouting Report — Full Overview", "All categories");
	y = pdfSection(doc, y, "Activity Timeline");
	y = pdfChart(doc, "overview-timeline-chart", y, 55);
	y = pdfPageCheck(doc, y, 70);
	y = pdfSection(doc, y, "Pest Trends (Weekly)");
	y = pdfChart(doc, "pest-weekly-trend-chart", y, 55);
	y = pdfPageCheck(doc, y, 70);
	y = pdfSection(doc, y, "Disease Trends (Weekly)");
	y = pdfChart(doc, "disease-weekly-trend-chart", y, 55);
	y = pdfPageCheck(doc, y, 70);
	y = pdfSection(doc, y, "Trap Trends (Weekly)");
	y = pdfChart(doc, "trap-weekly-trend-chart", y, 55);
	doc.addPage(); y = 14;
	y = pdfSection(doc, y, "Pest Summary"); y = _pdfPestTable(doc, y, data);
	y = pdfPageCheck(doc, y + 6, 40);
	y = pdfSection(doc, y, "Disease Incidents"); y = _pdfDiseaseTable(doc, y, data);
	y = pdfPageCheck(doc, y + 6, 40);
	y = pdfSection(doc, y, "Trap Details"); y = _pdfTrapTable(doc, y, data);
	doc.addPage(); y = 14;
	y = pdfSection(doc, y, "FCM Risk Profiling"); y = _pdfRiskTable(doc, y, data, yearData);
	doc.save(pdfFilename("full_report"));
	notifyUser("PDF Full Report downloaded.");
}

function pdfPestReport(data, yearData) {
	var doc = pdfNew();
	var y = pdfHeader(doc, "Pest Scouting Report", null);
	y = pdfSection(doc, y, "Weekly Pest Trends");
	y = pdfChart(doc, "pest-weekly-trend-chart", y, 60);
	y = pdfPageCheck(doc, y, 70);
	y = pdfSection(doc, y, "Incidence & Distribution");
	y = pdfTwoCharts(doc, y, "pest-trend-chart", "pest-distribution-chart", 55);
	y = pdfPageCheck(doc, y, 65);
	y = pdfSection(doc, y, "Plant Section Split");
	y = pdfChart(doc, "pest-section-chart", y, 55);
	doc.addPage(); y = 14;
	y = pdfSection(doc, y, "Pest Stage Breakdown");
	y = _pdfPestTable(doc, y, data);
	doc.save(pdfFilename("pest_report"));
	notifyUser("PDF Pest Report downloaded.");
}

function pdfDiseaseReport(data, yearData) {
	var doc = pdfNew();
	var y = pdfHeader(doc, "Disease Scouting Report", null);
	y = pdfSection(doc, y, "Weekly Disease Trends");
	y = pdfChart(doc, "disease-weekly-trend-chart", y, 60);
	y = pdfPageCheck(doc, y, 70);
	y = pdfSection(doc, y, "Incidence & Distribution");
	y = pdfTwoCharts(doc, y, "disease-trend-chart", "disease-distribution-chart", 55);
	y = pdfPageCheck(doc, y, 65);
	y = pdfSection(doc, y, "Stage Distribution");
	y = pdfChart(doc, "disease-stage-chart", y, 55);
	doc.addPage(); y = 14;
	y = pdfSection(doc, y, "Disease Incidents");
	y = _pdfDiseaseTable(doc, y, data);
	doc.save(pdfFilename("disease_report"));
	notifyUser("PDF Disease Report downloaded.");
}

function pdfTrapReport(data, yearData) {
	var doc = pdfNew();
	var y = pdfHeader(doc, "Trap & FCM Report", null);
	y = pdfSection(doc, y, "Weekly Trap Trends");
	y = pdfChart(doc, "trap-weekly-trend-chart", y, 60);
	y = pdfPageCheck(doc, y, 70);
	y = pdfSection(doc, y, "Performance & Pest Breakdown");
	y = pdfTwoCharts(doc, y, "trap-performance-chart", "trap-pest-breakdown", 55);
	doc.addPage(); y = 14;
	y = pdfSection(doc, y, "Trap Details");
	y = _pdfTrapTable(doc, y, data);
	y = pdfPageCheck(doc, y + 8, 40);
	y = pdfSection(doc, y, "FCM Risk Profiling");
	y = _pdfRiskTable(doc, y, data, yearData);
	doc.save(pdfFilename("trap_fcm_report"));
	notifyUser("PDF Trap & FCM Report downloaded.");
}

/* ── Shared report helpers ── */

function _rGetGhNumber(greenhouse) {
	var m = String(greenhouse || "").trim().match(/(?:GH|House)\s*0*(\d+)/i);
	return m ? Number(m[1]) : null;
}

function _rGetAllGhNumbers(data) {
	var nums = new Set();
	(data.entries || []).forEach(function (e) { var n = _rGetGhNumber(e.greenhouse); if (n) nums.add(n); });
	return Array.from(nums).sort(function (a, b) { return a - b; });
}

function _rGetWeekKeys(data) {
	var weeks = new Set();
	(data.entries || []).forEach(function (e) {
		if (e.date_of_capture) weeks.add(getIsoWeekString(new Date(e.date_of_capture + "T00:00:00Z")));
	});
	return Array.from(weeks).sort();
}

function _rWeekEntries(entries, weekKey) {
	return (entries || []).filter(function (e) {
		return e.date_of_capture && getIsoWeekString(new Date(e.date_of_capture + "T00:00:00Z")) === weekKey;
	});
}

function _rWeekNum(weekKey) { var m = weekKey.match(/W(\d+)/); return m ? Number(m[1]) : 0; }

function _rWeekDateRange(weekKey) {
	var p = parseWeekValue(weekKey);
	if (!p) return { from: "", to: "" };
	var r = getIsoWeekDateRange(p.year, p.week);
	return { from: r.fromDate, to: r.toDate };
}

function _rFormatDateHuman(dateStr) {
	if (!dateStr) return "";
	var d = new Date(dateStr + "T00:00:00Z");
	var day = d.getUTCDate();
	var suf = (day === 1 || day === 21 || day === 31) ? "st" : (day === 2 || day === 22) ? "nd" : (day === 3 || day === 23) ? "rd" : "th";
	var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	return day + suf + " " + months[d.getUTCMonth()] + " " + d.getUTCFullYear();
}

function _rMonthName(dateStr) {
	var months = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
	var d = new Date(dateStr + "T00:00:00Z");
	return months[d.getUTCMonth()] || "";
}

function _rClassifyPest(name) {
	var s = (name || "").toLowerCase();
	if (s.includes("fcm") || s.includes("false codling")) return "fcm";
	if (s.includes("helicoverpa") || s.includes("helioverpa")) return "helicoverpa";
	if (s.includes("spodoptera") || s.includes("armyworm")) return "spodoptera";
	if (s.includes("duponchel")) return "duponchella";
	return "others";
}

function _rClassifyStage(stage) {
	var s = (stage || "").toLowerCase();
	if (s.includes("egg")) return "eggs";
	if (s.includes("larv")) return "larvae";
	if (s.includes("damage") || s.includes("damag")) return "damages";
	if (s.includes("adult")) return "adults";
	return "eggs";
}

/* ── Report 1: Weekly Summary ── */

function reportWeeklySummary(data, yearData) {
	var src = yearData || data;
	var ri = getSelectedWeekRangeInfo();
	var year = ri?.from?.year || new Date().getFullYear();
	var farm = farmFilter || "All Farms";
	var weeks = _rGetWeekKeys(src);
	var rows = [];
	rows.push(csvRow(["Production Site Name", "", "", "", "Year", year, "", "", "", "", "", "", ""]));
	rows.push(csvRow([farm]));
	rows.push(csvRow(["LIGHT AND PHEROMONE TRAPS INSECT/MOTH TOTAL COUNTS SUMMARY/ANALYSIS " + year]));
	rows.push(csvRow(["Month of count", "Week of the year", "FCM adults (light)", "FCM adults (pheromone)", "New Cases of FCM Adults", "Helicoverpa adults (light trap)", "Spodoptera adults (light trap)", "Helicoverpa adults (Lure Trap)", "Spodoptera adults (Lure Trap)", "Others (light)", "Temperature (oC)", "", "Rainfall (mm)"]));
	rows.push(csvRow(["", "", "", "", "", "", "", "", "", "", "Min.", "Max.", ""]));

	var lastMonth = "";
	weeks.forEach(function (wk) {
		var wkEntries = _rWeekEntries(src.entries, wk);
		var tc = { fcm_ph: 0, fcm_lt: 0, heli_lure: 0, heli_lt: 0, spod_lure: 0, spod_lt: 0, others: 0 };
		wkEntries.forEach(function (e) {
			(e.trap_scouting_entry || []).forEach(function (t) {
				var cls = _rClassifyPest(t.pest || "");
				var cnt = toNumber(t.count || 0);
				var loc = (t.location || t.trap || "").toLowerCase();
				var isLure = loc.includes("pheromone") || loc.includes("lure") || loc.includes("delta");
				if (cls === "fcm") { if (isLure) tc.fcm_ph += cnt; else tc.fcm_lt += cnt; }
				else if (cls === "helicoverpa") { if (isLure) tc.heli_lure += cnt; else tc.heli_lt += cnt; }
				else if (cls === "spodoptera") { if (isLure) tc.spod_lure += cnt; else tc.spod_lt += cnt; }
				else tc.others += cnt;
			});
		});
		var dr = _rWeekDateRange(wk);
		var month = _rMonthName(dr.from);
		var show = month !== lastMonth ? month : "";
		lastMonth = month;
		rows.push(csvRow([show, "WK " + String(_rWeekNum(wk)).padStart(2, "0"), tc.fcm_lt || "", tc.fcm_ph || "", "", tc.heli_lt || "", tc.spod_lt || "", tc.heli_lure || "", tc.spod_lure || "", tc.others || "", "", "", ""]));
	});
	return rows.join("\r\n");
}

/* ── Report 2 & 3: Scouting Summary / Intake QC (same grid format) ── */

function reportScoutingSummary(data, yearData) { return _rGhWeeklyGrid(yearData || data); }
function reportIntakeQc(data, yearData) { return _rGhWeeklyGrid(yearData || data); }

function _rGhWeeklyGrid(src) {
	var ri = getSelectedWeekRangeInfo();
	var year = ri?.from?.year || new Date().getFullYear();
	var farm = farmFilter || "All Farms";
	var ghNums = _rGetAllGhNumbers(src);
	if (!ghNums.length) ghNums = Array.from({ length: 19 }, function (_, i) { return i + 1; });
	var weeks = _rGetWeekKeys(src);
	var rows = [];
	rows.push(csvRow(["Production Site Name", "", "", "", "Year", year]));
	rows.push(csvRow([farm]));
	rows.push(csvRow(["", "", "FCM", "", "", "Helicoverpa", "", "", "Others", "", "", ""]));
	rows.push(csvRow(["Period", "GH No.", "Eggs", "Larvae", "Damages", "Eggs", "Larvae", "Damages", "Eggs", "Larvae", "Damages", "Remarks (Corrective action)"]));

	weeks.forEach(function (wk) {
		var wn = _rWeekNum(wk);
		var dr = _rWeekDateRange(wk);
		var wkEntries = _rWeekEntries(src.entries, wk);

		var byGh = {};
		ghNums.forEach(function (n) { byGh[n] = { fcm: { e: 0, l: 0, d: 0 }, heli: { e: 0, l: 0, d: 0 }, others: { e: 0, l: 0, d: 0 } }; });

		wkEntries.forEach(function (e) {
			var n = _rGetGhNumber(e.greenhouse);
			if (!n || !byGh[n]) return;
			var g = byGh[n];
			(e.pests_scouting_entry || []).forEach(function (p) {
				var cls = _rClassifyPest(p.pest || "");
				var st = _rClassifyStage(p.stage || "");
				var cnt = toNumber(p.count || 1);
				var bucket = cls === "fcm" ? g.fcm : cls === "helicoverpa" ? g.heli : g.others;
				if (st === "eggs") bucket.e += cnt; else if (st === "larvae") bucket.l += cnt; else bucket.d += cnt;
			});
			/* diseases are not counted in pest stage columns */
		});

		ghNums.forEach(function (ghNum, idx) {
			var g = byGh[ghNum];
			var period = idx === 0 ? "Week " + String(wn).padStart(2, "0")
				: idx === 1 ? "FROM: " + _rFormatDateHuman(dr.from)
				: idx === 2 ? "TO: " + _rFormatDateHuman(dr.to) : "";
			rows.push(csvRow([period, ghNum, g.fcm.e, g.fcm.l, g.fcm.d, g.heli.e, g.heli.l, g.heli.d, g.others.e, g.others.l, g.others.d, ""]));
		});
		rows.push(csvRow([]));
	});
	return rows.join("\r\n");
}

/* ── Report 4: FCM Daily Monitoring ── */

function reportFcmDailyMonitoring(data, yearData) {
	var src = yearData || data;
	var ri = getSelectedWeekRangeInfo();
	var year = ri?.from?.year || new Date().getFullYear();
	var weeks = _rGetWeekKeys(src);
	var rows = [];
	rows.push(csvRow(["Production Site Name", "", "", "", "Year", year]));
	rows.push(csvRow([]));
	rows.push(csvRow(["", "", "FCM COUNTS"]));
	rows.push(csvRow(["Week of the year", "Greenhouse No./Identity", "Trap No.", "Source (supplier) of pheromone lure", "Pheromone placement date", "Date of count", "No. of FCM adults inside greenhouse", "Cumulative No. of eggs/larvae observed", "No. of FCM adults outside greenhouse"]));

	weeks.forEach(function (wk) {
		var wn = _rWeekNum(wk);
		var dr = _rWeekDateRange(wk);
		var wkEntries = _rWeekEntries(src.entries, wk);
		var ghMap = {};

		wkEntries.forEach(function (e) {
			var ghNum = _rGetGhNumber(e.greenhouse);
			if (!ghNum) return;
			if (!ghMap[ghNum]) ghMap[ghNum] = { traps: [], cumEggs: 0 };
			(e.trap_scouting_entry || []).forEach(function (t) {
				if (_rClassifyPest(t.pest || "") !== "fcm") return;
				var loc = (t.location || "").toLowerCase();
				ghMap[ghNum].traps.push({ trapNo: t.trap || "", count: toNumber(t.count || 0), inside: !loc.includes("outside") });
			});
			(e.pests_scouting_entry || []).forEach(function (p) {
				if (_rClassifyPest(p.pest || "") !== "fcm") return;
				ghMap[ghNum].cumEggs += toNumber(p.count || 1);
			});
		});

		var ghNums = Object.keys(ghMap).map(Number).sort(function (a, b) { return a - b; });
		var isFirst = true;
		var totIn = 0, totOut = 0;

		ghNums.forEach(function (ghNum, gi) {
			var gd = ghMap[ghNum];
			var trapList = gd.traps.length ? gd.traps : [{ trapNo: "", count: 0, inside: true }];
			trapList.forEach(function (trap, ti) {
				var weekCol = "", dateCol = "";
				if (isFirst) { weekCol = "Week " + String(wn).padStart(2, "0"); dateCol = "FROM: " + _rFormatDateHuman(dr.from); isFirst = false; }
				else if (gi === 1 && ti === 0) { weekCol = "FROM: " + _rFormatDateHuman(dr.from); dateCol = "TO: " + _rFormatDateHuman(dr.to); }
				else if (gi === 2 && ti === 0) { weekCol = "TO: " + _rFormatDateHuman(dr.to); }
				var ghLabel = ti === 0 ? "House " + String(ghNum).padStart(2, "0") : "";
				var inVal = trap.inside ? trap.count : "";
				var outVal = !trap.inside ? trap.count : "";
				if (trap.inside) totIn += trap.count; else totOut += trap.count;
				rows.push(csvRow([weekCol, ghLabel, trap.trapNo, "KOPPERT", "", dateCol, inVal, ti === 0 ? gd.cumEggs : "", outVal]));
			});
		});
		if (ghNums.length) rows.push(csvRow(["", "", "", "", "", "", totIn, "", totOut]));
		rows.push(csvRow([]));
	});
	return rows.join("\r\n");
}

/* ── Report 5: FCM Risk Profiling ── */

function reportFcmRiskProfiling(data, yearData) {
	var src = yearData || data;
	var farm = farmFilter || "All Farms";
	var latestDate = "";
	(src.entries || []).forEach(function (e) { if (e.date_of_capture > latestDate) latestDate = e.date_of_capture; });
	var monthName = latestDate ? _rMonthName(latestDate) : "UNKNOWN";

	var ghNums = _rGetAllGhNumbers(src);
	var scores = {};
	ghNums.forEach(function (n) { scores[n] = { ghNum: n, variety: "", score: 0 }; });

	(src.entries || []).forEach(function (e) {
		var n = _rGetGhNumber(e.greenhouse);
		if (!n || !scores[n]) return;
		/* extract variety from greenhouse name if present (e.g. "CHEPSITO GH 3 - MOONWALK") */
		var varMatch = (e.greenhouse || "").match(/[-–]\s*(.+)$/);
		if (varMatch && !scores[n].variety) scores[n].variety = varMatch[1].trim().toUpperCase();
		(e.pests_scouting_entry || []).forEach(function (p) { if (_rClassifyPest(p.pest || "") === "fcm") scores[n].score += toNumber(p.count || 1); });
		(e.trap_scouting_entry || []).forEach(function (t) { if (_rClassifyPest(t.pest || "") === "fcm") scores[n].score += toNumber(t.count || 0); });
	});

	var sorted = Object.values(scores).sort(function (a, b) { return b.score - a.score; });
	sorted.forEach(function (g) { g.category = g.score >= 8 ? "HIGH RISK" : g.score >= 4 ? "MEDIUM RISK" : "LOW RISK"; });

	var rows = [];
	rows.push(csvRow(["Production Site Name", "", farm, "Month/Year", monthName]));
	rows.push(csvRow([]));
	rows.push(csvRow(["", "FCM RISK PROFILE PER GREENHOUSE/VARIETY"]));
	rows.push(csvRow(["NO.", "GREENHOUSE / VARIETY", "LEVEL OF SUSCEPTIBILITY (SCORES)", "CATEGORY", "CORRECTIVE ACTION"]));

	sorted.forEach(function (g) {
		var label = "GH " + g.ghNum + (g.variety ? " - " + g.variety : "");
		var action = g.category === "HIGH RISK" ? "Immediate spray and enhanced monitoring" : g.category === "MEDIUM RISK" ? "Planned spray and egg crushing" : "";
		rows.push(csvRow([g.ghNum, label, g.score, g.category, action]));
	});
	rows.push(csvRow([]));
	rows.push(csvRow(["", "Score 1-3: Low risk"]));
	rows.push(csvRow(["", "Score 4-7: Medium risk"]));
	rows.push(csvRow(["", "Score 8+: High risk"]));
	return rows.join("\r\n");
}