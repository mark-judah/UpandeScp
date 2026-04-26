/* ================================================================
 *  SCOUTING DASHBOARD  –  Full Rewrite
 *  Includes:  Reports dropdown (5 CSV exports), UI polish,
 *             bug-fixes (normalizeFocusName .trim() typo, etc.)
 * ================================================================ */

var root_element =
	document.getElementById("scouting-dashboard-root") || document;

/* ---------- Chart libraries bootstrap ----------
   Chart.js is still used by the Pests / Diseases / Traps / FCM tabs.
   ECharts powers the Overview tab (and click-to-zoom modal). */
function _loadScript(src) {
	return new Promise(function (resolve, reject) {
		var s = document.createElement("script");
		s.src = src;
		s.onload = function () { resolve(); };
		s.onerror = function () { reject(new Error("Failed to load " + src)); };
		document.head.appendChild(s);
	});
}

(function bootstrapChartLibs() {
	var pending = [];
	if (typeof Chart === "undefined") {
		pending.push(_loadScript("https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"));
	}
	if (typeof echarts === "undefined") {
		pending.push(_loadScript("https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"));
	}
	Promise.all(pending).then(initScoutingDashboard).catch(function (err) {
		console.error("Scouting dashboard: chart library bootstrap failed", err);
	});
})();

/* ==========  GLOBAL STATE  ========== */

var pestTrendChart,
	pestDistChart,
	pestSectionChart;
var diseaseTrendChart,
	diseaseDistChart,
	diseaseStageChart;
var trapTrendChart,
	trapPerfChart,
	trapPestChart,
	fcmMothTrendChart;
var pestWeeklyTrendChart,
	diseaseWeeklyTrendChart,
	trapWeeklyTrendChart;
/* Overview tab + scout-perf charts are managed by echartRegistry (see ECharts section). */
var pestGhChart, pestBedChart;
var diseaseGhChart, diseaseBedChart;
var trapGhChart, trapIndoorOutdoorChart;

var scoutingData = null;
var scoutingYearData = null;
var greenhouseFilter = "";
var farmFilter = "";
var allGreenhouses = [];
/* Canonical {farm: [greenhouse_name, ...]} map from scouting_metrics_api.
   Populated by loadGreenhouseOptions; falls back to parsing the greenhouse
   name for data that hasn't synced through yet. */
var farmsAndGreenhouses = {};
var greenhouseToFarm = {};
var activeTab = "overview";          // default to overview on load
var scoutingAnalysis = null;
var observationColors = { pests: {}, diseases: {} };
var zonesPerGreenhouse = {};

/* Monthly-chunk cache. Invalidated whenever greenhouse or ISO-week year changes.
   Period data (selected range) renders as soon as its months land; the rest of
   the year is prefetched silently afterwards for instant range-switches. */
var monthCache = { key: null, months: {} };
var metaCache = null;
var prefetchToken = 0;

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
	/* Canonical lookup first (custom_farm from Warehouse). */
	if (greenhouseToFarm[gh]) return greenhouseToFarm[gh];
	/* Fallback: parse the GH name (handles data the backend hasn't fed us yet). */
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
	if (!isFinite(num)) return "0";
	return num.toLocaleString("en-US");
}

function formatCompactNumber(num) {
	if (num == null) return "0";
	num = Number(num);
	if (!isFinite(num)) return "0";
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

function monthKeyFromDate(dateStr) {
	return (dateStr || "").slice(0, 7);
}

function monthBounds(monthKey) {
	var parts = monthKey.split("-");
	var y = Number(parts[0]);
	var m = Number(parts[1]);
	var lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
	return {
		fromDate: monthKey + "-01",
		toDate: monthKey + "-" + String(lastDay).padStart(2, "0"),
	};
}

function getMonthKeysBetween(fromDate, toDate) {
	var fParts = fromDate.split("-");
	var tParts = toDate.split("-");
	var y = Number(fParts[0]), m = Number(fParts[1]);
	var ty = Number(tParts[0]), tm = Number(tParts[1]);
	var keys = [];
	while (y < ty || (y === ty && m <= tm)) {
		keys.push(y + "-" + String(m).padStart(2, "0"));
		m++;
		if (m > 12) { m = 1; y++; }
	}
	return keys;
}

function getYearMonthKeys(fromYear, toYear) {
	var keys = [];
	for (var y = fromYear; y <= toYear; y++) {
		for (var m = 1; m <= 12; m++) {
			keys.push(y + "-" + String(m).padStart(2, "0"));
		}
	}
	return keys;
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

function getTotalZonesForGreenhouses(entries) {
	var greenhouses = Array.from(new Set((entries || []).map(function (e) { return e.greenhouse; }).filter(Boolean)));
	var total = 0;
	greenhouses.forEach(function (gh) { total += (zonesPerGreenhouse[gh] || 0); });
	return total || getTotalBedsForDistribution(entries);
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

/* Daily axis helper – one entry per calendar day in the selected range */
function getDayRangeAxis(rangeInfo) {
	if (!rangeInfo?.fromDate || !rangeInfo?.toDate) return null;
	var start = new Date(rangeInfo.fromDate + "T00:00:00Z");
	var end   = new Date(rangeInfo.toDate   + "T00:00:00Z");
	var keys = [], labels = [];
	for (var d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
		var ymd = formatDateYmd(d);
		keys.push(ymd);
		labels.push(ymd.slice(5)); /* MM-DD */
	}
	return { keys: keys, labels: labels };
}

/* Like buildWeeklyBedInfectionSeries but keyed on calendar date */
function buildDailyBedInfectionSeries(counts, axis, dayIndex, totalBeds, includeFn) {
	var dailySets = axis.keys.map(function () { return new Set(); });
	(counts || []).forEach(function (c) {
		if (includeFn && !includeFn(c)) return;
		var idx = dayIndex[c.date];
		if (idx === undefined) return;
		var bedKey = getDistributionBedKey(c);
		if (!bedKey) return;
		dailySets[idx].add(bedKey);
	});
	return dailySets.map(function (s) {
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

/* ---------- Color extraction from pest/disease doctype lists ---------- */

function extractObservationColors(pestColors, diseaseColors) {
	var colors = { pests: {}, diseases: {} };
	(pestColors || []).forEach(function (p) {
		if (p.name && p.pests_legend_color) colors.pests[p.name] = p.pests_legend_color;
	});
	(diseaseColors || []).forEach(function (d) {
		if (d.name && d.disease_legend_color) colors.diseases[d.name] = d.disease_legend_color;
	});
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

	function _rawEntryHasAnyObservation(row) {
		var keys = [
			"pests_scouting_entry", "pests",
			"diseases_scouting_entry", "diseases",
			"trap_scouting_entry", "traps",
			"predators_scouting_entry", "predators",
			"weeds_scouting_entry", "weeds",
			"incidents_scouting_entry", "incidents",
			"physiological_disorders_entry", "physiological_disorders",
		];
		return keys.some(function (k) { return Array.isArray(row[k]) && row[k].length > 0; });
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
		if (_rawEntryHasAnyObservation(row)) target._hasAnyObs = true;
	});

	var merged = Object.values(byName)
		.filter(function (e) { return e._hasAnyObs === true; })
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
	).then(function (r) { return r.message || {}; });
}

function loadGreenhouseOptions() {
	/* Canonical source: scouting_metrics_api.get_farms_and_greenhouses returns
	   {farm: [greenhouse_name, ...]} from the Warehouse doctype (active,
	   warehouse_type='Greenhouse'). Falls back to deriving from Scouting
	   Entry rows if the new endpoint isn't available yet (e.g. during
	   rollout). */
	return callFrappe(
		"upande_scp.serverscripts.scouting_metrics_api.get_farms_and_greenhouses",
		{}
	).then(function (r) {
		var map = r && r.message;
		if (!map || typeof map !== "object") throw new Error("empty farms/greenhouses");
		farmsAndGreenhouses = map;
		greenhouseToFarm = {};
		var flat = [];
		Object.keys(map).forEach(function (farm) {
			(map[farm] || []).forEach(function (gh) {
				flat.push(gh);
				greenhouseToFarm[gh] = farm;
			});
		});
		allGreenhouses = [...new Set(flat.filter(Boolean))];
		renderFarmOptions();
		renderGreenhouseOptionsForFarm();
	}).catch(function () {
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
				data.traps[key].counts.push({ date: date, count: cnt, location: loc, greenhouse: greenhouse, bed: entry.bed || "" });
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
	var greenhouseSelect = root_element.querySelector("#scout-greenhouse-filter");
	var farmSelect = root_element.querySelector("#scout-farm-filter");

	if (!weekFromInput || !weekToInput || !greenhouseSelect || !farmSelect) {
		if (SCOUTING_DASHBOARD_DEBUG)
			console.error("Scouting dashboard: missing required DOM elements");
		return;
	}

	Promise.all([
		loadGreenhouseOptions(),
		setDefaultWeekInputsToLatestScouting(weekFromInput, weekToInput),
	]).then(function () { fetchScoutingData(); });

	// Debounced auto-refresh — listen on both `change` and `input` so picker
	// commits and typed edits both fire the refresh.
	var debouncedRefresh = _debounce(refreshAllData, 250);
	weekFromInput.addEventListener("change", debouncedRefresh);
	weekFromInput.addEventListener("input", debouncedRefresh);
	weekToInput.addEventListener("change", debouncedRefresh);
	weekToInput.addEventListener("input", debouncedRefresh);
	/* Farm-first: greenhouse select is disabled until a farm is chosen */
	updateGreenhouseSelectState();

	farmSelect.addEventListener("change", function (e) {
		farmFilter = e.target.value || "";
		greenhouseFilter = "";
		renderGreenhouseOptionsForFarm();
		updateGreenhouseSelectState();
		debouncedRefresh();
	});
	greenhouseSelect.addEventListener("change", function (e) {
		greenhouseFilter = e.target.value;
		debouncedRefresh();
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

/* Rebuild stage dropdown for pests: empty when "All Pests" selected */
function rebuildPestStageOptions() {
	var stageSel = root_element.querySelector("#pest-weekly-stage-filter");
	var pestSel  = root_element.querySelector("#pest-weekly-pest-filter");
	if (!stageSel || !pestSel) return;
	var selectedPest = pestSel.value;
	if (selectedPest && scoutingYearData && (scoutingYearData.pests || {})[selectedPest]) {
		var stages = new Set();
		((scoutingYearData.pests[selectedPest] || {}).counts || []).forEach(function (c) {
			if (c.stage) stages.add(c.stage);
		});
		stageSel.disabled = false;
		setSelectOptions(
			stageSel,
			[{ value: "", label: "All Stages" }].concat(
				Array.from(stages).sort().map(function (s) { return { value: s, label: s }; })
			)
		);
	} else {
		setSelectOptions(stageSel, [{ value: "", label: "Select a pest first" }]);
		stageSel.disabled = true;
	}
}

/* Rebuild stage dropdown for diseases: empty when "All Diseases" selected */
function rebuildDiseaseStageOptions() {
	var stageSel   = root_element.querySelector("#disease-weekly-stage-filter");
	var diseaseSel = root_element.querySelector("#disease-weekly-disease-filter");
	if (!stageSel || !diseaseSel) return;
	var selectedDisease = diseaseSel.value;
	if (selectedDisease && scoutingYearData && (scoutingYearData.diseases || {})[selectedDisease]) {
		var stages = new Set();
		Object.keys((scoutingYearData.diseases[selectedDisease].stages || {})).forEach(function (st) {
			if (st) stages.add(st);
		});
		stageSel.disabled = false;
		setSelectOptions(
			stageSel,
			[{ value: "", label: "All Stages" }].concat(
				Array.from(stages).sort().map(function (s) { return { value: s, label: s }; })
			)
		);
	} else {
		setSelectOptions(stageSel, [{ value: "", label: "Select a disease first" }]);
		stageSel.disabled = true;
	}
}

function setupWeeklyTrendFilterListeners() {
	/* Pest tab: pest filter change also rebuilds stage options */
	var pestFilterEl   = root_element.querySelector("#pest-weekly-pest-filter");
	var pestSectionEl  = root_element.querySelector("#pest-weekly-section-filter");
	var pestStageEl    = root_element.querySelector("#pest-weekly-stage-filter");

	function onPestFilterChange() {
		if (!scoutingYearData) return;
		rebuildPestStageOptions();
		updatePestWeeklyTrendChart();
		updatePestSectionChart();
		updatePestStageRadialChart();
	}
	function onPestSubFilterChange() {
		if (!scoutingYearData) return;
		updatePestWeeklyTrendChart();
		updatePestSectionChart();
		updatePestStageRadialChart();
	}
	if (pestFilterEl)  pestFilterEl.addEventListener("change", onPestFilterChange);
	if (pestSectionEl) pestSectionEl.addEventListener("change", onPestSubFilterChange);
	if (pestStageEl)   pestStageEl.addEventListener("change", onPestSubFilterChange);

	/* Disease tab: disease filter change also rebuilds stage options */
	var diseaseFilterEl  = root_element.querySelector("#disease-weekly-disease-filter");
	var diseaseSectionEl = root_element.querySelector("#disease-weekly-section-filter");
	var diseaseStageEl   = root_element.querySelector("#disease-weekly-stage-filter");

	function onDiseaseFilterChange() {
		if (!scoutingYearData) return;
		rebuildDiseaseStageOptions();
		updateDiseaseWeeklyTrendChart();
		updateDiseaseStageChart();
		updateDiseaseStageRadialChart();
	}
	function onDiseaseSubFilterChange() {
		if (!scoutingYearData) return;
		updateDiseaseWeeklyTrendChart();
		updateDiseaseStageChart();
		updateDiseaseStageRadialChart();
	}
	if (diseaseFilterEl)  diseaseFilterEl.addEventListener("change", onDiseaseFilterChange);
	if (diseaseSectionEl) diseaseSectionEl.addEventListener("change", onDiseaseSubFilterChange);
	if (diseaseStageEl)   diseaseStageEl.addEventListener("change", onDiseaseSubFilterChange);

	/* Trap tab */
	var trapTrapEl = root_element.querySelector("#trap-weekly-trap-filter");
	var trapPestEl = root_element.querySelector("#trap-weekly-pest-filter");
	function onTrapFilterChange() { if (scoutingYearData) updateTrapWeeklyTrendChart(); }
	if (trapTrapEl) trapTrapEl.addEventListener("change", onTrapFilterChange);
	if (trapPestEl) trapPestEl.addEventListener("change", onTrapFilterChange);
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

function _debounce(fn, ms) {
	var t;
	return function () {
		var args = arguments, ctx = this;
		clearTimeout(t);
		t = setTimeout(function () { fn.apply(ctx, args); }, ms);
	};
}

function setLoadingProgress(percent, label) {
	var overlay = root_element.querySelector("#scout-loading");
	if (!overlay) return;
	var bar = overlay.querySelector(".loading-bar-fill");
	var pct = overlay.querySelector(".loading-bar-pct");
	var text = overlay.querySelector(".loading-text");
	var clamped = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
	if (bar) bar.style.width = clamped + "%";
	if (pct) pct.textContent = clamped + "%";
	if (text && label != null) text.textContent = label;
}

function showLoading(label) {
	var overlay = root_element.querySelector("#scout-loading");
	if (!overlay) return;
	overlay.classList.add("active");
	setLoadingProgress(0, label || "Starting…");
}

function hideLoading() {
	var overlay = root_element.querySelector("#scout-loading");
	if (!overlay) return;
	setLoadingProgress(100, "Done");
	setTimeout(function () { overlay.classList.remove("active"); }, 180);
}

function fetchScoutingChunk(fromDate, toDate, greenhouse, includeMeta) {
	return callFrappe(
		"upande_scp.serverscripts.get_complete_scouting_entries.getScoutingEntriesChunk",
		{ from_date: fromDate, to_date: toDate, greenhouse: greenhouse, include_meta: includeMeta ? 1 : 0 }
	).then(function (r) { return r.message || {}; });
}

function collectCachedEntries(fromDate, toDate) {
	var out = [];
	Object.keys(monthCache.months).forEach(function (mk) {
		(monthCache.months[mk] || []).forEach(function (e) {
			var d = (e?.date_of_capture || "").slice(0, 10);
			if (d >= fromDate && d <= toDate) out.push(e);
		});
	});
	return out;
}

function renderFromCache(rangeInfo) {
	if (!metaCache) return;
	var fromDate = rangeInfo.fromDate;
	var toDate = rangeInfo.toDate;
	var yearFrom = rangeInfo.from.year + "-01-01";
	var yearTo = rangeInfo.to.year + "-12-31";

	var periodEntries = collectCachedEntries(fromDate, toDate);
	var yearEntries = collectCachedEntries(yearFrom, yearTo);

	scoutingAnalysis = null;
	observationColors = extractObservationColors(metaCache.pest_colors, metaCache.disease_colors);
	zonesPerGreenhouse = metaCache.zones_by_greenhouse || {};

	var farmPeriod = applyFarmFilterToEntries(periodEntries);
	var farmYear = applyFarmFilterToEntries(yearEntries);
	logSelectedPeriodObservations(farmPeriod, fromDate, toDate);
	scoutingYearData = buildScoutingData(farmYear);
	processScoutingData(farmPeriod);
}

function startBackgroundPrefetch(allYearMonths, rangeInfo) {
	var token = ++prefetchToken;
	var missing = allYearMonths.filter(function (mk) { return !monthCache.months[mk]; });
	if (missing.length === 0) return;

	var chain = Promise.resolve();
	missing.forEach(function (monthKey) {
		chain = chain.then(function () {
			if (token !== prefetchToken) return;
			var bounds = monthBounds(monthKey);
			return fetchScoutingChunk(bounds.fromDate, bounds.toDate, greenhouseFilter, false)
				.then(function (res) {
					if (token !== prefetchToken) return;
					monthCache.months[monthKey] = res.entries || [];
				})
				.catch(function () { /* silent — background */ });
		});
	});

	chain.then(function () {
		if (token !== prefetchToken || !metaCache) return;
		var yearFrom = rangeInfo.from.year + "-01-01";
		var yearTo = rangeInfo.to.year + "-12-31";
		var yearEntries = collectCachedEntries(yearFrom, yearTo);
		var farmYear = applyFarmFilterToEntries(yearEntries);
		scoutingYearData = buildScoutingData(farmYear);
		updateTabData(activeTab);
	});
}

var foregroundFetchToken = 0;

function fetchScoutingData() {
	// Bump the token so any in-flight chain becomes "stale" and stops writing to the cache.
	// Without this, switching to a far-back date while the previous fetch is mid-flight
	// causes the old fetch's resolved chunks to write into the freshly-reset monthCache
	// (cache poisoning) and then call renderFromCache with the old rangeInfo.
	var token = ++foregroundFetchToken;
	function isStale() { return token !== foregroundFetchToken; }

	var rangeInfo = getSelectedWeekRangeInfo();
	if (!rangeInfo) return;
	var fromDate = rangeInfo.fromDate;
	var toDate = rangeInfo.toDate;
	var fromYear = rangeInfo.from.year;
	var toYear = rangeInfo.to.year;

	var cacheKey = (greenhouseFilter || "*") + "|" + fromYear + "|" + toYear;
	if (monthCache.key !== cacheKey) {
		monthCache = { key: cacheKey, months: {} };
		prefetchToken++; /* cancel any in-flight background work from prior key */
	}

	var periodMonths = getMonthKeysBetween(fromDate, toDate);
	var allYearMonths = getYearMonthKeys(fromYear, toYear);
	var missingPeriod = periodMonths.filter(function (mk) { return !monthCache.months[mk]; });

	if (missingPeriod.length === 0 && metaCache) {
		// Cache hit: still show progress so the user sees the change registered.
		showLoading("Refreshing…");
		setLoadingProgress(45, "Building charts…");
		requestAnimationFrame(function () {
			if (isStale()) return;
			renderFromCache(rangeInfo);
			setLoadingProgress(100, "Done");
			hideLoading();
			startBackgroundPrefetch(allYearMonths, rangeInfo);
		});
		return;
	}

	showLoading("Fetching data…");
	setLoadingProgress(0, "Fetching data… (0/" + missingPeriod.length + ")");

	var total = missingPeriod.length;
	var done = 0;
	var needMeta = !metaCache;
	var chain = Promise.resolve();

	missingPeriod.forEach(function (monthKey, idx) {
		chain = chain.then(function () {
			if (isStale()) return;
			var bounds = monthBounds(monthKey);
			var includeMeta = needMeta && idx === 0;
			return fetchScoutingChunk(bounds.fromDate, bounds.toDate, greenhouseFilter, includeMeta)
				.then(function (res) {
					if (isStale()) return;
					monthCache.months[monthKey] = res.entries || [];
					if (includeMeta) {
						metaCache = {
							pest_colors: res.pest_colors || [],
							disease_colors: res.disease_colors || [],
							zones_by_greenhouse: res.zones_by_greenhouse || {},
						};
					}
					done++;
					setLoadingProgress(
						Math.round(done / total * 90),
						"Fetching data… (" + done + "/" + total + ")"
					);
				});
		});
	});

	chain.then(function () {
		if (isStale()) return;
		setLoadingProgress(95, "Building charts…");
		renderFromCache(rangeInfo);
		hideLoading();
		startBackgroundPrefetch(allYearMonths, rangeInfo);
	}).catch(function (err) {
		if (isStale()) return;     // newer fetch is showing its own loading state
		if (SCOUTING_DASHBOARD_DEBUG) console.error("Failed to load scouting data", err);
		hideLoading();
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
	updateOverviewDailyBarChart();
	updateOverviewDonutChart();
	updateOverviewPestRadarChart();
	updateOverviewDiseaseRadarChart();
	updateGreenhouseHealth();
	updateAlertsList();
	updateTopScouts();
	updateRecentEntries();
	updateScoutPerfCharts();
}

function _setText(selector, value) {
	var el = root_element.querySelector(selector);
	if (el) el.textContent = value;
}

/* ---------- ECharts theme + click-to-zoom modal ---------- */

var SD_FONT_FAMILY = "'DM Sans', system-ui, sans-serif";

function isoWeekTickLabel(weekKey, includeYear) {
	var parts = String(weekKey).split("-W");
	if (parts.length !== 2) return weekKey;
	var wk = "W" + parts[1];
	return includeYear ? wk + " '" + parts[0].slice(2) : wk;
}

/* X-axis label formatter: data is daily dates, tick labels show the ISO-week
   only on the first day of each week within the range (else empty string). */
function _isoWeekAxisFormatter(dates, includeYear) {
	return function (value, index) {
		if (!value) return "";
		var w = getIsoWeekString(value);
		if (index === 0) return isoWeekTickLabel(w, includeYear);
		var prev = dates[index - 1];
		if (!prev) return isoWeekTickLabel(w, includeYear);
		return getIsoWeekString(prev) !== w ? isoWeekTickLabel(w, includeYear) : "";
	};
}

function _echartsBase(compact) {
	return {
		textStyle: { fontFamily: SD_FONT_FAMILY, fontSize: 12, color: "#334155" },
		// Subtle one-shot animation on initial render, no animation on data updates.
		animation: true,
		animationDuration: 250,
		animationEasing: "cubicOut",
		animationDurationUpdate: 0,
		legend: {
			show: true,
			bottom: 4,
			type: "scroll",
			itemWidth: 10,
			itemHeight: 10,
			icon: "circle",
			textStyle: { fontFamily: SD_FONT_FAMILY, fontSize: 11, color: "#334155" },
			selectedMode: false,    // legend is informational only — no series toggle
		},
		tooltip: {
			show: true,
			confine: true,
			backgroundColor: "rgba(13,43,94,0.95)",
			borderColor: "rgba(13,43,94,0.95)",
			textStyle: { color: "#e2e8f0", fontFamily: SD_FONT_FAMILY, fontSize: 12 },
			padding: [8, 10],
			extraCssText: "border-radius: 8px; box-shadow: 0 6px 16px rgba(13,43,94,0.25);",
		},
		grid: {
			left: 40,
			right: 16,
			top: 16,
			bottom: compact ? 36 : 56,
			containLabel: false,
		},
	};
}

/* --- click-to-zoom registry/modal (ECharts) --- */

var echartRegistry = {};   // id -> { instance, builder, meta }
var zoomedChart = null;
var _resizeListenerBound = false;

function _ensureChartResizeListener() {
	if (_resizeListenerBound) return;
	_resizeListenerBound = true;
	var debouncedResize = _debounce(function () {
		Object.keys(echartRegistry).forEach(function (id) {
			var entry = echartRegistry[id];
			if (entry && entry.instance) { try { entry.instance.resize(); } catch (e) {} }
		});
		if (zoomedChart) { try { zoomedChart.resize(); } catch (e) {} }
	}, 120);
	window.addEventListener("resize", debouncedResize);
}

function _ensureZoomModal() {
	var modal = document.getElementById("scout-chart-zoom");
	if (modal) return modal;
	modal = document.createElement("div");
	modal.id = "scout-chart-zoom";
	modal.className = "chart-zoom-modal";
	modal.innerHTML = ''
		+ '<div class="chart-zoom-panel">'
		+   '<div class="chart-zoom-head">'
		+     '<div><div class="chart-zoom-title"></div><div class="chart-zoom-sub"></div></div>'
		+     '<button class="chart-zoom-close" aria-label="Close">&times;</button>'
		+   '</div>'
		+   '<div class="chart-zoom-body" id="scout-chart-zoom-body"></div>'
		+ '</div>';
	document.body.appendChild(modal);
	modal.addEventListener("click", function (ev) {
		if (ev.target === modal) closeChartZoomModal();
	});
	modal.querySelector(".chart-zoom-close").addEventListener("click", closeChartZoomModal);
	document.addEventListener("keydown", function (e) {
		if (e.key === "Escape" && modal.classList.contains("open")) closeChartZoomModal();
	});
	return modal;
}

function openChartZoomModal(elementId) {
	var entry = echartRegistry[elementId];
	if (!entry || typeof echarts === "undefined") return;
	var modal = _ensureZoomModal();
	var body = modal.querySelector("#scout-chart-zoom-body");
	if (zoomedChart) { try { zoomedChart.dispose(); } catch (e) {} zoomedChart = null; }
	body.innerHTML = "";
	modal.querySelector(".chart-zoom-title").textContent = entry.meta.title || "Chart";
	modal.querySelector(".chart-zoom-sub").textContent = entry.meta.subtitle || "";
	modal.classList.add("open");
	document.body.style.overflow = "hidden";
	// Init after the modal is laid out so the chart picks up correct dimensions.
	requestAnimationFrame(function () {
		zoomedChart = echarts.init(body, null, { renderer: "svg" });
		zoomedChart.setOption(entry.builder(false), true);
	});
}

function closeChartZoomModal() {
	var modal = document.getElementById("scout-chart-zoom");
	if (!modal) return;
	modal.classList.remove("open");
	document.body.style.overflow = "";
	if (zoomedChart) { try { zoomedChart.dispose(); } catch (e) {} zoomedChart = null; }
}

function renderEChart(elementId, builder, meta) {
	var el = root_element.querySelector("#" + elementId);
	if (!el || typeof echarts === "undefined") return null;
	_ensureChartResizeListener();
	var prev = echartRegistry[elementId];
	if (prev && prev.instance) {
		try { prev.instance.dispose(); } catch (e) {}
	}
	// Clear non-overlay leftovers from previous library versions.
	Array.prototype.slice.call(el.children).forEach(function (ch) {
		if (ch.classList && ch.classList.contains("donut-center")) return;
		ch.remove();
	});
	var inst = echarts.init(el, null, { renderer: "svg" });
	inst.setOption(builder(true), true);
	echartRegistry[elementId] = { instance: inst, builder: builder, meta: meta || {} };
	if (!el.dataset.zoomBound) {
		el.dataset.zoomBound = "1";
		el.addEventListener("click", function () {
			openChartZoomModal(elementId);
		});
	}
	return inst;
}

function updateOverviewTimelineChart() {
	if (!scoutingData) return;
	var dates = Object.keys(scoutingData.daily).sort();
	if (!dates.length) return;
	var includeYear = new Set(dates.map(function (d) { return d.slice(0, 4); })).size > 1;
	var seriesNames = ["Pests", "Diseases", "Traps"];
	var seriesKeys = ["pests", "diseases", "traps"];

	function builder(compact) {
		var base = _echartsBase(compact);
		return Object.assign(base, {
			color: ["#10b981", "#f59e0b", "#3b82f6"],
			legend: Object.assign({}, base.legend, { data: seriesNames }),
			tooltip: Object.assign({}, base.tooltip, {
				trigger: "axis",
				axisPointer: { type: "line", lineStyle: { color: "rgba(13,43,94,0.35)" } },
				formatter: function (params) {
					if (!params || !params.length) return "";
					var idx = params[0].dataIndex;
					var date = dates[idx];
					var rows = params.map(function (p) {
						return '<div style="display:flex;justify-content:space-between;gap:14px;font-size:12px;">'
							+ '<span>' + p.marker + p.seriesName + '</span>'
							+ '<span style="font-weight:600;">' + formatNumber(p.value) + '</span></div>';
					}).join("");
					return '<div style="font-weight:600;margin-bottom:6px;">' + date + '</div>' + rows;
				},
			}),
			xAxis: {
				type: "category",
				boundaryGap: false,
				data: dates,    // daily granularity
				axisLine: { lineStyle: { color: "rgba(0,0,0,0.15)" } },
				axisTick: { show: false },
				axisLabel: {
					interval: 0,
					color: "#64748b",
					fontSize: 11,
					fontFamily: SD_FONT_FAMILY,
					hideOverlap: true,
					formatter: _isoWeekAxisFormatter(dates, includeYear),
				},
			},
			yAxis: {
				type: "value",
				splitLine: { lineStyle: { color: "rgba(0,0,0,0.06)", type: "dashed" } },
				axisLine: { show: false },
				axisTick: { show: false },
				axisLabel: { color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, formatter: function (v) { return Math.round(v); } },
			},
			series: seriesNames.map(function (name, i) {
				var k = seriesKeys[i];
				return {
					name: name,
					type: "line",
					smooth: false,
					symbol: "circle",
					symbolSize: compact ? 4 : 6,
					showSymbol: true,
					sampling: "lttb",
					lineStyle: { width: compact ? 2 : 2.5 },
					emphasis: { disabled: true },
					areaStyle: { opacity: 0.15 },
					data: dates.map(function (d) {
						var rec = scoutingData.daily[d] || {};
						return rec[k] || 0;
					}),
				};
			}),
		});
	}

	renderEChart("overview-timeline-chart", builder, {
		title: "Activity Timeline",
		subtitle: "Pests · Diseases · Traps · daily counts · ISO-week ticks",
	});
}

function updateOverviewDonutChart() {
	if (!scoutingData) return;
	var totalPests    = Object.values(scoutingData.pests).reduce(function (s, p) { return s + p.counts.length; }, 0);
	var totalDiseases = Object.values(scoutingData.diseases).reduce(function (s, d) { return s + d.counts.length; }, 0);
	var totalTraps    = Object.values(scoutingData.traps).reduce(function (s, t) { return s + t.total; }, 0);
	_setText("#overview-donut-total", formatNumber(totalPests + totalDiseases + totalTraps));

	function builder(compact) {
		var base = _echartsBase(compact);
		return Object.assign(base, {
			color: ["#10b981", "#f59e0b", "#3b82f6"],
			legend: Object.assign({}, base.legend, { data: ["Pests", "Diseases", "Traps"] }),
			tooltip: Object.assign({}, base.tooltip, {
				trigger: "item",
				formatter: function (p) {
					return '<div style="font-weight:600;margin-bottom:2px;">' + p.marker + p.name + '</div>'
						+ '<div>' + formatNumber(p.value) + '  ·  ' + p.percent.toFixed(1) + '%</div>';
				},
			}),
			grid: undefined,    // pies don't use grid
			series: [{
				type: "pie",
				radius: compact ? ["60%", "82%"] : ["55%", "78%"],
				center: ["50%", "46%"],
				avoidLabelOverlap: true,
				itemStyle: { borderColor: "#fff", borderWidth: 2 },
				label: { show: false },
				labelLine: { show: false },
				emphasis: { disabled: true },
				data: [
					{ name: "Pests", value: totalPests },
					{ name: "Diseases", value: totalDiseases },
					{ name: "Traps", value: totalTraps },
				],
			}],
		});
	}

	renderEChart("overview-donut-chart", builder, {
		title: "Category Split",
		subtitle: "Observation breakdown",
	});
}

function updateOverviewDailyBarChart() {
	if (!scoutingData) return;
	var totalPests    = Object.values(scoutingData.pests).reduce(function (s, p) { return s + p.counts.length; }, 0);
	var totalDiseases = Object.values(scoutingData.diseases).reduce(function (s, d) { return s + d.counts.length; }, 0);
	var totalTraps    = Object.values(scoutingData.traps).reduce(function (s, t) { return s + t.total; }, 0);
	var palette = ["#10b981", "#f59e0b", "#3b82f6"];

	function builder(compact) {
		var base = _echartsBase(compact);
		return Object.assign(base, {
			legend: Object.assign({}, base.legend, { show: false }),
			tooltip: Object.assign({}, base.tooltip, {
				trigger: "item",
				formatter: function (p) {
					return '<div style="font-weight:600;margin-bottom:2px;">' + p.marker + p.name + '</div>'
						+ '<div>' + formatNumber(p.value) + '</div>';
				},
			}),
			grid: { left: 36, right: 16, top: 36, bottom: 28, containLabel: false },
			xAxis: {
				type: "category",
				data: ["Pests", "Diseases", "Traps"],
				axisLine: { show: false },
				axisTick: { show: false },
				axisLabel: { color: "#475569", fontSize: 11, fontFamily: SD_FONT_FAMILY, fontWeight: 500 },
			},
			yAxis: {
				type: "value",
				splitLine: { lineStyle: { color: "rgba(0,0,0,0.06)", type: "dashed" } },
				axisLine: { show: false },
				axisTick: { show: false },
				axisLabel: { color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, formatter: function (v) { return Math.round(v); } },
			},
			series: [{
				type: "bar",
				barMaxWidth: compact ? 36 : 60,
				itemStyle: { borderRadius: [6, 6, 0, 0] },
				label: {
					show: true,
					position: "top",
					color: "#334155",
					fontSize: 11,
					fontFamily: SD_FONT_FAMILY,
					fontWeight: 600,
					formatter: function (p) { return formatNumber(p.value); },
				},
				emphasis: { disabled: true },
				data: [
					{ value: totalPests,    itemStyle: { color: palette[0], borderRadius: [6,6,0,0] } },
					{ value: totalDiseases, itemStyle: { color: palette[1], borderRadius: [6,6,0,0] } },
					{ value: totalTraps,    itemStyle: { color: palette[2], borderRadius: [6,6,0,0] } },
				],
			}],
		});
	}

	renderEChart("overview-daily-bar-chart", builder, {
		title: "Range Totals",
		subtitle: "Pests · Diseases · Traps for selected range",
	});
}

function updateOverviewPestRadarChart() {
	if (!scoutingData) return;
	var pestTotals = {};
	Object.values(scoutingData.pests).forEach(function (p) {
		Object.keys(p.sections || {}).forEach(function (sec) {
			pestTotals[sec] = (pestTotals[sec] || 0) + p.sections[sec];
		});
	});
	var sections = Object.keys(pestTotals)
		.map(function (s) { return { section: s, total: pestTotals[s] }; })
		.sort(function (a, b) { return b.total - a.total; })
		.slice(0, 8);
	var labels = sections.map(function (s) { return s.section; });
	if (!labels.length) return;
	var maxVal = Math.max.apply(null, sections.map(function (s) { return s.total; })) || 1;

	function builder(compact) {
		var base = _echartsBase(compact);
		return Object.assign(base, {
			color: ["#10b981"],
			legend: Object.assign({}, base.legend, { data: ["Pests"] }),
			tooltip: Object.assign({}, base.tooltip, { trigger: "item" }),
			grid: undefined,
			radar: {
				indicator: labels.map(function (n) { return { name: n, max: maxVal }; }),
				center: ["50%", "48%"],
				radius: compact ? "60%" : "70%",
				axisName: { color: "#475569", fontSize: compact ? 10 : 12, fontFamily: SD_FONT_FAMILY },
				splitLine: { lineStyle: { color: "rgba(0,0,0,0.10)" } },
				splitArea: { show: false },
				axisLine: { lineStyle: { color: "rgba(0,0,0,0.10)" } },
			},
			series: [{
				type: "radar",
				lineStyle: { width: 2 },
				symbol: "circle",
				symbolSize: 4,
				itemStyle: { color: "#10b981", borderColor: "#fff", borderWidth: 2 },
				areaStyle: { color: "rgba(16,185,129,0.25)" },
				emphasis: { disabled: true },
				data: [{ name: "Pests", value: labels.map(function (l) { return pestTotals[l] || 0; }) }],
			}],
		});
	}

	renderEChart("overview-pest-radar-chart", builder, {
		title: "Pest Section Radar",
		subtitle: "Pest pressure by plant area",
	});
}

function updateOverviewDiseaseRadarChart() {
	if (!scoutingData) return;
	var diseaseTotals = {};
	Object.values(scoutingData.diseases).forEach(function (d) {
		(d.counts || []).forEach(function (c) {
			var s = c.section || "Unknown";
			diseaseTotals[s] = (diseaseTotals[s] || 0) + 1;
		});
	});
	var sections = Object.keys(diseaseTotals)
		.map(function (s) { return { section: s, total: diseaseTotals[s] }; })
		.sort(function (a, b) { return b.total - a.total; })
		.slice(0, 8);
	var labels = sections.map(function (s) { return s.section; });
	if (!labels.length) return;
	var maxVal = Math.max.apply(null, sections.map(function (s) { return s.total; })) || 1;

	function builder(compact) {
		var base = _echartsBase(compact);
		return Object.assign(base, {
			color: ["#f59e0b"],
			legend: Object.assign({}, base.legend, { data: ["Diseases"] }),
			tooltip: Object.assign({}, base.tooltip, { trigger: "item" }),
			grid: undefined,
			radar: {
				indicator: labels.map(function (n) { return { name: n, max: maxVal }; }),
				center: ["50%", "48%"],
				radius: compact ? "60%" : "70%",
				axisName: { color: "#475569", fontSize: compact ? 10 : 12, fontFamily: SD_FONT_FAMILY },
				splitLine: { lineStyle: { color: "rgba(0,0,0,0.10)" } },
				splitArea: { show: false },
				axisLine: { lineStyle: { color: "rgba(0,0,0,0.10)" } },
			},
			series: [{
				type: "radar",
				lineStyle: { width: 2 },
				symbol: "circle",
				symbolSize: 4,
				itemStyle: { color: "#f59e0b", borderColor: "#fff", borderWidth: 2 },
				areaStyle: { color: "rgba(245,158,11,0.25)" },
				emphasis: { disabled: true },
				data: [{ name: "Diseases", value: labels.map(function (l) { return diseaseTotals[l] || 0; }) }],
			}],
		});
	}

	renderEChart("overview-disease-radar-chart", builder, {
		title: "Disease Section Radar",
		subtitle: "Disease spread by plant area",
	});
}

function updateScoutPerfCharts() {
	if (!scoutingData) return;
	var scoutStats = {};
	var allDates = new Set();
	scoutingData.entries.forEach(function (e) {
		var si = getScoutIdentity(e);
		if (!si.key) return;
		var key = si.key;
		var d = e.date_of_capture;
		if (!scoutStats[key]) {
			scoutStats[key] = { name: si.label || key, entries: 0, pests: 0, diseases: 0, traps: 0, daily: {} };
		}
		var s = scoutStats[key];
		s.entries++;
		s.pests += (e.pests_scouting_entry || []).length;
		s.diseases += (e.diseases_scouting_entry || []).length;
		s.traps += (e.trap_scouting_entry || []).length;
		if (d) { s.daily[d] = (s.daily[d] || 0) + 1; allDates.add(d); }
	});
	var sortedScouts = Object.values(scoutStats).sort(function (a, b) { return b.entries - a.entries; }).slice(0, 8);
	var dates = Array.from(allDates).sort();

	// Unique scouts active per day — derived from full scoutStats, not the top-N slice.
	var uniqueByDay = {};
	Object.keys(scoutStats).forEach(function (k) {
		Object.keys(scoutStats[k].daily || {}).forEach(function (d) {
			if (!uniqueByDay[d]) uniqueByDay[d] = new Set();
			uniqueByDay[d].add(k);
		});
	});

	_updateScoutPerfTrend(sortedScouts, dates);
	_updateScoutPerfBar(sortedScouts);
	_updateScoutPerfRadar(sortedScouts);
	_updateScoutPerfRadial(sortedScouts);
	_updateScoutActivePerDay(dates, uniqueByDay);
}

function _updateScoutPerfTrend(scouts, dates) {
	var top5 = scouts.slice(0, 5);
	if (!top5.length || !dates.length) return;
	var includeYear = new Set(dates.map(function (d) { return d.slice(0, 4); })).size > 1;
	var palette = top5.map(function (_, i) { return getPaletteColor(i).border; });
	var seriesNames = top5.map(function (s) { return s.name; });

	function builder(compact) {
		var base = _echartsBase(compact);
		return Object.assign(base, {
			color: palette,
			legend: Object.assign({}, base.legend, { data: seriesNames }),
			tooltip: Object.assign({}, base.tooltip, {
				trigger: "axis",
				axisPointer: { type: "line", lineStyle: { color: "rgba(13,43,94,0.35)" } },
				formatter: function (params) {
					if (!params || !params.length) return "";
					var idx = params[0].dataIndex;
					var rows = params.map(function (p) {
						return '<div style="display:flex;justify-content:space-between;gap:14px;font-size:12px;">'
							+ '<span>' + p.marker + p.seriesName + '</span>'
							+ '<span style="font-weight:600;">' + formatNumber(p.value) + '</span></div>';
					}).join("");
					return '<div style="font-weight:600;margin-bottom:6px;">' + dates[idx] + '</div>' + rows;
				},
			}),
			xAxis: {
				type: "category",
				boundaryGap: false,
				data: dates,
				axisLine: { lineStyle: { color: "rgba(0,0,0,0.15)" } },
				axisTick: { show: false },
				axisLabel: {
					interval: 0,
					color: "#64748b",
					fontSize: 11,
					fontFamily: SD_FONT_FAMILY,
					hideOverlap: true,
					formatter: _isoWeekAxisFormatter(dates, includeYear),
				},
			},
			yAxis: {
				type: "value",
				name: "Entries",
				nameTextStyle: { color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY },
				splitLine: { lineStyle: { color: "rgba(0,0,0,0.06)", type: "dashed" } },
				axisLine: { show: false },
				axisTick: { show: false },
				axisLabel: { color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, formatter: function (v) { return Math.round(v); } },
			},
			series: top5.map(function (s) {
				return {
					name: s.name,
					type: "line",
					smooth: false,    // stratified daily — no smoothing across days
					symbol: "circle",
					symbolSize: compact ? 4 : 6,
					showSymbol: true,
					sampling: "lttb",
					lineStyle: { width: compact ? 2 : 2.5 },
					emphasis: { disabled: true },
					data: dates.map(function (d) { return s.daily[d] || 0; }),
				};
			}),
		});
	}

	renderEChart("scout-perf-trend-chart", builder, {
		title: "Scout Activity Trend",
		subtitle: "Daily entries per scout (top 5) · ISO-week ticks",
	});
}

function _updateScoutPerfBar(scouts) {
	if (!scouts.length) return;
	var labels = scouts.map(function (s) { return s.name; });

	function builder(compact) {
		var base = _echartsBase(compact);
		return Object.assign(base, {
			color: ["#3b82f6", "#10b981", "#f59e0b"],
			legend: Object.assign({}, base.legend, { data: ["Entries", "Pest Obs", "Disease Obs"] }),
			tooltip: Object.assign({}, base.tooltip, { trigger: "axis", axisPointer: { type: "shadow" } }),
			grid: { left: 40, right: 16, top: 16, bottom: compact ? 56 : 76, containLabel: false },
			xAxis: {
				type: "category",
				data: labels,
				axisLine: { show: false },
				axisTick: { show: false },
				axisLabel: { color: "#64748b", fontSize: 10, fontFamily: SD_FONT_FAMILY, rotate: -25, hideOverlap: true },
			},
			yAxis: {
				type: "value",
				splitLine: { lineStyle: { color: "rgba(0,0,0,0.06)", type: "dashed" } },
				axisLine: { show: false },
				axisTick: { show: false },
				axisLabel: { color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, formatter: function (v) { return Math.round(v); } },
			},
			series: ["Entries", "Pest Obs", "Disease Obs"].map(function (name, i) {
				var key = name === "Entries" ? "entries" : (name === "Pest Obs" ? "pests" : "diseases");
				return {
					name: name,
					type: "bar",
					barMaxWidth: 32,
					itemStyle: { borderRadius: [4, 4, 0, 0] },
					emphasis: { disabled: true },
					data: scouts.map(function (s) { return s[key]; }),
				};
			}),
		});
	}

	renderEChart("scout-perf-bar-chart", builder, {
		title: "Entries & Observations",
		subtitle: "Per scout · entries, pests, diseases",
	});
}

function _updateScoutPerfRadar(scouts) {
	var top6 = scouts.slice(0, 6);
	if (!top6.length) return;
	var maxEntries = Math.max.apply(null, top6.map(function (s) { return s.entries; })) || 1;
	var maxPests   = Math.max.apply(null, top6.map(function (s) { return s.pests; })) || 1;
	var maxDis     = Math.max.apply(null, top6.map(function (s) { return s.diseases; })) || 1;
	var maxTraps   = Math.max.apply(null, top6.map(function (s) { return s.traps; })) || 1;
	var maxAvgDay  = Math.max.apply(null, top6.map(function (s) {
		return s.entries / (Object.keys(s.daily).length || 1);
	})) || 1;
	var labels = ["Entries", "Pest Obs", "Disease Obs", "Trap Obs", "Avg/Day"];
	var palette = top6.map(function (_, i) { return getPaletteColor(i).border; });

	function builder(compact) {
		var base = _echartsBase(compact);
		return Object.assign(base, {
			color: palette,
			legend: Object.assign({}, base.legend, { data: top6.map(function (s) { return s.name; }), textStyle: { fontFamily: SD_FONT_FAMILY, fontSize: compact ? 10 : 11, color: "#334155" } }),
			tooltip: Object.assign({}, base.tooltip, { trigger: "item" }),
			grid: undefined,
			radar: {
				indicator: labels.map(function (n) { return { name: n, max: 100 }; }),
				center: ["50%", "48%"],
				radius: compact ? "58%" : "68%",
				axisName: { color: "#475569", fontSize: compact ? 10 : 12, fontFamily: SD_FONT_FAMILY },
				splitLine: { lineStyle: { color: "rgba(0,0,0,0.10)" } },
				splitArea: { show: false },
				axisLine: { lineStyle: { color: "rgba(0,0,0,0.10)" } },
			},
			series: [{
				type: "radar",
				lineStyle: { width: 2 },
				symbol: "circle",
				symbolSize: 3,
				areaStyle: { opacity: 0.15 },
				emphasis: { disabled: true },
				data: top6.map(function (s) {
					var days = Object.keys(s.daily).length || 1;
					return {
						name: s.name,
						value: [
							Math.round((s.entries / maxEntries) * 100),
							Math.round((s.pests   / maxPests)   * 100),
							Math.round((s.diseases / maxDis)    * 100),
							Math.round((s.traps   / maxTraps)   * 100),
							Math.round(((s.entries / days) / maxAvgDay) * 100),
						],
					};
				}),
			}],
		});
	}

	renderEChart("scout-perf-radar-chart", builder, {
		title: "Scout Performance Radar",
		subtitle: "Normalized metrics (top 6 scouts)",
	});
}

function _updateScoutPerfRadial(scouts) {
	if (!scouts.length) return;
	var palette = scouts.map(function (_, i) { return getPaletteColor(i).border; });
	var data = scouts.map(function (s) { return { name: s.name, value: s.entries }; });
	var total = scouts.reduce(function (a, s) { return a + s.entries; }, 0);

	function builder(compact) {
		var base = _echartsBase(compact);
		return Object.assign(base, {
			color: palette,
			legend: Object.assign({}, base.legend, { data: scouts.map(function (s) { return s.name; }) }),
			tooltip: Object.assign({}, base.tooltip, {
				trigger: "item",
				formatter: function (p) {
					return '<div style="font-weight:600;margin-bottom:2px;">' + p.marker + p.name + '</div>'
						+ '<div>' + formatNumber(p.value) + ' entries  ·  ' + p.percent.toFixed(1) + '%</div>';
				},
			}),
			grid: undefined,
			series: [{
				type: "pie",
				radius: compact ? ["55%", "78%"] : ["52%", "72%"],
				center: ["50%", "46%"],
				avoidLabelOverlap: true,
				itemStyle: { borderColor: "#fff", borderWidth: 2 },
				label: compact ? { show: false } : {
					show: true,
					position: "center",
					formatter: function () { return "{a|" + formatNumber(total) + "}\n{b|Entries}"; },
					rich: {
						a: { fontSize: 18, fontWeight: 700, color: "#0D2B5E", fontFamily: SD_FONT_FAMILY },
						b: { fontSize: 11, color: "#64748b", fontFamily: SD_FONT_FAMILY, padding: [4, 0, 0, 0] },
					},
				},
				labelLine: { show: false },
				emphasis: { disabled: true },
				data: data,
			}],
		});
	}

	renderEChart("scout-perf-radial-chart", builder, {
		title: "Activity Distribution",
		subtitle: "Share of total scouting by scout",
	});
}

function _updateScoutActivePerDay(dates, uniqueByDay) {
	if (!dates.length) return;
	var includeYear = new Set(dates.map(function (d) { return d.slice(0, 4); })).size > 1;
	var counts = dates.map(function (d) { return uniqueByDay[d] ? uniqueByDay[d].size : 0; });

	function builder(compact) {
		var base = _echartsBase(compact);
		return Object.assign(base, {
			color: ["#0D2B5E"],
			legend: Object.assign({}, base.legend, { show: false }),
			tooltip: Object.assign({}, base.tooltip, {
				trigger: "axis",
				axisPointer: { type: "line", lineStyle: { color: "rgba(13,43,94,0.35)" } },
				formatter: function (params) {
					if (!params || !params.length) return "";
					var p = params[0];
					var v = p.value;
					return '<div style="font-weight:600;margin-bottom:2px;">' + dates[p.dataIndex] + '</div>'
						+ '<div>' + p.marker + v + (v === 1 ? " scout" : " scouts") + '</div>';
				},
			}),
			xAxis: {
				type: "category",
				boundaryGap: false,
				data: dates,
				axisLine: { lineStyle: { color: "rgba(0,0,0,0.15)" } },
				axisTick: { show: false },
				axisLabel: {
					interval: 0,
					color: "#64748b",
					fontSize: 11,
					fontFamily: SD_FONT_FAMILY,
					hideOverlap: true,
					formatter: _isoWeekAxisFormatter(dates, includeYear),
				},
			},
			yAxis: {
				type: "value",
				min: 0,
				splitLine: { lineStyle: { color: "rgba(0,0,0,0.06)", type: "dashed" } },
				axisLine: { show: false },
				axisTick: { show: false },
				axisLabel: { color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, formatter: function (v) { return Math.round(v); } },
			},
			series: [{
				name: "Active scouts",
				type: "line",
				smooth: false,
				symbol: "circle",
				symbolSize: compact ? 4 : 6,
				showSymbol: true,
				sampling: "lttb",
				lineStyle: { width: compact ? 2 : 2.5 },
				emphasis: { disabled: true },
				areaStyle: { opacity: 0.18 },
				data: counts,
			}],
		});
	}

	renderEChart("scout-active-per-day-chart", builder, {
		title: "Scouts Active Per Day",
		subtitle: "Unique scouts working each day · ISO-week ticks",
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
 
	var pests    = scoutingData.pests;
	var names    = Object.keys(pests);
	var totalObs = scoutingData.entries.reduce(function (s, e) {
		return s + (e.pests_scouting_entry || []).length;
	}, 0);
	var highSev = names.reduce(function (s, p) {
		return s + pests[p].severity.high;
	}, 0);
	var topPest = names.length
		? names.reduce(function (a, b) {
			return pests[a].counts.length > pests[b].counts.length ? a : b;
		})
		: "None";
 
	_setText("#pest-total-entries",  formatNumber(totalObs));
	_setText("#pest-active-count",   names.length);
	_setText("#pest-high-severity",  highSev);
	_setText("#pest-top-name",       topPest);
	_setText("#pest-top-count",      (pests[topPest]?.counts.length || 0) + " observations");
 
	updatePestTrendChart();
	updatePestWeeklyTrend();
	updatePestDistributionChart();
	updatePestSeverityMatrix();
	updatePestSectionChart();
	updatePestStageRadialChart();
	updatePestGhChart();
	updatePestBedChart();
}

function updatePestTrendChart() {
	var ctx = root_element.querySelector("#pest-trend-chart");
	if (!ctx) return;
	if (pestTrendChart) pestTrendChart.destroy();
 
	var dates      = Object.keys(scoutingData.daily).sort();
	var totalBeds  = getTotalZonesForGreenhouses(scoutingData.entries);   /* CHANGE 2 */
	var stageVal   = (root_element.querySelector("#pest-weekly-stage-filter")?.value || "")
	                  .trim().toLowerCase();                               /* CHANGE 1 */
 
	/* Build the full unfiltered daily map once for the no-filter fast path */
	var fullDailyMap = buildDailyBedInfectionMap(scoutingData.entries, "pests");
 
	var chartData = dates.map(function (d) {
		if (!stageVal) {
			/* CHANGE 2: zone count / total zones */
			return toBedInfectionPercent(fullDailyMap[d]?.size || 0, totalBeds);
		}
		/* CHANGE 1: re-count only zones where the selected stage appeared that day */
		var filtered = new Set();
		(scoutingData.entries || []).forEach(function (e) {
			if (e.date_of_capture !== d) return;
			(e.pests_scouting_entry || []).forEach(function (p) {
				if ((p.stage || "").trim().toLowerCase() !== stageVal) return;
				var k = getDistributionBedKey(e);
				if (k) filtered.add(k);
			});
		});
		return toBedInfectionPercent(filtered.size, totalBeds);
	});
 
	pestTrendChart = new Chart(ctx, {
		type: "line",
		data: {
			labels: dates.map(function (d) { return d.slice(5); }),
			datasets: [{
				label:                "Zones Infected (%)",
				data:                 chartData,
				borderColor:          "#10b981",
				backgroundColor:      "rgba(16,185,129,.1)",
				borderWidth:          2,
				fill:                 true,
				tension:              0.4,
				pointRadius:          3,
				pointBackgroundColor: "#10b981",
			}],
		},
		options: {
			responsive:          true,
			maintainAspectRatio: false,
			plugins: { legend: { display: false } },
			scales: {
				x: { grid: { display: false } },
				y: {
					beginAtZero: true,
					/* CHANGE 3: max:100 removed — axis auto-scales */
					grid:  { color: "rgba(0,0,0,.04)" },
					ticks: { callback: function (v) { return v.toFixed(1) + "%"; } },
				},
			},
		},
	});
}
 
function updatePestWeeklyTrend() {
	var pestSel  = root_element.querySelector("#pest-weekly-pest-filter");
	var secSel   = root_element.querySelector("#pest-weekly-section-filter");
	var stageSel = root_element.querySelector("#pest-weekly-stage-filter"); /* CHANGE 1 */
 
	if (!pestSel || !secSel || !stageSel || !scoutingYearData) return;
 
	/* Pest names */
	var pNames = Object.keys(scoutingYearData.pests || {}).sort();
	setSelectOptions(
		pestSel,
		[{ value: "", label: "All Pests" }].concat(
			pNames.map(function (p) { return { value: p, label: p }; })
		)
	);
 
	/* Plant sections */
	var secs = new Set();
	Object.values(scoutingYearData.pests || {}).forEach(function (p) {
		(p.counts || []).forEach(function (c) { if (c.section) secs.add(c.section); });
	});
	setSelectOptions(
		secSel,
		[{ value: "", label: "All Sections" }].concat(
			Array.from(secs).sort().map(function (s) { return { value: s, label: s }; })
		)
	);
 
	/* Stage options depend on which pest is selected */
	rebuildPestStageOptions();

	updatePestWeeklyTrendChart();
	updatePestStageRadialChart();
}

function updatePestWeeklyTrendChart() {
	var ctx = root_element.querySelector("#pest-weekly-trend-chart");
	if (!ctx || !scoutingData) return;
	if (pestWeeklyTrendChart) pestWeeklyTrendChart.destroy();

	var rangeInfo = getSelectedWeekRangeInfo();
	if (!rangeInfo) return;
	var axis = getDayRangeAxis(rangeInfo);
	if (!axis) return;

	var dayIndex = {};
	axis.keys.forEach(function (k, i) { dayIndex[k] = i; });

	var pestName  = root_element.querySelector("#pest-weekly-pest-filter")?.value    || "";
	var section   = root_element.querySelector("#pest-weekly-section-filter")?.value || "";
	var stage     = root_element.querySelector("#pest-weekly-stage-filter")?.value   || "";
	var totalBeds = getTotalZonesForGreenhouses(scoutingData.entries);

	var includeFn = function (c) {
		if (section && c.section !== section)     return false;
		if (stage   && (c.stage || "") !== stage) return false;
		return true;
	};

	var datasets = [];

	if (!section) {
		/* All Sections: stratify – one line per section */
		var allCounts = pestName
			? (scoutingData.pests?.[pestName]?.counts || [])
			: Object.values(scoutingData.pests || {}).reduce(function (acc, p) {
				return acc.concat(p.counts || []);
			}, []);
		var sections = Array.from(new Set(
			allCounts.map(function (c) { return c.section || ""; }).filter(Boolean)
		)).sort();
		if (sections.length === 0) {
			/* No section data: one line per pest */
			(pestName ? [pestName] : Object.keys(scoutingData.pests || {}).sort()).forEach(function (p, idx) {
				var d = buildDailyBedInfectionSeries(
					scoutingData.pests[p]?.counts || [],
					axis, dayIndex, totalBeds, function (c) {
						return !stage || (c.stage || "") === stage;
					}
				);
				if (!d.some(function (v) { return v > 0; })) return;
				var pal = getPaletteColor(idx);
				datasets.push({
					label:           p,
					data:            d,
					borderColor:     observationColors.pests[p] || pal.border,
					backgroundColor: pal.background,
					borderWidth:     2,
					fill:            false,
					tension:         0.4,
					pointRadius:     0,
					order:           idx,
				});
			});
		} else {
			sections.forEach(function (sec, idx) {
				var sectionIncludeFn = function (c) {
					if (c.section !== sec) return false;
					if (stage && (c.stage || "") !== stage) return false;
					return true;
				};
				var d = buildDailyBedInfectionSeries(allCounts, axis, dayIndex, totalBeds, sectionIncludeFn);
				if (!d.some(function (v) { return v > 0; })) return;
				var pal = getPaletteColor(idx);
				datasets.push({
					label:           pestName ? pestName + " – " + sec : sec,
					data:            d,
					borderColor:     pal.border,
					backgroundColor: pal.background,
					borderWidth:     2,
					fill:            false,
					tension:         0.4,
					pointRadius:     0,
					order:           idx,
				});
			});
		}
	} else if (pestName) {
		/* Specific pest + specific section: single line */
		var d = buildDailyBedInfectionSeries(
			scoutingData.pests?.[pestName]?.counts || [],
			axis, dayIndex, totalBeds, includeFn
		);
		datasets.push({
			label:           pestName + " (" + section + ")" + (stage ? " [" + stage + "]" : ""),
			data:            d,
			borderColor:     observationColors.pests[pestName] || "#10b981",
			backgroundColor: "rgba(16,185,129,.1)",
			borderWidth:     2,
			fill:            false,
			tension:         0.4,
			pointRadius:     2,
		});
	} else {
		/* All pests + specific section: one line per pest */
		Object.keys(scoutingData.pests || {}).sort().forEach(function (p, idx) {
			var d = buildDailyBedInfectionSeries(
				scoutingData.pests[p].counts || [],
				axis, dayIndex, totalBeds, includeFn
			);
			if (!d.some(function (v) { return v > 0; })) return;
			var pal = getPaletteColor(idx);
			datasets.push({
				label:           p + " (" + section + ")",
				data:            d,
				borderColor:     observationColors.pests[p] || pal.border,
				backgroundColor: pal.background,
				borderWidth:     2,
				fill:            false,
				tension:         0.4,
				pointRadius:     0,
				order:           idx,
			});
		});
	}

	pestWeeklyTrendChart = new Chart(ctx, {
		type: "line",
		data: { labels: axis.labels, datasets: datasets },
		options: {
			responsive:          true,
			maintainAspectRatio: false,
			plugins: {
				legend: {
					display:  datasets.length > 1,
					position: "bottom",
					labels:   { boxWidth: 10, boxHeight: 10, padding: 10, font: { size: 10 } },
				},
				tooltip: {
					mode:      "index",
					intersect: false,
					callbacks: {
						title: function (items) {
							var i = items?.[0]?.dataIndex;
							return i !== undefined ? axis.keys[i] : "";
						},
					},
				},
			},
			scales: {
				x: {
					grid:  { display: false },
					ticks: { autoSkip: true, maxTicksLimit: 14 },
				},
				y: {
					beginAtZero: true,
					grid:  { color: "rgba(0,0,0,.04)" },
					ticks: { callback: function (v) { return v.toFixed(1) + "%"; } },
				},
			},
		},
	});
}

function updatePestDistributionChart() {
	var ctx = root_element.querySelector("#pest-distribution-chart");
	if (!ctx) return;
	if (pestDistChart) pestDistChart.destroy();
 
	var pests     = scoutingData.pests;
	var labels    = Object.keys(pests).slice(0, 10);
	var totalBeds = getTotalZonesForGreenhouses(scoutingData.entries); /* CHANGE 2 */
	var palette   = [
		"#10b981","#3b82f6","#f59e0b","#8b5cf6","#ef4444",
		"#ec4899","#14b8a6","#f97316","#6366f1","#06b6d4",
	];
 
	var data = labels.map(function (p) {
		var beds = new Set();
		(pests[p].counts || []).forEach(function (c) {
			var k = getDistributionBedKey(c);
			if (k) beds.add(k);
		});
		return totalBeds ? Number(((beds.size / totalBeds) * 100).toFixed(2)) : 0;
	});
 
	pestDistChart = new Chart(ctx, {
		type: "bar",
		data: {
			labels: labels,
			datasets: [{
				label:           "Zones Infected (%)",
				data:            data,
				backgroundColor: labels.map(function (l, i) {
					return observationColors.pests[l] || palette[i % palette.length];
				}),
				borderRadius: 4,
			}],
		},
		options: {
			responsive:          true,
			maintainAspectRatio: false,
			plugins: { legend: { display: false } },
			scales: {
				y: {
					beginAtZero: true,
					/* CHANGE 3: no max:100 */
					grid:  { color: "rgba(0,0,0,.04)" },
					ticks: { callback: function (v) { return v + "%"; } },
				},
			},
		},
	});
}

function updatePestSeverityMatrix() {
	var container = root_element.querySelector("#pest-severity-matrix");
	if (!container) return;
 
	var pests = scoutingData.pests;
	container.innerHTML = Object.keys(pests).slice(0, 12).map(function (pest) {
		var p       = pests[pest];
		var total   = p.counts.length;
		var highPct = total ? Math.round((p.severity.high     / total) * 100) : 0;
		var modPct  = total ? Math.round((p.severity.moderate / total) * 100) : 0;
		var lowPct  = total ? Math.round((p.severity.low      / total) * 100) : 0;
		var cls     = highPct > 50 ? "critical"
		            : highPct > 20 ? "high"
		            : modPct  > 30 ? "moderate"
		            :                "low";
		return (
			'<div class="severity-item">'
			+ '<div class="severity-name">' + pest + '</div>'
			+ '<div class="severity-bar"><div class="severity-fill ' + cls
			+ '" style="width:' + (highPct + modPct + lowPct) + '%"></div></div>'
			+ '<div class="severity-stats">'
			+ '<span>High: ' + p.severity.high     + '</span>'
			+ '<span>Mod: '  + p.severity.moderate + '</span>'
			+ '<span>Low: '  + p.severity.low      + '</span>'
			+ '</div></div>'
		);
	}).join("") || '<div class="empty-state">No pest data available</div>';
}

function updatePestSectionChart() {
	var ctx = root_element.querySelector("#pest-section-chart");
	if (!ctx) return;
	if (pestSectionChart) pestSectionChart.destroy();
 
	/* CHANGE 5: use only the selected pest's sections when filtered */
	var pestName = root_element.querySelector("#pest-weekly-pest-filter")?.value || "";
	var sections = {};
 
	if (pestName && scoutingData.pests[pestName]) {
		Object.assign(sections, scoutingData.pests[pestName].sections || {});
	} else {
		Object.keys(scoutingData.pests).forEach(function (pest) {
			Object.keys(scoutingData.pests[pest].sections).forEach(function (sec) {
				sections[sec] = (sections[sec] || 0) + scoutingData.pests[pest].sections[sec];
			});
		});
	}
 
	pestSectionChart = new Chart(ctx, {
		type: "doughnut",
		data: {
			labels: Object.keys(sections),
			datasets: [{
				data:            Object.values(sections),
				backgroundColor: ["#10b981","#3b82f6","#f59e0b","#8b5cf6","#ef4444"],
				borderWidth:     2,
			}],
		},
		options: {
			responsive:          true,
			maintainAspectRatio: false,
			cutout:  "60%",    /* CHANGE 5: compact appearance */
			plugins: {
				legend: {
					position: "bottom",
					labels:   { boxWidth: 8, boxHeight: 8, padding: 6, font: { size: 9 } },
				},
			},
		},
	});
}
 
function updatePestStageRadialChart() {
	var ctx = root_element.querySelector("#pest-stage-radial-chart");
	if (!ctx || !scoutingData) return;
	if (window._pestStageRadialChart) window._pestStageRadialChart.destroy();
 
	var pestName    = root_element.querySelector("#pest-weekly-pest-filter")?.value || "";
	var stageCounts = {};
 
	if (pestName && scoutingData.pests[pestName]) {
		(scoutingData.pests[pestName].counts || []).forEach(function (c) {
			var s = c.stage || "Unknown";
			stageCounts[s] = (stageCounts[s] || 0) + toNumber(c.count || 1);
		});
	} else {
		Object.values(scoutingData.pests || {}).forEach(function (p) {
			(p.counts || []).forEach(function (c) {
				var s = c.stage || "Unknown";
				stageCounts[s] = (stageCounts[s] || 0) + toNumber(c.count || 1);
			});
		});
	}
 
	var labels  = Object.keys(stageCounts).sort();
	var values  = labels.map(function (l) { return stageCounts[l]; });
	var palette = [
		"#10b981","#3b82f6","#f59e0b","#8b5cf6",
		"#ef4444","#ec4899","#14b8a6","#f97316",
	];
 
	window._pestStageRadialChart = new Chart(ctx, {
		type: "bar",
		data: {
			labels: labels,
			datasets: [{
				label:           pestName ? "Entries by Stage – " + pestName : "Entries by Stage (all pests)",
				data:            values,
				backgroundColor: labels.map(function (_, i) {
					return palette[i % palette.length] + "cc";
				}),
				borderColor: labels.map(function (_, i) {
					return palette[i % palette.length];
				}),
				borderWidth:  1,
				borderRadius: 4,
			}],
		},
		options: {
			responsive:          true,
			maintainAspectRatio: false,
			plugins: {
				legend: { display: false },
				tooltip: {
					callbacks: {
						label: function (item) {
							var total = values.reduce(function (a, b) { return a + b; }, 0);
							var pct   = total ? ((item.raw / total) * 100).toFixed(1) : 0;
							return " " + item.raw + " (" + pct + "%)";
						},
					},
				},
			},
			scales: {
				x: { grid: { display: false } },
				y: {
					beginAtZero: true,
					grid:  { color: "rgba(0,0,0,.04)" },
					ticks: { stepSize: 1 },
				},
			},
		},
	});
}
 

function updatePestStagesTable() {
	var tbody = root_element.querySelector("#pest-stages-body");
	if (!tbody) return;
 
	var stages = [];
	Object.keys(scoutingData.pests).forEach(function (pest) {
		scoutingData.pests[pest].counts.slice(0, 20).forEach(function (c) {
			stages.push({
				pest:       pest,
				stage:      c.stage      || "N/A",
				count:      c.count      || 1,
				section:    c.section    || "N/A",
				date:       c.date,
				greenhouse: c.greenhouse,
				bed:        c.bed        || "",
			});
		});
	});

	stages.sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
	stages = stages.slice(0, 50);

	tbody.innerHTML = stages.length === 0
		? '<tr><td colspan="7" class="empty-state">No pest stages found</td></tr>'
		: stages.map(function (s) {
			return (
				'<tr>'
				+ '<td><span class="pest-badge">' + s.pest              + '</span></td>'
				+ '<td>'                           + s.stage             + '</td>'
				+ '<td><strong>'                   + s.count             + '</strong></td>'
				+ '<td>'                           + s.section           + '</td>'
				+ '<td>'                           + s.date              + '</td>'
				+ '<td>'                           + (s.greenhouse || "-") + '</td>'
				+ '<td style="color:var(--text-muted,#888);font-size:0.85em">' + (s.bed || "-") + '</td>'
				+ '</tr>'
			);
		}).join("");
}
 


/* ==========  DISEASE TAB  ========== */

function updateDiseaseTab() {
	if (!scoutingData) return;
 
	var diseases = scoutingData.diseases;
	var names    = Object.keys(diseases);
	var totalObs = scoutingData.entries.reduce(function (s, e) {
		return s + (e.diseases_scouting_entry || []).length;
	}, 0);
	var severe = names.reduce(function (s, d) {
		return s + diseases[d].severity.high;
	}, 0);
	var topDisease = names.length
		? names.reduce(function (a, b) {
			return diseases[a].counts.length > diseases[b].counts.length ? a : b;
		})
		: "None";
 
	_setText("#disease-total-entries", formatNumber(totalObs));
	_setText("#disease-active-count",  names.length);
	_setText("#disease-severe-count",  severe);
	_setText("#disease-top-name",      topDisease);
	_setText("#disease-top-count",     (diseases[topDisease]?.counts.length || 0) + " cases");
 
	updateDiseaseTrendChart();
	updateDiseaseWeeklyTrend();
	updateDiseaseDistributionChart();
	updateDiseaseSeverityBubbles();
	updateDiseaseStageChart();
	updateDiseaseStageRadialChart();
	updateDiseaseGhChart();
	updateDiseaseBedChart();
}

function updateDiseaseTrendChart() {
	var ctx = root_element.querySelector("#disease-trend-chart");
	if (!ctx) return;
	if (diseaseTrendChart) diseaseTrendChart.destroy();
 
	var dates     = Object.keys(scoutingData.daily).sort();
	var totalBeds = getTotalZonesForGreenhouses(scoutingData.entries);    /* CHANGE 2 */
	var stageVal  = (root_element.querySelector("#disease-weekly-stage-filter")?.value || "")
	                 .trim().toLowerCase();                                /* CHANGE 1 */
 
	/* Pre-build full daily map for the no-filter fast path */
	var fullDailyMap = buildDailyBedInfectionMap(scoutingData.entries, "diseases");
 
	var chartData = dates.map(function (d) {
		if (!stageVal) {
			return toBedInfectionPercent(fullDailyMap[d]?.size || 0, totalBeds);
		}
		/* CHANGE 1: re-count zones where selected stage appeared that day */
		var filtered = new Set();
		(scoutingData.entries || []).forEach(function (e) {
			if (e.date_of_capture !== d) return;
			(e.diseases_scouting_entry || []).forEach(function (dis) {
				var st = (dis.stage || dis.severity_level || "").trim().toLowerCase();
				if (st !== stageVal) return;
				var k = getDistributionBedKey(e);
				if (k) filtered.add(k);
			});
		});
		return toBedInfectionPercent(filtered.size, totalBeds);
	});
 
	diseaseTrendChart = new Chart(ctx, {
		type: "line",
		data: {
			labels: dates.map(function (d) { return d.slice(5); }),
			datasets: [{
				label:                "Zones Infected (%)",
				data:                 chartData,
				borderColor:          "#f59e0b",
				backgroundColor:      "rgba(245,158,11,.1)",
				borderWidth:          2,
				fill:                 true,
				tension:              0.4,
				pointRadius:          3,
				pointBackgroundColor: "#f59e0b",
			}],
		},
		options: {
			responsive:          true,
			maintainAspectRatio: false,
			plugins: { legend: { display: false } },
			scales: {
				x: { grid: { display: false } },
				y: {
					beginAtZero: true,
					/* CHANGE 3: max:100 removed */
					grid:  { color: "rgba(0,0,0,.04)" },
					ticks: { callback: function (v) { return v.toFixed(1) + "%"; } },
				},
			},
		},
	});
}

function updateDiseaseWeeklyTrend() {
	var disSel   = root_element.querySelector("#disease-weekly-disease-filter");
	var secSel   = root_element.querySelector("#disease-weekly-section-filter");
	var stageSel = root_element.querySelector("#disease-weekly-stage-filter"); /* CHANGE 1 */
 
	if (!disSel || !secSel || !stageSel || !scoutingYearData) return;
 
	/* Disease names */
	var dNames = Object.keys(scoutingYearData.diseases || {}).sort();
	setSelectOptions(
		disSel,
		[{ value: "", label: "All Diseases" }].concat(
			dNames.map(function (d) { return { value: d, label: d }; })
		)
	);
 
	/* Plant sections */
	var secs = new Set();
	Object.values(scoutingYearData.diseases || {}).forEach(function (d) {
		(d.counts || []).forEach(function (c) { if (c.section) secs.add(c.section); });
	});
	setSelectOptions(
		secSel,
		[{ value: "", label: "All Sections" }].concat(
			Array.from(secs).sort().map(function (s) { return { value: s, label: s }; })
		)
	);
 
	/* Stage options depend on which disease is selected */
	rebuildDiseaseStageOptions();

	updateDiseaseWeeklyTrendChart();
	updateDiseaseStageRadialChart();
}

function updateDiseaseWeeklyTrendChart() {
	var ctx = root_element.querySelector("#disease-weekly-trend-chart");
	if (!ctx || !scoutingData) return;
	if (diseaseWeeklyTrendChart) diseaseWeeklyTrendChart.destroy();

	var rangeInfo = getSelectedWeekRangeInfo();
	if (!rangeInfo) return;
	var axis = getDayRangeAxis(rangeInfo);
	if (!axis) return;

	var dayIndex = {};
	axis.keys.forEach(function (k, i) { dayIndex[k] = i; });

	var diseaseName = root_element.querySelector("#disease-weekly-disease-filter")?.value || "";
	var section     = root_element.querySelector("#disease-weekly-section-filter")?.value || "";
	var stage       = root_element.querySelector("#disease-weekly-stage-filter")?.value   || "";
	var totalBeds   = getTotalZonesForGreenhouses(scoutingData.entries);

	var includeFn = function (c) {
		if (section && c.section !== section)     return false;
		if (stage   && (c.stage || "") !== stage) return false;
		return true;
	};

	var datasets = [];

	if (!section) {
		/* All Sections: stratify – one line per section */
		var allCounts = diseaseName
			? (scoutingData.diseases?.[diseaseName]?.counts || [])
			: Object.values(scoutingData.diseases || {}).reduce(function (acc, d) {
				return acc.concat(d.counts || []);
			}, []);
		var sections = Array.from(new Set(
			allCounts.map(function (c) { return c.section || ""; }).filter(Boolean)
		)).sort();
		if (sections.length === 0) {
			/* No section data: one line per disease */
			(diseaseName ? [diseaseName] : Object.keys(scoutingData.diseases || {}).sort()).forEach(function (dn, idx) {
				var d = buildDailyBedInfectionSeries(
					scoutingData.diseases[dn]?.counts || [],
					axis, dayIndex, totalBeds, function (c) {
						return !stage || (c.stage || "") === stage;
					}
				);
				if (!d.some(function (v) { return v > 0; })) return;
				var pal = getPaletteColor(idx);
				datasets.push({
					label:           dn,
					data:            d,
					borderColor:     observationColors.diseases[dn] || pal.border,
					backgroundColor: pal.background,
					borderWidth:     2,
					fill:            false,
					tension:         0.4,
					pointRadius:     0,
					order:           idx,
				});
			});
		} else {
			sections.forEach(function (sec, idx) {
				var sectionIncludeFn = function (c) {
					if (c.section !== sec) return false;
					if (stage && (c.stage || "") !== stage) return false;
					return true;
				};
				var d = buildDailyBedInfectionSeries(allCounts, axis, dayIndex, totalBeds, sectionIncludeFn);
				if (!d.some(function (v) { return v > 0; })) return;
				var pal = getPaletteColor(idx);
				datasets.push({
					label:           diseaseName ? diseaseName + " – " + sec : sec,
					data:            d,
					borderColor:     pal.border,
					backgroundColor: pal.background,
					borderWidth:     2,
					fill:            false,
					tension:         0.4,
					pointRadius:     0,
					order:           idx,
				});
			});
		}
	} else if (diseaseName) {
		/* Specific disease + specific section: single line */
		var d = buildDailyBedInfectionSeries(
			scoutingData.diseases?.[diseaseName]?.counts || [],
			axis, dayIndex, totalBeds, includeFn
		);
		datasets.push({
			label:           diseaseName + " (" + section + ")" + (stage ? " [" + stage + "]" : ""),
			data:            d,
			borderColor:     observationColors.diseases[diseaseName] || "#f59e0b",
			backgroundColor: "rgba(245,158,11,.1)",
			borderWidth:     2,
			fill:            false,
			tension:         0.4,
			pointRadius:     2,
		});
	} else {
		/* All diseases + specific section: one line per disease */
		Object.keys(scoutingData.diseases || {}).sort().forEach(function (dn, idx) {
			var d = buildDailyBedInfectionSeries(
				scoutingData.diseases[dn].counts || [],
				axis, dayIndex, totalBeds, includeFn
			);
			if (!d.some(function (v) { return v > 0; })) return;
			var pal = getPaletteColor(idx);
			datasets.push({
				label:           dn + " (" + section + ")",
				data:            d,
				borderColor:     observationColors.diseases[dn] || pal.border,
				backgroundColor: pal.background,
				borderWidth:     2,
				fill:            false,
				tension:         0.4,
				pointRadius:     0,
				order:           idx,
			});
		});
	}

	diseaseWeeklyTrendChart = new Chart(ctx, {
		type: "line",
		data: { labels: axis.labels, datasets: datasets },
		options: {
			responsive:          true,
			maintainAspectRatio: false,
			plugins: {
				legend: {
					display:  datasets.length > 1,
					position: "bottom",
					labels:   { boxWidth: 10, boxHeight: 10, padding: 10, font: { size: 10 } },
				},
				tooltip: {
					mode:      "index",
					intersect: false,
					callbacks: {
						title: function (items) {
							var i = items?.[0]?.dataIndex;
							return i !== undefined ? axis.keys[i] : "";
						},
					},
				},
			},
			scales: {
				x: {
					grid:  { display: false },
					ticks: { autoSkip: true, maxTicksLimit: 14 },
				},
				y: {
					beginAtZero: true,
					grid:  { color: "rgba(0,0,0,.04)" },
					ticks: { callback: function (v) { return v.toFixed(1) + "%"; } },
				},
			},
		},
	});
}


function updateDiseaseDistributionChart() {
	var ctx = root_element.querySelector("#disease-distribution-chart");
	if (!ctx) return;
	if (diseaseDistChart) diseaseDistChart.destroy();
 
	var diseases  = scoutingData.diseases;
	var labels    = Object.keys(diseases).slice(0, 10);
	var totalBeds = getTotalZonesForGreenhouses(scoutingData.entries); /* CHANGE 2 */
	var palette   = [
		"#f59e0b","#ef4444","#8b5cf6","#10b981","#3b82f6",
		"#ec4899","#14b8a6","#f97316","#6366f1","#06b6d4",
	];
 
	var data = labels.map(function (d) {
		var beds = new Set();
		(diseases[d].counts || []).forEach(function (c) {
			var k = getDistributionBedKey(c);
			if (k) beds.add(k);
		});
		return totalBeds ? Number(((beds.size / totalBeds) * 100).toFixed(2)) : 0;
	});
 
	diseaseDistChart = new Chart(ctx, {
		type: "bar",
		data: {
			labels: labels,
			datasets: [{
				label:           "Zones Infected (%)",
				data:            data,
				backgroundColor: labels.map(function (l, i) {
					return observationColors.diseases[l] || palette[i % palette.length];
				}),
				borderRadius: 4,
			}],
		},
		options: {
			responsive:          true,
			maintainAspectRatio: false,
			plugins: { legend: { display: false } },
			scales: {
				y: {
					beginAtZero: true,
					/* CHANGE 3: no max:100 */
					grid:  { color: "rgba(0,0,0,.04)" },
					ticks: { callback: function (v) { return v + "%"; } },
				},
			},
		},
	});
}

function updateDiseaseSeverityBubbles() {
	var container = root_element.querySelector("#disease-severity-bubbles");
	if (!container) return;
 
	var diseases = scoutingData.diseases;
	container.innerHTML = Object.keys(diseases).slice(0, 12).map(function (dis) {
		var d       = diseases[dis];
		var total   = d.counts.length;
		var highPct = total ? d.severity.high / total : 0;
		var size    = Math.min(60 + total * 2, 120);
		var color   = highPct > 0.5 ? "#ef4444" : highPct > 0.2 ? "#f59e0b" : "#10b981";
		return (
			'<div class="bubble-item">'
			+ '<div class="bubble" style="width:' + size + 'px;height:' + size + 'px;background:' + color + '">'
			+ '<span>' + Math.round(highPct * 100) + '%</span>'
			+ '</div>'
			+ '<div class="bubble-label">' + dis   + '</div>'
			+ '<div class="bubble-sub">'   + total + ' cases</div>'
			+ '</div>'
		);
	}).join("") || '<div class="empty-state">No disease data available</div>';
}

function updateDiseaseStageChart() {
	var ctx = root_element.querySelector("#disease-stage-chart");
	if (!ctx) return;
	if (diseaseStageChart) diseaseStageChart.destroy();
 
	/* CHANGE 5: use only the selected disease's stages when filtered */
	var diseaseName = root_element.querySelector("#disease-weekly-disease-filter")?.value || "";
	var stages = {};
 
	if (diseaseName && scoutingData.diseases[diseaseName]) {
		Object.assign(stages, scoutingData.diseases[diseaseName].stages || {});
	} else {
		Object.keys(scoutingData.diseases).forEach(function (dis) {
			Object.keys(scoutingData.diseases[dis].stages).forEach(function (st) {
				stages[st] = (stages[st] || 0) + scoutingData.diseases[dis].stages[st];
			});
		});
	}
 
	diseaseStageChart = new Chart(ctx, {
		type: "doughnut",
		data: {
			labels: Object.keys(stages),
			datasets: [{
				data:            Object.values(stages),
				backgroundColor: ["#f59e0b","#3b82f6","#ef4444","#10b981","#8b5cf6"],
				borderWidth:     2,
			}],
		},
		options: {
			responsive:          true,
			maintainAspectRatio: false,
			cutout:  "62%",   /* CHANGE 5: larger cutout = visually compact */
			plugins: {
				legend: {
					position: "bottom",
					labels:   { boxWidth: 8, boxHeight: 8, padding: 6, font: { size: 9 } },
				},
			},
		},
	});
}

function updateDiseaseStageRadialChart() {
	var ctx = root_element.querySelector("#disease-stage-radial-chart");
	if (!ctx || !scoutingData) return;
	if (window._diseaseStageRadialChart) window._diseaseStageRadialChart.destroy();
 
	var diseaseName = root_element.querySelector("#disease-weekly-disease-filter")?.value || "";
	var stageCounts = {};
 
	if (diseaseName && scoutingData.diseases[diseaseName]) {
		Object.entries(scoutingData.diseases[diseaseName].stages || {}).forEach(function (kv) {
			stageCounts[kv[0]] = (stageCounts[kv[0]] || 0) + kv[1];
		});
	} else {
		Object.values(scoutingData.diseases || {}).forEach(function (d) {
			Object.entries(d.stages || {}).forEach(function (kv) {
				stageCounts[kv[0]] = (stageCounts[kv[0]] || 0) + kv[1];
			});
		});
	}
 
	var labels  = Object.keys(stageCounts).sort();
	var values  = labels.map(function (l) { return stageCounts[l]; });
	var palette = [
		"#f59e0b","#ef4444","#8b5cf6","#10b981",
		"#3b82f6","#ec4899","#14b8a6","#f97316",
	];
 
	window._diseaseStageRadialChart = new Chart(ctx, {
		type: "bar",
		data: {
			labels: labels,
			datasets: [{
				label:           diseaseName ? "Entries by Stage – " + diseaseName : "Entries by Stage (all diseases)",
				data:            values,
				backgroundColor: labels.map(function (_, i) {
					return palette[i % palette.length] + "cc";
				}),
				borderColor: labels.map(function (_, i) {
					return palette[i % palette.length];
				}),
				borderWidth:  1,
				borderRadius: 4,
			}],
		},
		options: {
			responsive:          true,
			maintainAspectRatio: false,
			plugins: {
				legend: { display: false },
				tooltip: {
					callbacks: {
						label: function (item) {
							var total = values.reduce(function (a, b) { return a + b; }, 0);
							var pct   = total ? ((item.raw / total) * 100).toFixed(1) : 0;
							return " " + item.raw + " (" + pct + "%)";
						},
					},
				},
			},
			scales: {
				x: { grid: { display: false } },
				y: {
					beginAtZero: true,
					grid:  { color: "rgba(0,0,0,.04)" },
					ticks: { stepSize: 1 },
				},
			},
		},
	});
}

function updateDiseaseIncidentsTable() {
	var tbody = root_element.querySelector("#disease-incidents-body");
	if (!tbody) return;

	var incidents = [];
	Object.keys(scoutingData.diseases).forEach(function (dis) {
		scoutingData.diseases[dis].counts.slice(0, 20).forEach(function (c) {
			var sev = (c.stage || "").toLowerCase();
			incidents.push({
				disease:    dis,
				stage:      c.stage || "N/A",
				severity:   sev.includes("active") || sev.includes("high") ? "High"
				            : sev.includes("moderate") ? "Moderate" : "Low",
				section:    c.section    || "N/A",
				date:       c.date,
				greenhouse: c.greenhouse,
				bed:        c.bed        || "",
			});
		});
	});

	incidents.sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
	incidents = incidents.slice(0, 50);

	tbody.innerHTML = incidents.length === 0
		? '<tr><td colspan="7" class="empty-state">No disease incidents found</td></tr>'
		: incidents.map(function (i) {
			return (
				'<tr>'
				+ '<td><span class="pest-badge">' + i.disease   + '</span></td>'
				+ '<td>'                           + i.stage     + '</td>'
				+ '<td><span class="severity-tag ' + i.severity.toLowerCase() + '">'
				+   i.severity + '</span></td>'
				+ '<td>'  + i.section             + '</td>'
				+ '<td>'  + i.date                + '</td>'
				+ '<td>'  + (i.greenhouse || "-") + '</td>'
				+ '<td style="color:var(--text-muted,#888);font-size:0.85em">' + (i.bed || "-") + '</td>'
				+ '</tr>'
			);
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
	updateTrapGhChart();
	updateTrapIndoorOutdoorChart();
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
	var axis = getDayRangeAxis(rangeInfo);
	if (!axis) return;
	var dayIndex = {};
	axis.keys.forEach(function (k, i) { dayIndex[k] = i; });
	var trapName = root_element.querySelector("#trap-weekly-trap-filter")?.value || "";
	var pestName = root_element.querySelector("#trap-weekly-pest-filter")?.value || "";
	var datasets = [];

	if (pestName) {
		var dailyCounts = new Array(axis.keys.length).fill(0);
		Object.keys(scoutingData.traps || {}).forEach(function (k) {
			var t = scoutingData.traps[k];
			if (trapName && t.trap !== trapName) return;
			if (t.pest !== pestName) return;
			(t.counts || []).forEach(function (c) {
				var i = dayIndex[c.date];
				if (i !== undefined) dailyCounts[i] += Number(c.count || 0);
			});
		});
		datasets.push({ label: (trapName || "All Traps") + " (" + pestName + ")", data: dailyCounts, borderColor: observationColors.pests[pestName] || "#3b82f6", backgroundColor: "rgba(59,130,246,.1)", borderWidth: 2, fill: false, tension: 0.4, pointRadius: 0 });
	} else {
		var byPest = {};
		Object.keys(scoutingData.traps || {}).forEach(function (k) {
			var t = scoutingData.traps[k];
			if (trapName && t.trap !== trapName) return;
			var pest = t.pest || "Unknown";
			if (!byPest[pest]) byPest[pest] = new Array(axis.keys.length).fill(0);
			(t.counts || []).forEach(function (c) {
				var i = dayIndex[c.date];
				if (i !== undefined) byPest[pest][i] += Number(c.count || 0);
			});
		});
		Object.keys(byPest).sort().forEach(function (p, idx) {
			var total = byPest[p].reduce(function (a, b) { return a + b; }, 0);
			if (total <= 0) return;
			var pal = getPaletteColor(idx);
			datasets.push({ label: p, data: byPest[p], borderColor: observationColors.pests[p] || pal.border, backgroundColor: pal.background, borderWidth: 2, fill: false, tension: 0.4, pointRadius: 0, order: idx });
		});
	}
	trapWeeklyTrendChart = new Chart(ctx, {
		type: "line",
		data: { labels: axis.labels, datasets: datasets },
		options: {
			responsive: true, maintainAspectRatio: false,
			plugins: {
				legend: { display: datasets.length > 1, position: "bottom", labels: { boxWidth: 10, boxHeight: 10, padding: 10, font: { size: 10 } } },
				tooltip: { mode: "index", intersect: false, callbacks: { title: function (items) { var i = items?.[0]?.dataIndex; return i !== undefined ? axis.keys[i] : ""; } } },
			},
			scales: { x: { grid: { display: false }, ticks: { autoSkip: true, maxTicksLimit: 14 } }, y: { beginAtZero: true, grid: { color: "rgba(0,0,0,.04)" } } },
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
			details.push({
				trap: scoutingData.traps[k].trap,
				pest: scoutingData.traps[k].pest,
				count: c.count || 0,
				location: c.location || "N/A",
				date: c.date,
				greenhouse: c.greenhouse,
				bed: c.bed || "",
			});
		});
	});
	details.sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
	details = details.slice(0, 50);
	tbody.innerHTML = details.length === 0
		? '<tr><td colspan="7" class="empty-state">No trap data found</td></tr>'
		: details.map(function (d) {
			return (
				'<tr>'
				+ '<td>' + d.trap + '</td>'
				+ '<td>' + d.pest + '</td>'
				+ '<td><strong>' + d.count + '</strong></td>'
				+ '<td>' + d.location + '</td>'
				+ '<td>' + d.date + '</td>'
				+ '<td>' + (d.greenhouse || "-") + '</td>'
				+ '<td style="color:var(--text-muted,#888);font-size:0.85em">' + (d.bed || "-") + '</td>'
				+ '</tr>'
			);
		}).join("");
}


/* ==========  GREENHOUSE / BED / INDOOR-OUTDOOR BAR CHARTS  ========== */

/* ── helpers ── */
function _ghBarBaseOpts(labelText) {
	return {
		responsive: true, maintainAspectRatio: false,
		indexAxis: "y",
		plugins: {
			legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 10 } } },
			tooltip: { mode: "index", intersect: false },
		},
		scales: {
			x: { stacked: true, beginAtZero: true, title: { display: !!labelText, text: labelText || "", font: { size: 10 } }, ticks: { font: { size: 10 } } },
			y: { stacked: true, ticks: { font: { size: 10 } } },
		},
	};
}

function _ghBarDualOpts(countLabel, zonePctLabel) {
	/* dual X axes: bottom = observation count, top = zone coverage % */
	return {
		responsive: true, maintainAspectRatio: false,
		indexAxis: "y",
		plugins: {
			legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 10 } } },
			tooltip: { mode: "index", intersect: false },
		},
		scales: {
			x:  { position: "bottom", beginAtZero: true, title: { display: true, text: countLabel,   font: { size: 10 } }, ticks: { font: { size: 10 } } },
			x2: { position: "top",    beginAtZero: true, min: 0, max: 100,
			      title: { display: true, text: zonePctLabel, font: { size: 10 } },
			      ticks: { font: { size: 10 }, callback: function (v) { return v + "%"; } } },
			y:  { ticks: { font: { size: 10 } } },
		},
	};
}

/* ── shared: unique scouting entries per greenhouse ── */
function _buildGhEntryVisits(data) {
	var visits = {};
	(data.entries || []).forEach(function (e) {
		var gh = (e.greenhouse || "Unknown").trim();
		visits[gh] = (visits[gh] || 0) + 1;
	});
	return visits;
}

/* ── shared: zone coverage % with bed-count fallback ── */
function _ghZonePct(gh, visits, zonesMap) {
	var normalGh = (gh || "").trim();
	var zones = zonesMap[normalGh] || zonesMap[gh] || 0;
	var v = visits[normalGh] || visits[gh] || 0;
	if (zones > 0) return Math.min(100, Math.round((v / zones) * 100));
	/* fallback: fraction of year-total visits (relative activity) */
	if (scoutingYearData) {
		var yearVisits = _buildGhEntryVisits(scoutingYearData);
		var yearTotal = yearVisits[normalGh] || yearVisits[gh] || 0;
		if (yearTotal > 0) return Math.min(100, Math.round((v / yearTotal) * 100));
	}
	return 0;
}

/* ── Pest GH bar ── */
function updatePestGhChart() {
	var ctx = root_element.querySelector("#pest-gh-bar-chart");
	if (!ctx) return;
	if (pestGhChart) pestGhChart.destroy();

	/* count observation records and unique entry visits per greenhouse */
	var ghObs = {}, ghCnt = {};
	Object.values(scoutingData.pests).forEach(function (p) {
		p.counts.forEach(function (c) {
			var gh = (c.greenhouse || "Unknown").trim();
			ghObs[gh] = (ghObs[gh] || 0) + 1;
			ghCnt[gh] = (ghCnt[gh] || 0) + (c.count || 1);
		});
	});
	var ghVisits = _buildGhEntryVisits(scoutingData);
	var labels = Object.keys(ghObs).sort(function (a, b) { return ghObs[b] - ghObs[a]; }).slice(0, 12);
	var obsCounts = labels.map(function (g) { return ghObs[g]; });
	var zonePct   = labels.map(function (g) { return _ghZonePct(g, ghVisits, zonesPerGreenhouse); });

	pestGhChart = new Chart(ctx, {
		type: "bar",
		data: {
			labels: labels,
			datasets: [
				{ label: "Observations", data: obsCounts, xAxisID: "x",
				  backgroundColor: "rgba(239,68,68,0.7)", borderColor: "rgba(239,68,68,1)", borderWidth: 1 },
				{ label: "Zone Coverage %", data: zonePct, xAxisID: "x2",
				  backgroundColor: "rgba(59,130,246,0.35)", borderColor: "rgba(59,130,246,0.8)", borderWidth: 1 },
			],
		},
		options: _ghBarDualOpts("Observations", "Zone Coverage %"),
	});
}

/* ── Pest Bed bar ── */
function updatePestBedChart() {
	var ctx = root_element.querySelector("#pest-bed-bar-chart");
	if (!ctx) return;
	if (pestBedChart) pestBedChart.destroy();

	var bedTotals = {};
	Object.values(scoutingData.pests).forEach(function (p) {
		p.counts.forEach(function (c) {
			var key = (c.bed || "No bed") + " · " + (c.greenhouse || "");
			bedTotals[key] = (bedTotals[key] || 0) + (c.count || 1);
		});
	});
	var labels = Object.keys(bedTotals).sort(function (a, b) { return bedTotals[b] - bedTotals[a]; }).slice(0, 12);

	pestBedChart = new Chart(ctx, {
		type: "bar",
		data: {
			labels: labels,
			datasets: [{ label: "Total Pest Count", data: labels.map(function (l) { return bedTotals[l]; }),
			  backgroundColor: "rgba(239,68,68,0.7)", borderColor: "rgba(239,68,68,1)", borderWidth: 1 }],
		},
		options: _ghBarBaseOpts("Total Pest Count"),
	});
}

/* ── Disease GH bar ── */
function updateDiseaseGhChart() {
	var ctx = root_element.querySelector("#disease-gh-bar-chart");
	if (!ctx) return;
	if (diseaseGhChart) diseaseGhChart.destroy();

	var ghObs = {};
	Object.values(scoutingData.diseases).forEach(function (d) {
		d.counts.forEach(function (c) {
			var gh = (c.greenhouse || "Unknown").trim();
			ghObs[gh] = (ghObs[gh] || 0) + 1;
		});
	});
	var ghVisits = _buildGhEntryVisits(scoutingData);
	var labels = Object.keys(ghObs).sort(function (a, b) { return ghObs[b] - ghObs[a]; }).slice(0, 12);
	var obsCounts = labels.map(function (g) { return ghObs[g]; });
	var zonePct   = labels.map(function (g) { return _ghZonePct(g, ghVisits, zonesPerGreenhouse); });

	diseaseGhChart = new Chart(ctx, {
		type: "bar",
		data: {
			labels: labels,
			datasets: [
				{ label: "Incidents", data: obsCounts, xAxisID: "x",
				  backgroundColor: "rgba(245,158,11,0.7)", borderColor: "rgba(245,158,11,1)", borderWidth: 1 },
				{ label: "Zone Coverage %", data: zonePct, xAxisID: "x2",
				  backgroundColor: "rgba(16,185,129,0.35)", borderColor: "rgba(16,185,129,0.8)", borderWidth: 1 },
			],
		},
		options: _ghBarDualOpts("Incidents", "Zone Coverage %"),
	});
}

/* ── Disease Bed bar ── */
function updateDiseaseBedChart() {
	var ctx = root_element.querySelector("#disease-bed-bar-chart");
	if (!ctx) return;
	if (diseaseBedChart) diseaseBedChart.destroy();

	var bedTotals = {};
	Object.values(scoutingData.diseases).forEach(function (d) {
		d.counts.forEach(function (c) {
			var key = (c.bed || "No bed") + " · " + (c.greenhouse || "");
			bedTotals[key] = (bedTotals[key] || 0) + 1;
		});
	});
	var labels = Object.keys(bedTotals).sort(function (a, b) { return bedTotals[b] - bedTotals[a]; }).slice(0, 12);

	diseaseBedChart = new Chart(ctx, {
		type: "bar",
		data: {
			labels: labels,
			datasets: [{ label: "Disease Incidents", data: labels.map(function (l) { return bedTotals[l]; }),
			  backgroundColor: "rgba(245,158,11,0.7)", borderColor: "rgba(245,158,11,1)", borderWidth: 1 }],
		},
		options: _ghBarBaseOpts("Disease Incidents"),
	});
}

/* ── Trap GH bar: FCM vs General stacked ── */
function updateTrapGhChart() {
	var ctx = root_element.querySelector("#trap-gh-bar-chart");
	if (!ctx) return;
	if (trapGhChart) trapGhChart.destroy();

	var fcmGh = {}, genGh = {};
	Object.values(scoutingData.traps).forEach(function (t) {
		var isFcm = getFocusKey ? !!getFocusKey(t.pest) : false;
		t.counts.forEach(function (c) {
			var gh = c.greenhouse || "Unknown";
			if (isFcm) fcmGh[gh] = (fcmGh[gh] || 0) + (c.count || 0);
			else        genGh[gh] = (genGh[gh] || 0) + (c.count || 0);
		});
	});
	var allGh = Array.from(new Set(Object.keys(fcmGh).concat(Object.keys(genGh))));
	allGh.sort(function (a, b) {
		return ((fcmGh[b] || 0) + (genGh[b] || 0)) - ((fcmGh[a] || 0) + (genGh[a] || 0));
	});
	var labels = allGh.slice(0, 12);

	trapGhChart = new Chart(ctx, {
		type: "bar",
		data: {
			labels: labels,
			datasets: [
				{ label: "FCM / Focus Traps", data: labels.map(function (g) { return fcmGh[g] || 0; }),
				  backgroundColor: "rgba(239,68,68,0.75)", borderColor: "rgba(239,68,68,1)", borderWidth: 1 },
				{ label: "General Traps", data: labels.map(function (g) { return genGh[g] || 0; }),
				  backgroundColor: "rgba(99,102,241,0.65)", borderColor: "rgba(99,102,241,1)", borderWidth: 1 },
			],
		},
		options: _ghBarBaseOpts("Catch Count"),
	});
}

/* ── Indoor vs Outdoor bar ── */
function updateTrapIndoorOutdoorChart() {
	var ctx = root_element.querySelector("#trap-indoor-outdoor-chart");
	if (!ctx) return;
	if (trapIndoorOutdoorChart) trapIndoorOutdoorChart.destroy();

	var indoorGh = {}, outdoorGh = {};
	Object.values(scoutingData.traps).forEach(function (t) {
		t.counts.forEach(function (c) {
			var gh  = c.greenhouse || "Unknown";
			var loc = (c.location || "").toLowerCase();
			var isOut = loc.includes("outdoor") || loc.includes("field") || loc.includes("outside");
			if (isOut) outdoorGh[gh] = (outdoorGh[gh] || 0) + 1;
			else       indoorGh[gh]  = (indoorGh[gh]  || 0) + 1;
		});
	});
	var allGh = Array.from(new Set(Object.keys(indoorGh).concat(Object.keys(outdoorGh))));
	allGh.sort(function (a, b) {
		return ((indoorGh[b] || 0) + (outdoorGh[b] || 0)) - ((indoorGh[a] || 0) + (outdoorGh[a] || 0));
	});
	var labels = allGh.slice(0, 12);

	trapIndoorOutdoorChart = new Chart(ctx, {
		type: "bar",
		data: {
			labels: labels,
			datasets: [
				{ label: "Indoor", data: labels.map(function (g) { return indoorGh[g] || 0; }),
				  backgroundColor: "rgba(16,185,129,0.7)", borderColor: "rgba(16,185,129,1)", borderWidth: 1 },
				{ label: "Outdoor / Field", data: labels.map(function (g) { return outdoorGh[g] || 0; }),
				  backgroundColor: "rgba(245,158,11,0.65)", borderColor: "rgba(245,158,11,1)", borderWidth: 1 },
			],
		},
		options: _ghBarBaseOpts("Entries"),
	});
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

/* colour palette for focus pests – stable colours per key */
var FCM_MOTH_COLORS = {
	fcm:              { border: "rgba(220,38,38,1)",   bg: "rgba(220,38,38,0.12)"  },
	helicoverpa:      { border: "rgba(234,88,12,1)",   bg: "rgba(234,88,12,0.12)"  },
	duponchella:      { border: "rgba(161,161,170,1)", bg: "rgba(161,161,170,0.12)" },
	spodoptera:       { border: "rgba(99,102,241,1)",  bg: "rgba(99,102,241,0.12)" },
	unidentified_moth:{ border: "rgba(20,184,166,1)",  bg: "rgba(20,184,166,0.12)" },
};

function updateFcmTrendChart() {
	var ctx = root_element.querySelector("#fcm-moth-trend-chart");
	if (!ctx || !scoutingData) return;
	if (fcmMothTrendChart) fcmMothTrendChart.destroy();

	var rangeInfo = getSelectedWeekRangeInfo();
	if (!rangeInfo) return;
	var axis = getDayRangeAxis(rangeInfo);
	if (!axis) return;
	var dayIndex = {};
	axis.keys.forEach(function (k, i) { dayIndex[k] = i; });

	/* build one accumulator per focus-pest key */
	var totals = {};
	FOCUS_PESTS.forEach(function (f) { totals[f.key] = new Array(axis.keys.length).fill(0); });

	/* trap catches */
	Object.values(scoutingData.traps || {}).forEach(function (t) {
		var key = getFocusKey(t.pest || "");
		if (!key) return;
		(t.counts || []).forEach(function (c) {
			var i = dayIndex[c.date];
			if (i !== undefined) totals[key][i] += Number(c.count || 0);
		});
	});

	/* pest scouting observations */
	Object.keys(scoutingData.pests || {}).forEach(function (pn) {
		var key = getFocusKey(pn);
		if (!key) return;
		(scoutingData.pests[pn].counts || []).forEach(function (c) {
			var i = dayIndex[c.date];
			if (i !== undefined) totals[key][i] += Number(c.count || 1);
		});
	});

	var datasets = FOCUS_PESTS
		.filter(function (f) { return totals[f.key].some(function (v) { return v > 0; }); })
		.map(function (f) {
			var col = FCM_MOTH_COLORS[f.key] || { border: "#94a3b8", bg: "rgba(148,163,184,0.12)" };
			return {
				label: f.label,
				data: totals[f.key],
				borderColor: col.border,
				backgroundColor: col.bg,
				borderWidth: 2,
				fill: false,
				tension: 0.35,
				pointRadius: 0,
				pointHoverRadius: 4,
			};
		});

	fcmMothTrendChart = new Chart(ctx, {
		type: "line",
		data: { labels: axis.labels, datasets: datasets },
		options: {
			responsive: true, maintainAspectRatio: false,
			plugins: {
				legend: { display: true, position: "bottom", labels: { boxWidth: 10, boxHeight: 10, padding: 12, font: { size: 10 } } },
				tooltip: {
					mode: "index", intersect: false,
					callbacks: { title: function (items) { var i = items?.[0]?.dataIndex; return i !== undefined ? axis.keys[i] : ""; } },
				},
			},
			scales: {
				x: { grid: { display: false }, ticks: { autoSkip: true, maxTicksLimit: 14, font: { size: 9 } } },
				y: { beginAtZero: true, grid: { color: "rgba(0,0,0,.04)" }, ticks: { font: { size: 10 } } },
			},
		},
	});
}

function updateFcmTab() {
	if (!scoutingData) return;

	updateFcmTrendChart();

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
	var _ghTrapTotal = Object.keys(scoutingData.traps).reduce(function (sum, k) {
		return sum + scoutingData.traps[k].counts
			.filter(function (c) { return c.greenhouse === greenhouse; })
			.reduce(function (s, c) { return s + c.count; }, 0);
	}, 0);
	_setText("#ghk-traps", formatNumber(_ghTrapTotal));
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
		if (cnt) {
			var name = scoutingData.traps[k].trap;
			var ghTot = scoutingData.traps[k].counts
				.filter(function (c) { return c.greenhouse === greenhouse; })
				.reduce(function (s, c) { return s + c.count; }, 0);
			trapCounts[name] = (trapCounts[name] || 0) + ghTot;
		}
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

	/* use selected week range so the modal reflects the same period */
	var rangeInfo = getSelectedWeekRangeInfo();
	var dayAxis   = rangeInfo ? getDayRangeAxis(rangeInfo) : null;

	var ghEntries = scoutingData.entries.filter(function (e) { return e.greenhouse === greenhouse; });
	var totalBeds = getTotalZonesForGreenhouses(ghEntries) || 1;

	/* per-day bed infection sets + trap counts */
	var pestBeds = {}, disBeds = {}, trapCounts = {};
	ghEntries.forEach(function (e) {
		var d = e.date_of_capture;
		var bedKey = getDistributionBedKey(e);
		if ((e.pests_scouting_entry || []).length && bedKey) {
			if (!pestBeds[d]) pestBeds[d] = new Set();
			pestBeds[d].add(bedKey);
		}
		if ((e.diseases_scouting_entry || []).length && bedKey) {
			if (!disBeds[d]) disBeds[d] = new Set();
			disBeds[d].add(bedKey);
		}
		trapCounts[d] = (trapCounts[d] || 0) + (e.trap_scouting_entry || []).reduce(function (s, t) { return s + toNumber(t.count || 0); }, 0);
	});

	var dates, labels;
	if (dayAxis) {
		dates  = dayAxis.keys;
		labels = dayAxis.labels;
	} else {
		var seen = new Set(ghEntries.map(function (e) { return e.date_of_capture; }));
		dates  = Array.from(seen).sort().slice(-21);
		labels = dates.map(function (d) { return d.slice(5); });
	}

	window.ghTrendChart = new Chart(ctx, {
		type: "line",
		data: {
			labels: labels,
			datasets: [
				{
					label: "Pests Infected (%)",
					data: dates.map(function (d) { return toBedInfectionPercent((pestBeds[d] || { size: 0 }).size, totalBeds); }),
					borderColor: "#10b981", backgroundColor: "rgba(16,185,129,.1)", tension: 0.4, pointRadius: 4, fill: true,
				},
				{
					label: "Diseases Infected (%)",
					data: dates.map(function (d) { return toBedInfectionPercent((disBeds[d] || { size: 0 }).size, totalBeds); }),
					borderColor: "#f59e0b", backgroundColor: "rgba(245,158,11,.1)", tension: 0.4, pointRadius: 4, fill: true,
				},
				{
					label: "Trap Catch Count",
					data: dates.map(function (d) { return trapCounts[d] || 0; }),
					borderColor: "#3b82f6", backgroundColor: "rgba(59,130,246,.08)", tension: 0.4, pointRadius: 4, fill: false,
					yAxisID: "y2",
				},
			],
		},
		options: {
			responsive: true, maintainAspectRatio: false,
			plugins: { legend: { position: "bottom" } },
			scales: {
				x: { grid: { display: false } },
				y:  { beginAtZero: true, title: { display: true, text: "Infection %" }, grid: { color: "rgba(0,0,0,.04)" } },
				y2: { beginAtZero: true, position: "right", title: { display: true, text: "Trap Count" }, grid: { display: false } },
			},
		},
	});
}

function closeScoutModal() {
	var modal = root_element.querySelector("#scout-gh-modal");
	if (modal) modal.classList.remove("active");
}
