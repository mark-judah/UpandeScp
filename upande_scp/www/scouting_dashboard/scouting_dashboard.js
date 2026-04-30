/* ================================================================
 *  SCOUTING DASHBOARD  –  Full Rewrite
 *  Includes:  Reports dropdown (5 CSV exports), UI polish,
 *             bug-fixes (normalizeFocusName .trim() typo, etc.)
 * ================================================================ */

var root_element =
	document.getElementById("scouting-dashboard-root") || document;

/* ---------- Chart libraries bootstrap ----------
   ECharts powers every chart in the dashboard (overview + per-tab). */
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
	if (typeof echarts === "undefined") {
		pending.push(_loadScript("https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"));
	}
	Promise.all(pending).then(initScoutingDashboard).catch(function (err) {
		console.error("Scouting dashboard: chart library bootstrap failed", err);
	});
})();

/* ==========  GLOBAL STATE  ========== */

/* All charts are managed by echartRegistry (see ECharts section). */

var scoutingData = null;
var scoutingYearData = null;
var greenhouseFilter = "";
var farmFilter = "";
/* Crop filter — historical entries had no `crop_scouted` field; per the
   product spec they roll up under "Rose". Newer payloads always carry the
   field, so DEFAULT_CROP doubles as the implicit value for missing crops. */
var DEFAULT_CROP = "Rose";
var cropFilter = DEFAULT_CROP;
var allGreenhouses = [];
/* Canonical {farm: [greenhouse_name, ...]} map from scouting_metrics_api.
   Populated by loadGreenhouseOptions; falls back to parsing the greenhouse
   name for data that hasn't synced through yet. */
var farmsAndGreenhouses = {};
var greenhouseToFarm = {};
/* Crop scouted records (loaded once on init): [{name, crop_name, farms[]}].
   `cropFarms[crop]` holds the allowed-farms set for narrowing the Farm
   dropdown when a crop is selected. */
var cropsScouted = [];
var cropFarms = {};
/* {warehouse: {type:"greenhouse"|"block", count:N, farm:"", area_ha:0}} from
   backend. Drives the zones-vs-trees denominator for pressure metrics, and
   the area_ha denominator for Per-Hectare severity thresholds. */
var unitsPerWarehouse = {};
/* Per-crop severity bands from Crop Scouted:
   {crop: {pests: {pest: {unit, low, moderate, high}}, diseases: {...}}}.
   When empty for a given crop+pest combo, severity falls back to the legacy
   magnitude heuristic so old data keeps classifying. */
var severityThresholds = {};
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

/* Resolve an entry's effective crop. Empty / missing → DEFAULT_CROP ("Rose"),
   per spec — historical entries pre-date the field, but every new payload
   carries it. */
function getEntryCrop(entry) {
	var raw = (entry && entry.crop_scouted) ? String(entry.crop_scouted).trim() : "";
	return raw || DEFAULT_CROP;
}

/* Effective greenhouse for routing (greenhouse-type or block-type warehouse).
   The dashboard uses one logical "greenhouse" identity per entry; for block
   farms we adopt `block` as the warehouse name so all downstream maps
   (unitsPerWarehouse, farmsAndGreenhouses) work uniformly. */
function getEntryWarehouse(entry) {
	if (!entry) return "";
	return (entry.greenhouse || entry.block || "").toString().trim();
}

function applyFarmFilterToEntries(entries) {
	var list = Array.isArray(entries) ? entries : [];
	if (cropFilter) list = list.filter(function (e) { return getEntryCrop(e) === cropFilter; });
	if (farmFilter) list = list.filter(function (e) { return getFarmFromGreenhouseName(getEntryWarehouse(e)) === farmFilter; });
	return list;
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
	/* When a crop is selected, narrow to that crop's allow-list (Crop Scouted
	   farms[]). Strict filter: an unconfigured crop shows zero farms so the
	   user knows to populate the Crop Scouted record. The default Rose crop
	   keeps the full list when its allow-list hasn't loaded yet (init race),
	   otherwise the dropdown briefly empties on first paint. */
	if (cropFilter) {
		var allow = cropFarms[cropFilter];
		if (Array.isArray(allow)) {
			farms = farms.filter(function (f) { return allow.includes(f); });
		} else if (cropFilter !== DEFAULT_CROP) {
			/* Crop selected but allow-list not yet loaded → hide all farms
			   so we don't leak farms that may belong to other crops. */
			farms = [];
		}
	}
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
	/* If the previously-chosen farm is no longer allowed, clear the global
	   filter state too — otherwise the dashboard keeps applying it silently. */
	if (farmFilter && !farms.includes(farmFilter)) farmFilter = "";
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

function formatDateYmd(dateObj) {
	var y = dateObj.getUTCFullYear();
	var m = String(dateObj.getUTCMonth() + 1).padStart(2, "0");
	var d = String(dateObj.getUTCDate()).padStart(2, "0");
	return y + "-" + m + "-" + d;
}

/* Today's date in the user's local timezone as YYYY-MM-DD. Avoids the off-by-one
   you get from `new Date().toISOString()` when the browser is east of UTC. */
function localTodayYmd() {
	var d = new Date();
	var y = d.getFullYear();
	var m = String(d.getMonth() + 1).padStart(2, "0");
	var dd = String(d.getDate()).padStart(2, "0");
	return y + "-" + m + "-" + dd;
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

/* Build a {year, week, value} descriptor from a YYYY-MM-DD string.
   Returns null for invalid input so callers can fall back to today. */
function parseDateValue(dateStr) {
	if (!dateStr || typeof dateStr !== "string") return null;
	var match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!match) return null;
	var d = new Date(dateStr + "T00:00:00Z");
	if (Number.isNaN(d.getTime())) return null;
	var weekStr = getIsoWeekString(d);
	var wm = weekStr.match(/^(\d{4})-W(\d{2})$/);
	if (!wm) return null;
	return {
		year: Number(wm[1]),
		week: Number(wm[2]),
		value: weekStr,
		date: dateStr,
	};
}

function getSelectedWeekRangeInfo() {
	var fromValue = root_element.querySelector("#scout-week-from")?.value;
	var toValue = root_element.querySelector("#scout-week-to")?.value;
	var todayStr = localTodayYmd();
	var fromParsed = parseDateValue(fromValue) || parseDateValue(todayStr);
	var toParsed = parseDateValue(toValue) || parseDateValue(todayStr);
	if (!fromParsed || !toParsed) return null;
	/* Swap if user picked a from-date later than to-date so downstream date
	   math (cache months, axis range, year iteration) stays well-ordered. */
	if (fromParsed.date > toParsed.date) {
		var tmp = fromParsed; fromParsed = toParsed; toParsed = tmp;
	}
	return {
		from: fromParsed,
		to: toParsed,
		fromDate: fromParsed.date,
		toDate: toParsed.date,
	};
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

/* Build a unit-key for an entry/row. Greenhouses key on `zone`, blocks key
   on `tree`. Beds/rows are deliberately ignored: pest/disease pressure is
   defined as `affected zones-or-trees ÷ total zones-or-trees in scope`, so
   the numerator and denominator must use the same primitive. Entries with
   no zone/tree don't contribute to the percentage (they still appear in
   raw counts). */
function getDistributionBedKey(row) {
	if (!row) return "";
	var gh = row.greenhouse || "";
	var zone = row.zone || "";
	var block = row.block || "";
	var tree = row.tree || "";
	if (block && tree) return block + "::tree::" + tree;
	if (gh && zone) return gh + "::zone::" + zone;
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

/* List of warehouse names that fall inside the currently-selected scope.
   Used by the pressure denominator and the zones↔trees label switch.
   Precedence: explicit greenhouse > farm > crop's farms allow-list. */
function getScopedWarehouses() {
	if (greenhouseFilter) return [greenhouseFilter];
	var farms = [];
	if (farmFilter) {
		farms = [farmFilter];
	} else if (cropFilter && cropFarms[cropFilter] && cropFarms[cropFilter].length) {
		farms = cropFarms[cropFilter].slice();
	} else {
		farms = Object.keys(farmsAndGreenhouses || {});
	}
	var out = [];
	farms.forEach(function (f) {
		var list = (farmsAndGreenhouses && farmsAndGreenhouses[f]) || [];
		list.forEach(function (wh) { if (wh) out.push(wh); });
	});
	return Array.from(new Set(out));
}

/* Total units (zones + trees) across the active scope. Replaces the old
   per-entry zone tally so pest/disease pressure % is `affected ÷ total in
   selected scope`, even when entries don't cover every warehouse yet. */
function getScopedUnitTotal() {
	var whs = getScopedWarehouses();
	var total = 0;
	whs.forEach(function (wh) {
		var u = unitsPerWarehouse && unitsPerWarehouse[wh];
		if (u && Number.isFinite(Number(u.count))) total += Number(u.count);
		else if (zonesPerGreenhouse && zonesPerGreenhouse[wh]) total += Number(zonesPerGreenhouse[wh]) || 0;
	});
	return total;
}

/* Pick the right unit label for the current scope. Pure greenhouse →
   "Zone", pure block → "Tree", mixed/empty → generic "Unit". */
function getScopedUnitLabel(plural) {
	var whs = getScopedWarehouses();
	var hasGh = false, hasBlock = false;
	whs.forEach(function (wh) {
		var u = unitsPerWarehouse && unitsPerWarehouse[wh];
		if (!u) { hasGh = true; return; }
		if (u.type === "block") hasBlock = true;
		else hasGh = true;
	});
	var word = (hasGh && hasBlock) ? "Unit" : (hasBlock ? "Tree" : "Zone");
	return plural ? word + "s" : word;
}

/* Replace the static text inside a chart card's `.chart-subtitle` so the
   tab UI reflects the active scope's unit (zones/trees/units). The HTML
   ships placeholder copy for first paint; this re-runs every chart update. */
function _setChartCardSubtitle(chartId, text) {
	var host = root_element.querySelector("#" + chartId);
	if (!host) return;
	var card = host.closest(".chart-card");
	if (!card) return;
	var sub = card.querySelector(".chart-subtitle");
	if (sub) sub.textContent = text;
}

function getTotalZonesForGreenhouses(entries) {
	/* Pressure denominator: total units (zones for greenhouses, trees for
	   blocks) across the *selected scope* — crop+farm+greenhouse — not just
	   the warehouses that happen to appear in `entries`. Falls back to the
	   per-entry tally only when scope can't be resolved (e.g. before crop /
	   farm metadata loads), preserving the old behaviour for first paint. */
	var scoped = getScopedUnitTotal();
	if (scoped > 0) return scoped;
	var warehouses = Array.from(new Set((entries || []).map(function (e) {
		return getEntryWarehouse(e);
	}).filter(Boolean)));
	var total = 0;
	warehouses.forEach(function (wh) {
		var u = unitsPerWarehouse && unitsPerWarehouse[wh];
		if (u && Number.isFinite(Number(u.count))) total += Number(u.count);
		else total += Number(zonesPerGreenhouse[wh] || 0);
	});
	return total || getTotalBedsForDistribution(entries);
}

function toBedInfectionPercent(infectedCount, total) {
	if (!total) return 0;
	return Number(((infectedCount / total) * 100).toFixed(2));
}

/* Classify one observation against the active crop's severity bands.
   Returns "high" | "moderate" | "low" | null (null = below the Low threshold).
   `kind` is "pests" or "diseases"; `name` is the pest / disease name; `count`
   is the raw observation count; `warehouse` is the GH or block the entry
   belongs to (so Per-Hectare can divide by Warehouse.custom_area_ha).

   Falls back to the legacy >15 / >5 magnitude heuristic when no thresholds
   are configured for this crop+name combo, so historical data still buckets. */
function classifyObservationSeverity(kind, name, count, warehouse) {
	var n = Number(count) || 0;
	var crop = (cropFilter || DEFAULT_CROP);
	var entry = severityThresholds && severityThresholds[crop] && severityThresholds[crop][kind];
	var spec = entry && entry[name];
	if (!spec || (!spec.low && !spec.moderate && !spec.high)) {
		// Legacy fallback — keeps existing dashboards meaningful when an
		// admin hasn't yet populated the Crop Scouted thresholds.
		if (kind === "pests") {
			if (n > 15) return "high";
			if (n > 5)  return "moderate";
			return n > 0 ? "low" : null;
		}
		// Diseases legacy: pure presence counts, no count-based magnitude
		// heuristic — caller scans the disease's stage string instead, so
		// just signal "no threshold" here.
		return null;
	}
	var denom = 1;
	if ((spec.unit || "").toLowerCase() === "per hectare") {
		var u = unitsPerWarehouse && unitsPerWarehouse[warehouse];
		var ha = u && Number(u.area_ha);
		denom = (ha && ha > 0) ? ha : 1;
	}
	var v = n / denom;
	if (spec.high && v >= spec.high) return "high";
	if (spec.moderate && v >= spec.moderate) return "moderate";
	if (spec.low && v >= spec.low) return "low";
	return null;
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
				block: row?.block || "",
				row: row?.row || "",
				tree: row?.tree || "",
				crop_scouted: row?.crop_scouted || "",
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
			if (!ex.block && row?.block) ex.block = row.block;
			if (!ex.row && row?.row) ex.row = row.row;
			if (!ex.tree && row?.tree) ex.tree = row.tree;
			if (!ex.crop_scouted && row?.crop_scouted) ex.crop_scouted = row.crop_scouted;
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
	/* Canonical source: scouting_metrics_api.get_farms_and_warehouses returns
	   {farm: [warehouse_name, ...]} from the Warehouse doctype (active,
	   warehouse_type IN ('Greenhouse','Block')) so block-based farms (avocado
	   orchards) appear alongside greenhouse farms. Falls back to deriving
	   from Scouting Entry rows when the endpoint isn't available. */
	return callFrappe(
		"upande_scp.serverscripts.scouting_metrics_api.get_farms_and_warehouses",
		{}
	).then(function (r) {
		var map = r && r.message;
		if (!map || typeof map !== "object") throw new Error("empty farms/warehouses");
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
	/* Default range = last 30 days ending today. Replaced by a 30-day window
	   ending on the latest scouting date if the API call below succeeds. */
	function _applyMonthRange(toYmd) {
		var end = new Date(toYmd + "T00:00:00Z");
		if (!Number.isFinite(end.getTime())) return;
		var start = new Date(end);
		start.setUTCDate(end.getUTCDate() - 30);
		weekFromInput.value = formatDateYmd(start);
		weekToInput.value   = formatDateYmd(end);
	}
	_applyMonthRange(localTodayYmd());
	return callFrappe("frappe.client.get_list", {
		doctype: "Scouting Entry",
		fields: ["date_of_capture"],
		order_by: "date_of_capture desc",
		limit_page_length: 1,
	}).then(function (r) {
		var latest = r?.message?.[0]?.date_of_capture;
		if (latest) _applyMonthRange(String(latest));
	}).catch(function () { /* use defaults */ });
}


/* Load Crop Scouted records once on dashboard init. The records are also
   shipped (cached) inside every chunk's meta payload, but seeding the
   dropdown here means the Crop filter is usable before the first chunk
   arrives. Failure is silent — the filter just shows the default Rose. */
function loadCropOptions() {
	return callFrappe(
		"upande_scp.serverscripts.scouting_metrics_api.get_crops_with_farms",
		{}
	).then(function (r) {
		var rows = (r && r.message) || [];
		ingestCropsScouted(rows);
	}).catch(function () { /* silent — Rose default still works */ });
}

/* Apply a Crop Scouted list to the in-memory dropdown / allow-list maps.
   Called from both loadCropOptions (init) and the chunk meta payload. */
function ingestCropsScouted(rows) {
	if (!Array.isArray(rows)) return;
	cropsScouted = rows;
	cropFarms = {};
	rows.forEach(function (c) {
		if (!c || !c.crop_name) return;
		cropFarms[c.crop_name] = Array.isArray(c.farms) ? c.farms : [];
	});
	/* Make sure the default crop ("Rose") is always selectable, even when
	   the Crop Scouted list omits it (e.g. fresh install before seeding). */
	var hasDefault = rows.some(function (c) { return c && c.crop_name === DEFAULT_CROP; });
	if (!hasDefault) cropsScouted = [{ name: DEFAULT_CROP, crop_name: DEFAULT_CROP, farms: [] }].concat(rows);
	renderCropOptions();
	/* Crops may finish loading after greenhouses (init race). Re-narrow the
	   Farm dropdown now that allow-lists are known so the active crop's
	   filter takes effect on first paint, not just after a manual change. */
	renderFarmOptions();
	renderGreenhouseOptionsForFarm();
}

function renderCropOptions() {
	var select = root_element.querySelector("#scout-crop-filter");
	if (!select) return;
	var existing = cropFilter || DEFAULT_CROP;
	select.innerHTML = "";
	cropsScouted.forEach(function (c) {
		var name = c.crop_name || c.name;
		if (!name) return;
		var opt = document.createElement("option");
		opt.value = name;
		opt.textContent = name;
		select.appendChild(opt);
	});
	if ([...select.options].some(function (o) { return o.value === existing; })) {
		select.value = existing;
	} else if (select.options.length) {
		select.value = select.options[0].value;
		cropFilter = select.value;
	}
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
		/* `warehouseName` is the unified bucket key — block name for orchard
		   scouting, greenhouse name for greenhouse scouting. Downstream charts
		   key off this, which is also what `unitsPerWarehouse` is keyed by. */
		var warehouseName = getEntryWarehouse(entry);
		var greenhouse = warehouseName;
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

		/* Common location payload copied onto each child observation so
		   getDistributionBedKey can reconstruct the unit-key (zone or tree)
		   without back-references to the parent entry. */
		var locMeta = {
			greenhouse: entry.greenhouse || "",
			bed: entry.bed || "",
			zone: entry.zone || "",
			block: entry.block || "",
			row: entry.row || "",
			tree: entry.tree || "",
		};

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
				data.pests[name].counts.push(Object.assign({
					date: date, count: count, stage: stage, section: p.plant_section,
				}, locMeta));
				data.pests[name].stages[stage] = (data.pests[name].stages[stage] || 0) + count;
				if (p.plant_section)
					data.pests[name].sections[p.plant_section] = (data.pests[name].sections[p.plant_section] || 0) + count;
				/* Per-crop band classification (Crop Scouted thresholds). Falls
				   back to the legacy magnitude heuristic when no thresholds
				   are configured for this pest. Sub-Low observations are
				   still bucketed as "low" so the matrix shows them. */
				var sev = classifyObservationSeverity("pests", name, count, warehouseName);
				if (sev === "high") data.pests[name].severity.high++;
				else if (sev === "moderate") data.pests[name].severity.moderate++;
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
				data.diseases[name].counts.push(Object.assign({
					date: date, stage: stage, section: d.plant_section,
				}, locMeta));
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
				data.traps[key].counts.push(Object.assign({
					date: date, count: cnt, location: loc,
				}, locMeta));
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

	/* Disease severity reclassification.
	   Disease entries don't carry a count field — each row is one incident —
	   so per-row magnitude classification is meaningless. Instead, when the
	   active crop has thresholds configured for a disease, aggregate
	   incidents per warehouse and bucket each warehouse's total against the
	   bands. We override the legacy keyword-scan severity only for diseases
	   that actually have thresholds, so historical data without config keeps
	   the old classification. */
	var crop = (cropFilter || DEFAULT_CROP);
	var diseaseSpecs = severityThresholds && severityThresholds[crop] && severityThresholds[crop].diseases;
	if (diseaseSpecs) {
		Object.keys(data.diseases).forEach(function (name) {
			var spec = diseaseSpecs[name];
			if (!spec || (!spec.low && !spec.moderate && !spec.high)) return;
			var perWh = {};
			(data.diseases[name].counts || []).forEach(function (c) {
				var wh = (c.block || c.greenhouse || "Unknown").trim();
				perWh[wh] = (perWh[wh] || 0) + 1;
			});
			var sev = { low: 0, moderate: 0, high: 0 };
			Object.keys(perWh).forEach(function (wh) {
				var bucket = classifyObservationSeverity("diseases", name, perWh[wh], wh);
				if (bucket === "high") sev.high++;
				else if (bucket === "moderate") sev.moderate++;
				else if (bucket === "low") sev.low++;
			});
			data.diseases[name].severity = sev;
		});
	}
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
	var cropSelect = root_element.querySelector("#scout-crop-filter");

	if (!weekFromInput || !weekToInput || !greenhouseSelect || !farmSelect) {
		if (SCOUTING_DASHBOARD_DEBUG)
			console.error("Scouting dashboard: missing required DOM elements");
		return;
	}

	Promise.all([
		loadGreenhouseOptions(),
		loadCropOptions(),
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

	if (cropSelect) {
		cropSelect.addEventListener("change", function (e) {
			cropFilter = e.target.value || DEFAULT_CROP;
			/* Crop change resets farm/greenhouse selection: the chosen farm
			   may not exist in the new crop's allow-list, and the greenhouse
			   denominator depends on farm + crop scope. */
			farmFilter = "";
			greenhouseFilter = "";
			renderFarmOptions();
			renderGreenhouseOptionsForFarm();
			updateGreenhouseSelectState();
			debouncedRefresh();
		});
	}
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

/* Sentinel that flags "merge this dimension into a single deduplicated series".
   Distinct from "" (which historically means "All", and on the Section/Stage
   dropdowns actually splits the chart into per-section/per-stage lines). */
var CUMULATIVE_VALUE = "__cumulative__";
var CUMULATIVE_LABEL = "Cumulative (combine all)";

/* Apply Cumulative as the initial default the first time a section/stage
   dropdown is populated. Subsequent paints preserve whatever the user picked.
   MUST be called *after* setSelectOptions, so the option exists when we
   assign .value (otherwise the assignment is silently dropped). */
function _seedCumulativeDefault(selectEl) {
	if (!selectEl) return;
	if (selectEl.dataset.cumDefaultApplied) return;
	var hasCumulative = Array.prototype.some.call(selectEl.options, function (o) {
		return o.value === CUMULATIVE_VALUE;
	});
	if (!hasCumulative) return;
	selectEl.dataset.cumDefaultApplied = "1";
	selectEl.value = CUMULATIVE_VALUE;
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
			[
				{ value: "", label: "All Stages" },
				{ value: CUMULATIVE_VALUE, label: CUMULATIVE_LABEL },
			].concat(
				Array.from(stages).sort().map(function (s) { return { value: s, label: s }; })
			)
		);
		_seedCumulativeDefault(stageSel);
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
			[
				{ value: "", label: "All Stages" },
				{ value: CUMULATIVE_VALUE, label: CUMULATIVE_LABEL },
			].concat(
				Array.from(stages).sort().map(function (s) { return { value: s, label: s }; })
			)
		);
		_seedCumulativeDefault(stageSel);
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
	unitsPerWarehouse = metaCache.units_by_greenhouse || {};
	severityThresholds = metaCache.severity_thresholds || {};
	if (Array.isArray(metaCache.crops_scouted) && metaCache.crops_scouted.length) {
		ingestCropsScouted(metaCache.crops_scouted);
	}

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
							units_by_greenhouse: res.units_by_greenhouse || {},
							crops_scouted: res.crops_scouted || [],
							severity_thresholds: res.severity_thresholds || {},
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
				name: "Zones",
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
		subtitle: "Daily zones per scout (top 5) · ISO-week ticks",
	});
}

function _updateScoutPerfBar(scouts) {
	if (!scouts.length) return;
	var labels = scouts.map(function (s) { return s.name; });

	function builder(compact) {
		var base = _echartsBase(compact);
		return Object.assign(base, {
			color: ["#3b82f6", "#10b981", "#f59e0b"],
			legend: Object.assign({}, base.legend, { data: ["Zones", "Pest Obs", "Disease Obs"] }),
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
			series: ["Zones", "Pest Obs", "Disease Obs"].map(function (name, i) {
				var key = name === "Zones" ? "entries" : (name === "Pest Obs" ? "pests" : "diseases");
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
		title: "Zones & Observations",
		subtitle: "Per scout · zones, pests, diseases",
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
	var labels = ["Zones", "Pest Obs", "Disease Obs", "Trap Obs", "Avg/Day"];
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
						+ '<div>' + formatNumber(p.value) + ' zones  ·  ' + p.percent.toFixed(1) + '%</div>';
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
					formatter: function () { return "{a|" + formatNumber(total) + "}\n{b|Zones}"; },
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
			return '<div class="item-row"><div class="item-rank ' + cls + '">' + (i + 1) + '</div><div class="item-info"><div class="item-name">' + (s.name || "Unknown") + '</div><div class="item-meta">' + s.entries + ' zones</div></div></div>';
		}).join("");
}

function updateRecentEntries() {
	var container = root_element.querySelector("#overview-recent-entries");
	if (!container) return;
	var entries = scoutingData.entries.slice(0, 10);
	container.innerHTML = entries.length === 0
		? '<div class="empty-state">No recent zone activity</div>'
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
	if (!scoutingData) return;
	var dates      = Object.keys(scoutingData.daily).sort();
	if (!dates.length) return;
	var totalBeds  = getTotalZonesForGreenhouses(scoutingData.entries);
	var stageRaw   = root_element.querySelector("#pest-weekly-stage-filter")?.value || "";
	var stageVal   = (stageRaw === CUMULATIVE_VALUE ? "" : stageRaw).trim().toLowerCase();
	var fullDailyMap = buildDailyBedInfectionMap(scoutingData.entries, "pests");
	var includeYear = new Set(dates.map(function (d) { return d.slice(0, 4); })).size > 1;
	var unitWordPlural = getScopedUnitLabel(true);

	var chartData = dates.map(function (d) {
		if (!stageVal) return toBedInfectionPercent(fullDailyMap[d]?.size || 0, totalBeds);
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

	function builder(compact) {
		var base = _echartsBase(compact);
		return Object.assign(base, {
			color: ["#10b981"],
			legend: Object.assign({}, base.legend, { show: false }),
			tooltip: Object.assign({}, base.tooltip, {
				trigger: "axis",
				axisPointer: { type: "line", lineStyle: { color: "rgba(13,43,94,0.35)" } },
				formatter: function (params) {
					if (!params || !params.length) return "";
					var p = params[0];
					return '<div style="font-weight:600;margin-bottom:2px;">' + dates[p.dataIndex] + '</div>'
						+ '<div>' + p.marker + unitWordPlural + ' Affected: <b>' + Number(p.value).toFixed(1) + '%</b></div>';
				},
			}),
			xAxis: {
				type: "category", boundaryGap: false, data: dates,
				axisLine: { lineStyle: { color: "rgba(0,0,0,0.15)" } },
				axisTick: { show: false },
				axisLabel: {
					interval: 0, color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, hideOverlap: true,
					formatter: _isoWeekAxisFormatter(dates, includeYear),
				},
			},
			yAxis: {
				type: "value", min: 0,
				splitLine: { lineStyle: { color: "rgba(0,0,0,0.06)", type: "dashed" } },
				axisLine: { show: false }, axisTick: { show: false },
				axisLabel: { color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, formatter: function (v) { return v.toFixed(1) + "%"; } },
			},
			series: [{
				name: unitWordPlural + " Affected (%)",
				type: "line", smooth: false,
				symbol: "circle", symbolSize: compact ? 4 : 6, showSymbol: true, sampling: "lttb",
				lineStyle: { width: compact ? 2 : 2.5 },
				areaStyle: { opacity: 0.18 },
				emphasis: { disabled: true },
				data: chartData,
			}],
		});
	}

	_setChartCardSubtitle("pest-trend-chart", unitWordPlural.toLowerCase() + " affected daily · click to zoom");
	renderEChart("pest-trend-chart", builder, {
		title: "Pest Incidence Trend",
		subtitle: unitWordPlural + " affected daily",
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
		[
			{ value: "", label: "All Sections" },
			{ value: CUMULATIVE_VALUE, label: CUMULATIVE_LABEL },
		].concat(
			Array.from(secs).sort().map(function (s) { return { value: s, label: s }; })
		)
	);
	_seedCumulativeDefault(secSel);

	/* Stage options depend on which pest is selected */
	rebuildPestStageOptions();

	updatePestWeeklyTrendChart();
	updatePestStageRadialChart();
}

function updatePestWeeklyTrendChart() {
	if (!scoutingData) return;
	var rangeInfo = getSelectedWeekRangeInfo();
	if (!rangeInfo) return;
	var axis = getDayRangeAxis(rangeInfo);
	if (!axis) return;

	var dayIndex = {};
	axis.keys.forEach(function (k, i) { dayIndex[k] = i; });

	var pestName    = root_element.querySelector("#pest-weekly-pest-filter")?.value    || "";
	var sectionRaw  = root_element.querySelector("#pest-weekly-section-filter")?.value || "";
	var stageEl     = root_element.querySelector("#pest-weekly-stage-filter");
	var stageRaw    = stageEl?.value || "";
	/* Disabled stage dropdown (no pest selected) → treat as cumulative so the
	   chart shows one line per pest instead of splitting by stage. */
	var stageDisabled     = !!stageEl?.disabled;
	var sectionCumulative = sectionRaw === CUMULATIVE_VALUE;
	var stageCumulative   = stageRaw === CUMULATIVE_VALUE || stageDisabled;
	var section = sectionCumulative ? "" : sectionRaw;
	var stage   = stageCumulative   ? "" : stageRaw;
	/* "All X" (empty) splits per X; "Cumulative" or a specific value collapses to one bucket. */
	var splitBySection = !section && !sectionCumulative;
	var splitByStage   = !stage   && !stageCumulative;
	var totalBeds = getTotalZonesForGreenhouses(scoutingData.entries);

	var pestList = pestName ? [pestName] : Object.keys(scoutingData.pests || {}).sort();
	var allCounts = pestList.reduce(function (acc, p) {
		return acc.concat(scoutingData.pests?.[p]?.counts || []);
	}, []);

	function _buckets(splitFlag, fixedVal, key) {
		if (splitFlag) {
			var vals = Array.from(new Set(allCounts.map(function (c) { return c[key] || ""; }).filter(Boolean))).sort();
			return vals.length ? vals : [null];
		}
		return fixedVal ? [fixedVal] : [null];
	}
	var sectionBuckets = _buckets(splitBySection, section, "section");
	var stageBuckets   = _buckets(splitByStage,   stage,   "stage");

	/* When no pest is selected and we're splitting on either dimension,
	   aggregate all pests into per-bucket lines (matches existing
	   "All Pests + All Sections" behaviour, now extended to stages). */
	var aggregatePests = !pestName && (splitBySection || splitByStage);

	var seriesDefs = [];
	var seriesIdx = 0;

	sectionBuckets.forEach(function (secVal) {
		stageBuckets.forEach(function (stgVal) {
			var includeFn = function (c) {
				if (secVal !== null && c.section !== secVal) return false;
				if (stgVal !== null && (c.stage || "") !== stgVal) return false;
				return true;
			};

			if (aggregatePests) {
				var d = buildDailyBedInfectionSeries(allCounts, axis, dayIndex, totalBeds, includeFn);
				if (!d.some(function (v) { return v > 0; })) return;
				var palA = getPaletteColor(seriesIdx++);
				var partsA = [];
				if (secVal !== null) partsA.push(secVal);
				if (stgVal !== null) partsA.push(stgVal);
				seriesDefs.push({ name: partsA.join(" · ") || "All", color: palA.border, data: d });
				return;
			}

			pestList.forEach(function (p) {
				var d = buildDailyBedInfectionSeries(scoutingData.pests?.[p]?.counts || [], axis, dayIndex, totalBeds, includeFn);
				if (!d.some(function (v) { return v > 0; })) return;
				var palP = getPaletteColor(seriesIdx++);
				var color = (sectionBuckets.length === 1 && stageBuckets.length === 1)
					? (observationColors.pests[p] || palP.border)
					: palP.border;
				var name = p;
				if (secVal !== null && splitBySection)        name += " – " + secVal;
				else if (secVal !== null && !splitBySection)  name += " (" + secVal + ")";
				else if (sectionCumulative)                   name += " (all sections)";
				if (stgVal !== null && splitByStage)          name += " · " + stgVal;
				else if (stgVal !== null && !splitByStage)    name += " [" + stgVal + "]";
				else if (stageCumulative)                     name += " [all stages]";
				seriesDefs.push({ name: name, color: color, data: d });
			});
		});
	});

	var unitWordPlural = getScopedUnitLabel(true);
	var subtitleText = unitWordPlural + " affected (%) · daily data points";
	var splitDims = [];
	if (splitBySection) splitDims.push("section");
	if (splitByStage)   splitDims.push("stage");
	if (splitDims.length) subtitleText += " · split by " + splitDims.join(" & ");
	var cumDims = [];
	if (sectionCumulative) cumDims.push("sections");
	if (stageCumulative)   cumDims.push("stages");
	if (cumDims.length) {
		subtitleText += " · cumulative across " + cumDims.join(" & ") + " (deduped " + unitWordPlural.toLowerCase() + ")";
	}
	if (!seriesDefs.length) {
		seriesDefs.push({ name: unitWordPlural + " Affected (%)", color: "#10b981", data: new Array(axis.keys.length).fill(0) });
	}

	function builder(compact) {
		var base = _echartsBase(compact);
		var includeYear = new Set(axis.keys.map(function (k) { return k.slice(0, 4); })).size > 1;
		return Object.assign(base, {
			color: seriesDefs.map(function (s) { return s.color; }),
			legend: Object.assign({}, base.legend, { show: seriesDefs.length > 1, data: seriesDefs.map(function (s) { return s.name; }) }),
			tooltip: Object.assign({}, base.tooltip, {
				trigger: "axis",
				axisPointer: { type: "line", lineStyle: { color: "rgba(13,43,94,0.35)" } },
				formatter: function (params) {
					if (!params || !params.length) return "";
					var idx = params[0].dataIndex;
					var rows = params.map(function (p) {
						return '<div style="display:flex;justify-content:space-between;gap:14px;font-size:12px;">'
							+ '<span>' + p.marker + p.seriesName + '</span>'
							+ '<span style="font-weight:600;">' + Number(p.value).toFixed(1) + '%</span></div>';
					}).join("");
					return '<div style="font-weight:600;margin-bottom:6px;">' + axis.keys[idx] + '</div>' + rows;
				},
			}),
			xAxis: {
				type: "category", boundaryGap: false, data: axis.keys,
				axisLine: { lineStyle: { color: "rgba(0,0,0,0.15)" } },
				axisTick: { show: false },
				axisLabel: {
					interval: 0, color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, hideOverlap: true,
					formatter: _isoWeekAxisFormatter(axis.keys, includeYear),
				},
			},
			yAxis: {
				type: "value", min: 0,
				splitLine: { lineStyle: { color: "rgba(0,0,0,0.06)", type: "dashed" } },
				axisLine: { show: false }, axisTick: { show: false },
				axisLabel: { color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, formatter: function (v) { return v.toFixed(1) + "%"; } },
			},
			series: seriesDefs.map(function (s) {
				return {
					name: s.name, type: "line", smooth: false,
					symbol: "circle", symbolSize: compact ? 4 : 6, showSymbol: true, sampling: "lttb",
					lineStyle: { width: compact ? 2 : 2.5 },
					emphasis: { disabled: true },
					data: s.data,
				};
			}),
		});
	}

	_setChartCardSubtitle("pest-weekly-trend-chart", subtitleText + " · click to zoom");
	renderEChart("pest-weekly-trend-chart", builder, {
		title: "Pest Trends",
		subtitle: subtitleText,
	});
}

function updatePestDistributionChart() {
	if (!scoutingData) return;
	var pests     = scoutingData.pests;
	var labels    = Object.keys(pests).slice(0, 10);
	if (!labels.length) return;
	var totalBeds = getTotalZonesForGreenhouses(scoutingData.entries);
	var palette   = ["#10b981","#3b82f6","#f59e0b","#8b5cf6","#ef4444","#ec4899","#14b8a6","#f97316","#6366f1","#06b6d4"];

	var data = labels.map(function (p, i) {
		var beds = new Set();
		(pests[p].counts || []).forEach(function (c) {
			var k = getDistributionBedKey(c);
			if (k) beds.add(k);
		});
		var pct = totalBeds ? Number(((beds.size / totalBeds) * 100).toFixed(2)) : 0;
		return { value: pct, name: p, itemStyle: { color: observationColors.pests[p] || palette[i % palette.length], borderRadius: [6, 6, 0, 0] } };
	});

	var unitWordPlural = getScopedUnitLabel(true);
	function builder(compact) {
		var base = _echartsBase(compact);
		return Object.assign(base, {
			legend: Object.assign({}, base.legend, { show: false }),
			tooltip: Object.assign({}, base.tooltip, {
				trigger: "item",
				formatter: function (p) {
					return '<div style="font-weight:600;margin-bottom:2px;">' + p.marker + p.name + '</div>'
						+ '<div>' + unitWordPlural + ' Affected: <b>' + Number(p.value).toFixed(2) + '%</b></div>';
				},
			}),
			grid: { left: 40, right: 16, top: 16, bottom: compact ? 56 : 76, containLabel: false },
			xAxis: {
				type: "category", data: labels,
				axisLine: { show: false }, axisTick: { show: false },
				axisLabel: { color: "#64748b", fontSize: 10, fontFamily: SD_FONT_FAMILY, rotate: -25, hideOverlap: true },
			},
			yAxis: {
				type: "value", min: 0,
				splitLine: { lineStyle: { color: "rgba(0,0,0,0.06)", type: "dashed" } },
				axisLine: { show: false }, axisTick: { show: false },
				axisLabel: { color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, formatter: function (v) { return v + "%"; } },
			},
			series: [{
				type: "bar", barMaxWidth: compact ? 28 : 40,
				itemStyle: { borderRadius: [6, 6, 0, 0] },
				label: {
					show: !compact, position: "top", color: "#334155", fontSize: 10, fontFamily: SD_FONT_FAMILY, fontWeight: 600,
					formatter: function (p) { return Number(p.value).toFixed(1) + "%"; },
				},
				emphasis: { disabled: true },
				data: data,
			}],
		});
	}

	_setChartCardSubtitle("pest-distribution-chart", unitWordPlural + " affected by pest type · click to zoom");
	renderEChart("pest-distribution-chart", builder, {
		title: "Pest Distribution",
		subtitle: unitWordPlural + " affected by pest type",
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
	if (!scoutingData) return;
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
	var labels = Object.keys(sections);
	if (!labels.length) return;
	var values = labels.map(function (l) { return sections[l]; });

	function builder(compact) {
		var base = _echartsBase(compact);
		return Object.assign(base, {
			color: ["#10b981","#3b82f6","#f59e0b","#8b5cf6","#ef4444","#ec4899","#14b8a6","#f97316"],
			legend: Object.assign({}, base.legend, { data: labels }),
			tooltip: Object.assign({}, base.tooltip, {
				trigger: "item",
				formatter: function (p) {
					return '<div style="font-weight:600;margin-bottom:2px;">' + p.marker + p.name + '</div>'
						+ '<div>' + formatNumber(p.value) + '  ·  ' + p.percent.toFixed(1) + '%</div>';
				},
			}),
			grid: undefined,
			series: [{
				type: "pie",
				radius: compact ? ["60%", "82%"] : ["55%", "78%"],
				center: ["50%", "46%"],
				avoidLabelOverlap: true,
				itemStyle: { borderColor: "#fff", borderWidth: 2 },
				label: { show: false },
				labelLine: { show: false },
				emphasis: { disabled: true },
				data: labels.map(function (l, i) { return { name: l, value: values[i] }; }),
			}],
		});
	}

	renderEChart("pest-section-chart", builder, {
		title: "Plant Section Split",
		subtitle: pestName ? pestName + " · sections" : "Where pests are found",
	});
}
 
function updatePestStageRadialChart() {
	if (!scoutingData) return;
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
	if (!labels.length) return;
	var palette = ["#10b981","#3b82f6","#f59e0b","#8b5cf6","#ef4444","#ec4899","#14b8a6","#f97316"];
	var total = labels.reduce(function (a, l) { return a + stageCounts[l]; }, 0) || 1;

	function builder(compact) {
		var base = _echartsBase(compact);
		return Object.assign(base, {
			legend: Object.assign({}, base.legend, { show: false }),
			tooltip: Object.assign({}, base.tooltip, {
				trigger: "item",
				formatter: function (p) {
					var pct = ((p.value / total) * 100).toFixed(1);
					return '<div style="font-weight:600;margin-bottom:2px;">' + p.marker + p.name + '</div>'
						+ '<div>' + formatNumber(p.value) + '  ·  ' + pct + '%</div>';
				},
			}),
			grid: { left: 40, right: 16, top: 16, bottom: compact ? 56 : 76, containLabel: false },
			xAxis: {
				type: "category", data: labels,
				axisLine: { show: false }, axisTick: { show: false },
				axisLabel: { color: "#64748b", fontSize: 10, fontFamily: SD_FONT_FAMILY, rotate: -25, hideOverlap: true },
			},
			yAxis: {
				type: "value", min: 0,
				splitLine: { lineStyle: { color: "rgba(0,0,0,0.06)", type: "dashed" } },
				axisLine: { show: false }, axisTick: { show: false },
				axisLabel: { color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, formatter: function (v) { return Math.round(v); } },
			},
			series: [{
				type: "bar", barMaxWidth: compact ? 28 : 40,
				itemStyle: { borderRadius: [6, 6, 0, 0] },
				emphasis: { disabled: true },
				data: labels.map(function (l, i) { return { name: l, value: stageCounts[l], itemStyle: { color: palette[i % palette.length], borderRadius: [6, 6, 0, 0] } }; }),
			}],
		});
	}

	renderEChart("pest-stage-radial-chart", builder, {
		title: "Zones by Stage",
		subtitle: pestName ? pestName : "All pests",
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
	if (!scoutingData) return;
	var dates     = Object.keys(scoutingData.daily).sort();
	if (!dates.length) return;
	var totalBeds = getTotalZonesForGreenhouses(scoutingData.entries);
	var stageRaw  = root_element.querySelector("#disease-weekly-stage-filter")?.value || "";
	var stageVal  = (stageRaw === CUMULATIVE_VALUE ? "" : stageRaw).trim().toLowerCase();
	var fullDailyMap = buildDailyBedInfectionMap(scoutingData.entries, "diseases");
	var includeYear = new Set(dates.map(function (d) { return d.slice(0, 4); })).size > 1;
	var unitWordPlural = getScopedUnitLabel(true);

	var chartData = dates.map(function (d) {
		if (!stageVal) return toBedInfectionPercent(fullDailyMap[d]?.size || 0, totalBeds);
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

	function builder(compact) {
		var base = _echartsBase(compact);
		return Object.assign(base, {
			color: ["#f59e0b"],
			legend: Object.assign({}, base.legend, { show: false }),
			tooltip: Object.assign({}, base.tooltip, {
				trigger: "axis",
				axisPointer: { type: "line", lineStyle: { color: "rgba(13,43,94,0.35)" } },
				formatter: function (params) {
					if (!params || !params.length) return "";
					var p = params[0];
					return '<div style="font-weight:600;margin-bottom:2px;">' + dates[p.dataIndex] + '</div>'
						+ '<div>' + p.marker + unitWordPlural + ' Affected: <b>' + Number(p.value).toFixed(1) + '%</b></div>';
				},
			}),
			xAxis: {
				type: "category", boundaryGap: false, data: dates,
				axisLine: { lineStyle: { color: "rgba(0,0,0,0.15)" } },
				axisTick: { show: false },
				axisLabel: {
					interval: 0, color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, hideOverlap: true,
					formatter: _isoWeekAxisFormatter(dates, includeYear),
				},
			},
			yAxis: {
				type: "value", min: 0,
				splitLine: { lineStyle: { color: "rgba(0,0,0,0.06)", type: "dashed" } },
				axisLine: { show: false }, axisTick: { show: false },
				axisLabel: { color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, formatter: function (v) { return v.toFixed(1) + "%"; } },
			},
			series: [{
				name: unitWordPlural + " Affected (%)",
				type: "line", smooth: false,
				symbol: "circle", symbolSize: compact ? 4 : 6, showSymbol: true, sampling: "lttb",
				lineStyle: { width: compact ? 2 : 2.5 },
				areaStyle: { opacity: 0.18 },
				emphasis: { disabled: true },
				data: chartData,
			}],
		});
	}

	_setChartCardSubtitle("disease-trend-chart", unitWordPlural.toLowerCase() + " affected daily · click to zoom");
	renderEChart("disease-trend-chart", builder, {
		title: "Disease Incidence Trend",
		subtitle: unitWordPlural + " affected daily",
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
		[
			{ value: "", label: "All Sections" },
			{ value: CUMULATIVE_VALUE, label: CUMULATIVE_LABEL },
		].concat(
			Array.from(secs).sort().map(function (s) { return { value: s, label: s }; })
		)
	);
	_seedCumulativeDefault(secSel);

	/* Stage options depend on which disease is selected */
	rebuildDiseaseStageOptions();

	updateDiseaseWeeklyTrendChart();
	updateDiseaseStageRadialChart();
}

function updateDiseaseWeeklyTrendChart() {
	if (!scoutingData) return;
	var rangeInfo = getSelectedWeekRangeInfo();
	if (!rangeInfo) return;
	var axis = getDayRangeAxis(rangeInfo);
	if (!axis) return;

	var dayIndex = {};
	axis.keys.forEach(function (k, i) { dayIndex[k] = i; });

	var diseaseName = root_element.querySelector("#disease-weekly-disease-filter")?.value || "";
	var sectionRaw  = root_element.querySelector("#disease-weekly-section-filter")?.value || "";
	var stageEl     = root_element.querySelector("#disease-weekly-stage-filter");
	var stageRaw    = stageEl?.value || "";
	/* Disabled stage dropdown (no disease selected) → treat as cumulative. */
	var stageDisabled     = !!stageEl?.disabled;
	var sectionCumulative = sectionRaw === CUMULATIVE_VALUE;
	var stageCumulative   = stageRaw === CUMULATIVE_VALUE || stageDisabled;
	var section = sectionCumulative ? "" : sectionRaw;
	var stage   = stageCumulative   ? "" : stageRaw;
	var splitBySection = !section && !sectionCumulative;
	var splitByStage   = !stage   && !stageCumulative;
	var totalBeds = getTotalZonesForGreenhouses(scoutingData.entries);

	var diseaseList = diseaseName ? [diseaseName] : Object.keys(scoutingData.diseases || {}).sort();
	var allCounts = diseaseList.reduce(function (acc, dn) {
		return acc.concat(scoutingData.diseases?.[dn]?.counts || []);
	}, []);

	function _buckets(splitFlag, fixedVal, key) {
		if (splitFlag) {
			var vals = Array.from(new Set(allCounts.map(function (c) { return c[key] || ""; }).filter(Boolean))).sort();
			return vals.length ? vals : [null];
		}
		return fixedVal ? [fixedVal] : [null];
	}
	var sectionBuckets = _buckets(splitBySection, section, "section");
	var stageBuckets   = _buckets(splitByStage,   stage,   "stage");

	var aggregateDiseases = !diseaseName && (splitBySection || splitByStage);

	var seriesDefs = [];
	var seriesIdx = 0;

	sectionBuckets.forEach(function (secVal) {
		stageBuckets.forEach(function (stgVal) {
			var includeFn = function (c) {
				if (secVal !== null && c.section !== secVal) return false;
				if (stgVal !== null && (c.stage || "") !== stgVal) return false;
				return true;
			};

			if (aggregateDiseases) {
				var d = buildDailyBedInfectionSeries(allCounts, axis, dayIndex, totalBeds, includeFn);
				if (!d.some(function (v) { return v > 0; })) return;
				var palA = getPaletteColor(seriesIdx++);
				var partsA = [];
				if (secVal !== null) partsA.push(secVal);
				if (stgVal !== null) partsA.push(stgVal);
				seriesDefs.push({ name: partsA.join(" · ") || "All", color: palA.border, data: d });
				return;
			}

			diseaseList.forEach(function (dn) {
				var d = buildDailyBedInfectionSeries(scoutingData.diseases?.[dn]?.counts || [], axis, dayIndex, totalBeds, includeFn);
				if (!d.some(function (v) { return v > 0; })) return;
				var palD = getPaletteColor(seriesIdx++);
				var color = (sectionBuckets.length === 1 && stageBuckets.length === 1)
					? (observationColors.diseases[dn] || palD.border)
					: palD.border;
				var name = dn;
				if (secVal !== null && splitBySection)        name += " – " + secVal;
				else if (secVal !== null && !splitBySection)  name += " (" + secVal + ")";
				else if (sectionCumulative)                   name += " (all sections)";
				if (stgVal !== null && splitByStage)          name += " · " + stgVal;
				else if (stgVal !== null && !splitByStage)    name += " [" + stgVal + "]";
				else if (stageCumulative)                     name += " [all stages]";
				seriesDefs.push({ name: name, color: color, data: d });
			});
		});
	});

	var unitWordPlural = getScopedUnitLabel(true);
	var subtitleText = unitWordPlural + " affected (%) · daily data points";
	var splitDims = [];
	if (splitBySection) splitDims.push("section");
	if (splitByStage)   splitDims.push("stage");
	if (splitDims.length) subtitleText += " · split by " + splitDims.join(" & ");
	var cumDims = [];
	if (sectionCumulative) cumDims.push("sections");
	if (stageCumulative)   cumDims.push("stages");
	if (cumDims.length) {
		subtitleText += " · cumulative across " + cumDims.join(" & ") + " (deduped " + unitWordPlural.toLowerCase() + ")";
	}
	if (!seriesDefs.length) {
		seriesDefs.push({ name: unitWordPlural + " Affected (%)", color: "#f59e0b", data: new Array(axis.keys.length).fill(0) });
	}

	function builder(compact) {
		var base = _echartsBase(compact);
		var includeYear = new Set(axis.keys.map(function (k) { return k.slice(0, 4); })).size > 1;
		return Object.assign(base, {
			color: seriesDefs.map(function (s) { return s.color; }),
			legend: Object.assign({}, base.legend, { show: seriesDefs.length > 1, data: seriesDefs.map(function (s) { return s.name; }) }),
			tooltip: Object.assign({}, base.tooltip, {
				trigger: "axis",
				axisPointer: { type: "line", lineStyle: { color: "rgba(13,43,94,0.35)" } },
				formatter: function (params) {
					if (!params || !params.length) return "";
					var idx = params[0].dataIndex;
					var rows = params.map(function (p) {
						return '<div style="display:flex;justify-content:space-between;gap:14px;font-size:12px;">'
							+ '<span>' + p.marker + p.seriesName + '</span>'
							+ '<span style="font-weight:600;">' + Number(p.value).toFixed(1) + '%</span></div>';
					}).join("");
					return '<div style="font-weight:600;margin-bottom:6px;">' + axis.keys[idx] + '</div>' + rows;
				},
			}),
			xAxis: {
				type: "category", boundaryGap: false, data: axis.keys,
				axisLine: { lineStyle: { color: "rgba(0,0,0,0.15)" } },
				axisTick: { show: false },
				axisLabel: {
					interval: 0, color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, hideOverlap: true,
					formatter: _isoWeekAxisFormatter(axis.keys, includeYear),
				},
			},
			yAxis: {
				type: "value", min: 0,
				splitLine: { lineStyle: { color: "rgba(0,0,0,0.06)", type: "dashed" } },
				axisLine: { show: false }, axisTick: { show: false },
				axisLabel: { color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, formatter: function (v) { return v.toFixed(1) + "%"; } },
			},
			series: seriesDefs.map(function (s) {
				return {
					name: s.name, type: "line", smooth: false,
					symbol: "circle", symbolSize: compact ? 4 : 6, showSymbol: true, sampling: "lttb",
					lineStyle: { width: compact ? 2 : 2.5 },
					emphasis: { disabled: true },
					data: s.data,
				};
			}),
		});
	}

	_setChartCardSubtitle("disease-weekly-trend-chart", subtitleText + " · click to zoom");
	renderEChart("disease-weekly-trend-chart", builder, {
		title: "Disease Trends",
		subtitle: subtitleText,
	});
}


function updateDiseaseDistributionChart() {
	if (!scoutingData) return;
	var diseases  = scoutingData.diseases;
	var labels    = Object.keys(diseases).slice(0, 10);
	if (!labels.length) return;
	var totalBeds = getTotalZonesForGreenhouses(scoutingData.entries);
	var palette   = ["#f59e0b","#ef4444","#8b5cf6","#10b981","#3b82f6","#ec4899","#14b8a6","#f97316","#6366f1","#06b6d4"];

	var data = labels.map(function (d, i) {
		var beds = new Set();
		(diseases[d].counts || []).forEach(function (c) {
			var k = getDistributionBedKey(c);
			if (k) beds.add(k);
		});
		var pct = totalBeds ? Number(((beds.size / totalBeds) * 100).toFixed(2)) : 0;
		return { value: pct, name: d, itemStyle: { color: observationColors.diseases[d] || palette[i % palette.length], borderRadius: [6, 6, 0, 0] } };
	});

	var unitWordPlural = getScopedUnitLabel(true);
	function builder(compact) {
		var base = _echartsBase(compact);
		return Object.assign(base, {
			legend: Object.assign({}, base.legend, { show: false }),
			tooltip: Object.assign({}, base.tooltip, {
				trigger: "item",
				formatter: function (p) {
					return '<div style="font-weight:600;margin-bottom:2px;">' + p.marker + p.name + '</div>'
						+ '<div>' + unitWordPlural + ' Affected: <b>' + Number(p.value).toFixed(2) + '%</b></div>';
				},
			}),
			grid: { left: 40, right: 16, top: 16, bottom: compact ? 56 : 76, containLabel: false },
			xAxis: {
				type: "category", data: labels,
				axisLine: { show: false }, axisTick: { show: false },
				axisLabel: { color: "#64748b", fontSize: 10, fontFamily: SD_FONT_FAMILY, rotate: -25, hideOverlap: true },
			},
			yAxis: {
				type: "value", min: 0,
				splitLine: { lineStyle: { color: "rgba(0,0,0,0.06)", type: "dashed" } },
				axisLine: { show: false }, axisTick: { show: false },
				axisLabel: { color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, formatter: function (v) { return v + "%"; } },
			},
			series: [{
				type: "bar", barMaxWidth: compact ? 28 : 40,
				itemStyle: { borderRadius: [6, 6, 0, 0] },
				label: {
					show: !compact, position: "top", color: "#334155", fontSize: 10, fontFamily: SD_FONT_FAMILY, fontWeight: 600,
					formatter: function (p) { return Number(p.value).toFixed(1) + "%"; },
				},
				emphasis: { disabled: true },
				data: data,
			}],
		});
	}

	_setChartCardSubtitle("disease-distribution-chart", unitWordPlural + " affected by disease type · click to zoom");
	renderEChart("disease-distribution-chart", builder, {
		title: "Disease Distribution",
		subtitle: unitWordPlural + " affected by disease type",
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
	if (!scoutingData) return;
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
	var labels = Object.keys(stages);
	if (!labels.length) return;
	var values = labels.map(function (l) { return stages[l]; });

	function builder(compact) {
		var base = _echartsBase(compact);
		return Object.assign(base, {
			color: ["#f59e0b","#3b82f6","#ef4444","#10b981","#8b5cf6","#ec4899","#14b8a6","#f97316"],
			legend: Object.assign({}, base.legend, { data: labels }),
			tooltip: Object.assign({}, base.tooltip, {
				trigger: "item",
				formatter: function (p) {
					return '<div style="font-weight:600;margin-bottom:2px;">' + p.marker + p.name + '</div>'
						+ '<div>' + formatNumber(p.value) + '  ·  ' + p.percent.toFixed(1) + '%</div>';
				},
			}),
			grid: undefined,
			series: [{
				type: "pie",
				radius: compact ? ["60%", "82%"] : ["55%", "78%"],
				center: ["50%", "46%"],
				avoidLabelOverlap: true,
				itemStyle: { borderColor: "#fff", borderWidth: 2 },
				label: { show: false },
				labelLine: { show: false },
				emphasis: { disabled: true },
				data: labels.map(function (l, i) { return { name: l, value: values[i] }; }),
			}],
		});
	}

	renderEChart("disease-stage-chart", builder, {
		title: "Stage Split",
		subtitle: diseaseName || "All diseases",
	});
}

function updateDiseaseStageRadialChart() {
	if (!scoutingData) return;
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
	if (!labels.length) return;
	var palette = ["#f59e0b","#ef4444","#8b5cf6","#10b981","#3b82f6","#ec4899","#14b8a6","#f97316"];
	var total = labels.reduce(function (a, l) { return a + stageCounts[l]; }, 0) || 1;

	function builder(compact) {
		var base = _echartsBase(compact);
		return Object.assign(base, {
			legend: Object.assign({}, base.legend, { show: false }),
			tooltip: Object.assign({}, base.tooltip, {
				trigger: "item",
				formatter: function (p) {
					var pct = ((p.value / total) * 100).toFixed(1);
					return '<div style="font-weight:600;margin-bottom:2px;">' + p.marker + p.name + '</div>'
						+ '<div>' + formatNumber(p.value) + '  ·  ' + pct + '%</div>';
				},
			}),
			grid: { left: 40, right: 16, top: 16, bottom: compact ? 56 : 76, containLabel: false },
			xAxis: {
				type: "category", data: labels,
				axisLine: { show: false }, axisTick: { show: false },
				axisLabel: { color: "#64748b", fontSize: 10, fontFamily: SD_FONT_FAMILY, rotate: -25, hideOverlap: true },
			},
			yAxis: {
				type: "value", min: 0,
				splitLine: { lineStyle: { color: "rgba(0,0,0,0.06)", type: "dashed" } },
				axisLine: { show: false }, axisTick: { show: false },
				axisLabel: { color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, formatter: function (v) { return Math.round(v); } },
			},
			series: [{
				type: "bar", barMaxWidth: compact ? 28 : 40,
				itemStyle: { borderRadius: [6, 6, 0, 0] },
				emphasis: { disabled: true },
				data: labels.map(function (l, i) { return { name: l, value: stageCounts[l], itemStyle: { color: palette[i % palette.length], borderRadius: [6, 6, 0, 0] } }; }),
			}],
		});
	}

	renderEChart("disease-stage-radial-chart", builder, {
		title: "Zones by Stage",
		subtitle: diseaseName ? diseaseName : "All diseases",
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
	if (!scoutingData) return;
	var dates = Object.keys(scoutingData.daily).sort();
	if (!dates.length) return;
	var includeYear = new Set(dates.map(function (d) { return d.slice(0, 4); })).size > 1;
	var values = dates.map(function (d) { return scoutingData.daily[d].traps || 0; });

	function builder(compact) {
		var base = _echartsBase(compact);
		return Object.assign(base, {
			color: ["#3b82f6"],
			legend: Object.assign({}, base.legend, { show: false }),
			tooltip: Object.assign({}, base.tooltip, {
				trigger: "axis",
				axisPointer: { type: "line", lineStyle: { color: "rgba(13,43,94,0.35)" } },
				formatter: function (params) {
					if (!params || !params.length) return "";
					var p = params[0];
					return '<div style="font-weight:600;margin-bottom:2px;">' + dates[p.dataIndex] + '</div>'
						+ '<div>' + p.marker + 'Trap Counts: <b>' + formatNumber(p.value) + '</b></div>';
				},
			}),
			xAxis: {
				type: "category", boundaryGap: false, data: dates,
				axisLine: { lineStyle: { color: "rgba(0,0,0,0.15)" } },
				axisTick: { show: false },
				axisLabel: {
					interval: 0, color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, hideOverlap: true,
					formatter: _isoWeekAxisFormatter(dates, includeYear),
				},
			},
			yAxis: {
				type: "value", min: 0,
				splitLine: { lineStyle: { color: "rgba(0,0,0,0.06)", type: "dashed" } },
				axisLine: { show: false }, axisTick: { show: false },
				axisLabel: { color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, formatter: function (v) { return Math.round(v); } },
			},
			series: [{
				name: "Trap Counts",
				type: "line", smooth: false,
				symbol: "circle", symbolSize: compact ? 4 : 6, showSymbol: true, sampling: "lttb",
				lineStyle: { width: compact ? 2 : 2.5 },
				areaStyle: { opacity: 0.18 },
				emphasis: { disabled: true },
				data: values,
			}],
		});
	}

	renderEChart("trap-trend-chart", builder, {
		title: "Trap Count Trends",
		subtitle: "Daily trap catches",
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
	if (!scoutingData) return;
	var rangeInfo = getSelectedWeekRangeInfo();
	if (!rangeInfo) return;
	var axis = getDayRangeAxis(rangeInfo);
	if (!axis) return;
	var dayIndex = {};
	axis.keys.forEach(function (k, i) { dayIndex[k] = i; });
	var trapName = root_element.querySelector("#trap-weekly-trap-filter")?.value || "";
	var pestName = root_element.querySelector("#trap-weekly-pest-filter")?.value || "";
	var seriesDefs = [];

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
		seriesDefs.push({ name: (trapName || "All Traps") + " (" + pestName + ")", color: observationColors.pests[pestName] || "#3b82f6", data: dailyCounts });
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
			seriesDefs.push({ name: p, color: observationColors.pests[p] || pal.border, data: byPest[p] });
		});
	}

	if (!seriesDefs.length) {
		seriesDefs.push({ name: "Trap Counts", color: "#3b82f6", data: new Array(axis.keys.length).fill(0) });
	}

	function builder(compact) {
		var base = _echartsBase(compact);
		var includeYear = new Set(axis.keys.map(function (k) { return k.slice(0, 4); })).size > 1;
		return Object.assign(base, {
			color: seriesDefs.map(function (s) { return s.color; }),
			legend: Object.assign({}, base.legend, { show: seriesDefs.length > 1, data: seriesDefs.map(function (s) { return s.name; }) }),
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
					return '<div style="font-weight:600;margin-bottom:6px;">' + axis.keys[idx] + '</div>' + rows;
				},
			}),
			xAxis: {
				type: "category", boundaryGap: false, data: axis.keys,
				axisLine: { lineStyle: { color: "rgba(0,0,0,0.15)" } },
				axisTick: { show: false },
				axisLabel: {
					interval: 0, color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, hideOverlap: true,
					formatter: _isoWeekAxisFormatter(axis.keys, includeYear),
				},
			},
			yAxis: {
				type: "value", min: 0,
				splitLine: { lineStyle: { color: "rgba(0,0,0,0.06)", type: "dashed" } },
				axisLine: { show: false }, axisTick: { show: false },
				axisLabel: { color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, formatter: function (v) { return Math.round(v); } },
			},
			series: seriesDefs.map(function (s) {
				return {
					name: s.name, type: "line", smooth: false,
					symbol: "circle", symbolSize: compact ? 4 : 6, showSymbol: true, sampling: "lttb",
					lineStyle: { width: compact ? 2 : 2.5 },
					emphasis: { disabled: true },
					data: s.data,
				};
			}),
		});
	}

	renderEChart("trap-weekly-trend-chart", builder, {
		title: "Trap Trends",
		subtitle: "Counts · daily data points",
	});
}

function updateTrapPerformanceChart() {
	if (!scoutingData) return;
	var locs = {};
	Object.keys(scoutingData.traps).forEach(function (k) {
		var l = scoutingData.traps[k].location || "Unknown";
		locs[l] = (locs[l] || 0) + scoutingData.traps[k].total;
	});
	var labels = Object.keys(locs).sort(function (a, b) { return locs[b] - locs[a]; }).slice(0, 10);
	if (!labels.length) return;
	var values = labels.map(function (l) { return locs[l]; });

	function builder(compact) {
		var base = _echartsBase(compact);
		return Object.assign(base, {
			color: ["#3b82f6"],
			legend: Object.assign({}, base.legend, { show: false }),
			tooltip: Object.assign({}, base.tooltip, {
				trigger: "item",
				formatter: function (p) {
					return '<div style="font-weight:600;margin-bottom:2px;">' + p.marker + p.name + '</div>'
						+ '<div>Total Count: <b>' + formatNumber(p.value) + '</b></div>';
				},
			}),
			grid: { left: 40, right: 16, top: 16, bottom: compact ? 56 : 76, containLabel: false },
			xAxis: {
				type: "category", data: labels,
				axisLine: { show: false }, axisTick: { show: false },
				axisLabel: { color: "#64748b", fontSize: 10, fontFamily: SD_FONT_FAMILY, rotate: -25, hideOverlap: true },
			},
			yAxis: {
				type: "value", min: 0,
				splitLine: { lineStyle: { color: "rgba(0,0,0,0.06)", type: "dashed" } },
				axisLine: { show: false }, axisTick: { show: false },
				axisLabel: { color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, formatter: function (v) { return Math.round(v); } },
			},
			series: [{
				type: "bar", barMaxWidth: compact ? 28 : 40,
				itemStyle: { color: "#3b82f6", borderRadius: [6, 6, 0, 0] },
				emphasis: { disabled: true },
				data: values,
			}],
		});
	}

	renderEChart("trap-performance-chart", builder, {
		title: "Trap Performance",
		subtitle: "By location",
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
	if (!scoutingData) return;
	var pests = {};
	Object.keys(scoutingData.traps).forEach(function (k) {
		var p = scoutingData.traps[k].pest || "Unknown";
		pests[p] = (pests[p] || 0) + scoutingData.traps[k].total;
	});
	var labels = Object.keys(pests).sort(function (a, b) { return pests[b] - pests[a]; }).slice(0, 10);
	if (!labels.length) return;
	var values = labels.map(function (l) { return pests[l]; });
	var colors = ["#3b82f6","#ef4444","#10b981","#f59e0b","#8b5cf6","#ec4899","#14b8a6","#f97316","#6366f1","#06b6d4"];

	function builder(compact) {
		var base = _echartsBase(compact);
		return Object.assign(base, {
			color: colors,
			legend: Object.assign({}, base.legend, { data: labels }),
			tooltip: Object.assign({}, base.tooltip, {
				trigger: "item",
				formatter: function (p) {
					return '<div style="font-weight:600;margin-bottom:2px;">' + p.marker + p.name + '</div>'
						+ '<div>' + formatNumber(p.value) + '  ·  ' + p.percent.toFixed(1) + '%</div>';
				},
			}),
			grid: undefined,
			series: [{
				type: "pie",
				radius: compact ? ["60%", "82%"] : ["55%", "78%"],
				center: ["50%", "46%"],
				avoidLabelOverlap: true,
				itemStyle: { borderColor: "#fff", borderWidth: 2 },
				label: { show: false },
				labelLine: { show: false },
				emphasis: { disabled: true },
				data: labels.map(function (l, i) { return { name: l, value: values[i] }; }),
			}],
		});
	}

	renderEChart("trap-pest-breakdown", builder, {
		title: "Pest Breakdown",
		subtitle: "By pest type in traps",
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

/* ── shared: unique scouting entries per warehouse (greenhouse or block) ── */
function _buildGhEntryVisits(data) {
	var visits = {};
	(data.entries || []).forEach(function (e) {
		var wh = (getEntryWarehouse(e) || "Unknown").trim();
		visits[wh] = (visits[wh] || 0) + 1;
	});
	return visits;
}

/* ── shared: zone/tree coverage % with fallback ── */
function _ghZonePct(gh, visits, zonesMap) {
	var normalGh = (gh || "").trim();
	var unitInfo = unitsPerWarehouse && (unitsPerWarehouse[normalGh] || unitsPerWarehouse[gh]);
	var zones = (unitInfo && Number(unitInfo.count)) || zonesMap[normalGh] || zonesMap[gh] || 0;
	var v = visits[normalGh] || visits[gh] || 0;
	if (zones > 0) return Math.min(100, Math.round((v / zones) * 100));
	if (scoutingYearData) {
		var yearVisits = _buildGhEntryVisits(scoutingYearData);
		var yearTotal = yearVisits[normalGh] || yearVisits[gh] || 0;
		if (yearTotal > 0) return Math.min(100, Math.round((v / yearTotal) * 100));
	}
	return 0;
}

/* ── shared horizontal bar builder (single or stacked series) ── */
function _ghHorizontalBarBuilder(opts) {
	/* opts: { palette, legend, series:[{name,color,data,formatter?}], categories, stacked, xLabel } */
	return function (compact) {
		var base = _echartsBase(compact);
		var legendNames = opts.series.map(function (s) { return s.name; });
		return Object.assign(base, {
			color: opts.series.map(function (s) { return s.color; }),
			legend: Object.assign({}, base.legend, { show: opts.series.length > 1, data: legendNames }),
			tooltip: Object.assign({}, base.tooltip, {
				trigger: "axis",
				axisPointer: { type: "shadow" },
				formatter: function (params) {
					if (!params || !params.length) return "";
					var rows = params.map(function (p) {
						var fmt = (opts.series[p.seriesIndex] && opts.series[p.seriesIndex].formatter) || function (v) { return formatNumber(v); };
						return '<div style="display:flex;justify-content:space-between;gap:14px;font-size:12px;">'
							+ '<span>' + p.marker + p.seriesName + '</span>'
							+ '<span style="font-weight:600;">' + fmt(p.value) + '</span></div>';
					}).join("");
					return '<div style="font-weight:600;margin-bottom:6px;">' + params[0].name + '</div>' + rows;
				},
			}),
			grid: { left: 110, right: 24, top: 16, bottom: opts.series.length > 1 ? 40 : 24, containLabel: true },
			xAxis: {
				type: "value", min: 0,
				name: opts.xLabel || "",
				nameTextStyle: { color: "#64748b", fontSize: 10, fontFamily: SD_FONT_FAMILY },
				splitLine: { lineStyle: { color: "rgba(0,0,0,0.06)", type: "dashed" } },
				axisLine: { show: false }, axisTick: { show: false },
				axisLabel: { color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, formatter: function (v) { return Math.round(v); } },
			},
			yAxis: {
				type: "category", data: opts.categories, inverse: true,
				axisLine: { show: false }, axisTick: { show: false },
				axisLabel: { color: "#475569", fontSize: 11, fontFamily: SD_FONT_FAMILY, hideOverlap: false },
			},
			series: opts.series.map(function (s) {
				return {
					name: s.name, type: "bar",
					stack: opts.stacked ? "total" : undefined,
					barMaxWidth: 22,
					itemStyle: { color: s.color, borderRadius: opts.stacked ? 0 : [0, 4, 4, 0] },
					emphasis: { disabled: true },
					data: s.data,
				};
			}),
		});
	};
}

/* ── horizontal bar with dual X axes (count + zone %) ── */
function _ghHorizontalDualBuilder(categories, countSeries, pctSeries) {
	return function (compact) {
		var base = _echartsBase(compact);
		return Object.assign(base, {
			color: [countSeries.color, pctSeries.color],
			legend: Object.assign({}, base.legend, { data: [countSeries.name, pctSeries.name] }),
			tooltip: Object.assign({}, base.tooltip, {
				trigger: "axis",
				axisPointer: { type: "shadow" },
				formatter: function (params) {
					if (!params || !params.length) return "";
					var rows = params.map(function (p) {
						var v = p.seriesIndex === 1 ? (Number(p.value) + "%") : formatNumber(p.value);
						return '<div style="display:flex;justify-content:space-between;gap:14px;font-size:12px;">'
							+ '<span>' + p.marker + p.seriesName + '</span>'
							+ '<span style="font-weight:600;">' + v + '</span></div>';
					}).join("");
					return '<div style="font-weight:600;margin-bottom:6px;">' + params[0].name + '</div>' + rows;
				},
			}),
			grid: { left: 110, right: 50, top: 30, bottom: 40, containLabel: true },
			xAxis: [
				{
					type: "value", min: 0, position: "bottom",
					name: countSeries.name, nameLocation: "middle", nameGap: 24,
					nameTextStyle: { color: "#64748b", fontSize: 10, fontFamily: SD_FONT_FAMILY },
					splitLine: { lineStyle: { color: "rgba(0,0,0,0.06)", type: "dashed" } },
					axisLine: { show: false }, axisTick: { show: false },
					axisLabel: { color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, formatter: function (v) { return Math.round(v); } },
				},
				{
					type: "value", min: 0, max: 100, position: "top",
					name: pctSeries.name, nameLocation: "middle", nameGap: 22,
					nameTextStyle: { color: "#64748b", fontSize: 10, fontFamily: SD_FONT_FAMILY },
					splitLine: { show: false },
					axisLine: { show: false }, axisTick: { show: false },
					axisLabel: { color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, formatter: function (v) { return v + "%"; } },
				},
			],
			yAxis: {
				type: "category", data: categories, inverse: true,
				axisLine: { show: false }, axisTick: { show: false },
				axisLabel: { color: "#475569", fontSize: 11, fontFamily: SD_FONT_FAMILY },
			},
			series: [
				{ name: countSeries.name, type: "bar", xAxisIndex: 0,
				  barMaxWidth: 12, barGap: "20%",
				  itemStyle: { color: countSeries.color, borderRadius: [0, 4, 4, 0] },
				  emphasis: { disabled: true },
				  data: countSeries.data },
				{ name: pctSeries.name, type: "bar", xAxisIndex: 1,
				  barMaxWidth: 12,
				  itemStyle: { color: pctSeries.color, borderRadius: [0, 4, 4, 0] },
				  emphasis: { disabled: true },
				  data: pctSeries.data },
			],
		});
	};
}

/* ── Pest GH bar ── */
function updatePestGhChart() {
	if (!scoutingData) return;
	var ghObs = {}, ghCnt = {};
	Object.values(scoutingData.pests).forEach(function (p) {
		p.counts.forEach(function (c) {
			var wh = ((c.block || c.greenhouse) || "Unknown").trim();
			ghObs[wh] = (ghObs[wh] || 0) + 1;
			ghCnt[wh] = (ghCnt[wh] || 0) + (c.count || 1);
		});
	});
	var ghVisits = _buildGhEntryVisits(scoutingData);
	var labels = Object.keys(ghObs).sort(function (a, b) { return ghObs[b] - ghObs[a]; }).slice(0, 12);
	if (!labels.length) return;
	var obsCounts = labels.map(function (g) { return ghObs[g]; });
	var zonePct   = labels.map(function (g) { return _ghZonePct(g, ghVisits, zonesPerGreenhouse); });
	var unitWord  = getScopedUnitLabel(false);

	renderEChart("pest-gh-bar-chart",
		_ghHorizontalDualBuilder(labels,
			{ name: "Observations", color: "#ef4444", data: obsCounts },
			{ name: unitWord + " Coverage %", color: "#3b82f6", data: zonePct }),
		{ title: "Pest Pressure by Greenhouse", subtitle: "Total observations · " + unitWord.toLowerCase() + " coverage %" });
}

/* ── Pest Bed bar ── */
function updatePestBedChart() {
	if (!scoutingData) return;
	var bedTotals = {};
	Object.values(scoutingData.pests).forEach(function (p) {
		p.counts.forEach(function (c) {
			var key = (c.bed || "No bed") + " · " + (c.greenhouse || "");
			bedTotals[key] = (bedTotals[key] || 0) + (c.count || 1);
		});
	});
	var labels = Object.keys(bedTotals).sort(function (a, b) { return bedTotals[b] - bedTotals[a]; }).slice(0, 12);
	if (!labels.length) return;

	renderEChart("pest-bed-bar-chart",
		_ghHorizontalBarBuilder({
			categories: labels,
			series: [{ name: "Total Pest Count", color: "#ef4444", data: labels.map(function (l) { return bedTotals[l]; }) }],
			xLabel: "Total Pest Count",
		}),
		{ title: "Top Beds by Pest Count", subtitle: "Highest cumulative pest counts" });
}

/* ── Disease GH bar ── */
function updateDiseaseGhChart() {
	if (!scoutingData) return;
	var ghObs = {};
	Object.values(scoutingData.diseases).forEach(function (d) {
		d.counts.forEach(function (c) {
			var wh = ((c.block || c.greenhouse) || "Unknown").trim();
			ghObs[wh] = (ghObs[wh] || 0) + 1;
		});
	});
	var ghVisits = _buildGhEntryVisits(scoutingData);
	var labels = Object.keys(ghObs).sort(function (a, b) { return ghObs[b] - ghObs[a]; }).slice(0, 12);
	if (!labels.length) return;
	var obsCounts = labels.map(function (g) { return ghObs[g]; });
	var zonePct   = labels.map(function (g) { return _ghZonePct(g, ghVisits, zonesPerGreenhouse); });
	var unitWord  = getScopedUnitLabel(false);

	renderEChart("disease-gh-bar-chart",
		_ghHorizontalDualBuilder(labels,
			{ name: "Incidents", color: "#f59e0b", data: obsCounts },
			{ name: unitWord + " Coverage %", color: "#10b981", data: zonePct }),
		{ title: "Disease Pressure by Greenhouse", subtitle: "Total incidents · " + unitWord.toLowerCase() + " coverage %" });
}

/* ── Disease Bed bar ── */
function updateDiseaseBedChart() {
	if (!scoutingData) return;
	var bedTotals = {};
	Object.values(scoutingData.diseases).forEach(function (d) {
		d.counts.forEach(function (c) {
			var key = (c.bed || "No bed") + " · " + (c.greenhouse || "");
			bedTotals[key] = (bedTotals[key] || 0) + 1;
		});
	});
	var labels = Object.keys(bedTotals).sort(function (a, b) { return bedTotals[b] - bedTotals[a]; }).slice(0, 12);
	if (!labels.length) return;

	renderEChart("disease-bed-bar-chart",
		_ghHorizontalBarBuilder({
			categories: labels,
			series: [{ name: "Disease Incidents", color: "#f59e0b", data: labels.map(function (l) { return bedTotals[l]; }) }],
			xLabel: "Disease Incidents",
		}),
		{ title: "Top Beds by Disease Incidence", subtitle: "Highest disease observation counts" });
}

/* ── Trap GH bar: FCM vs General stacked ── */
function updateTrapGhChart() {
	if (!scoutingData) return;
	var fcmGh = {}, genGh = {};
	Object.values(scoutingData.traps).forEach(function (t) {
		var isFcm = getFocusKey ? !!getFocusKey(t.pest) : false;
		t.counts.forEach(function (c) {
			var gh = c.greenhouse || "Unknown";
			if (isFcm) fcmGh[gh] = (fcmGh[gh] || 0) + (c.count || 0);
			else       genGh[gh] = (genGh[gh] || 0) + (c.count || 0);
		});
	});
	var allGh = Array.from(new Set(Object.keys(fcmGh).concat(Object.keys(genGh))));
	allGh.sort(function (a, b) {
		return ((fcmGh[b] || 0) + (genGh[b] || 0)) - ((fcmGh[a] || 0) + (genGh[a] || 0));
	});
	var labels = allGh.slice(0, 12);
	if (!labels.length) return;

	renderEChart("trap-gh-bar-chart",
		_ghHorizontalBarBuilder({
			categories: labels,
			stacked: true,
			xLabel: "Catch Count",
			series: [
				{ name: "FCM / Focus Traps", color: "#ef4444", data: labels.map(function (g) { return fcmGh[g] || 0; }) },
				{ name: "General Traps",     color: "#6366f1", data: labels.map(function (g) { return genGh[g] || 0; }) },
			],
		}),
		{ title: "FCM vs General Traps by Greenhouse", subtitle: "Stacked catch counts · focus vs other pests" });
}

/* ── Indoor vs Outdoor bar ── */
function updateTrapIndoorOutdoorChart() {
	if (!scoutingData) return;
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
	if (!labels.length) return;

	renderEChart("trap-indoor-outdoor-chart",
		_ghHorizontalBarBuilder({
			categories: labels,
			stacked: true,
			xLabel: "Zones",
			series: [
				{ name: "Indoor",          color: "#10b981", data: labels.map(function (g) { return indoorGh[g] || 0; }) },
				{ name: "Outdoor / Field", color: "#f59e0b", data: labels.map(function (g) { return outdoorGh[g] || 0; }) },
			],
		}),
		{ title: "Indoor vs Outdoor Scouting", subtitle: "Trap zones by location type per greenhouse" });
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
	if (!scoutingData) return;
	var rangeInfo = getSelectedWeekRangeInfo();
	if (!rangeInfo) return;
	var axis = getDayRangeAxis(rangeInfo);
	if (!axis) return;
	var dayIndex = {};
	axis.keys.forEach(function (k, i) { dayIndex[k] = i; });

	var totals = {};
	FOCUS_PESTS.forEach(function (f) { totals[f.key] = new Array(axis.keys.length).fill(0); });

	Object.values(scoutingData.traps || {}).forEach(function (t) {
		var key = getFocusKey(t.pest || "");
		if (!key) return;
		(t.counts || []).forEach(function (c) {
			var i = dayIndex[c.date];
			if (i !== undefined) totals[key][i] += Number(c.count || 0);
		});
	});

	Object.keys(scoutingData.pests || {}).forEach(function (pn) {
		var key = getFocusKey(pn);
		if (!key) return;
		(scoutingData.pests[pn].counts || []).forEach(function (c) {
			var i = dayIndex[c.date];
			if (i !== undefined) totals[key][i] += Number(c.count || 1);
		});
	});

	var seriesDefs = FOCUS_PESTS
		.filter(function (f) { return totals[f.key].some(function (v) { return v > 0; }); })
		.map(function (f) {
			var col = FCM_MOTH_COLORS[f.key] || { border: "#94a3b8" };
			return { name: f.label, color: col.border, data: totals[f.key] };
		});

	if (!seriesDefs.length) {
		seriesDefs.push({ name: "FCM", color: FCM_MOTH_COLORS.fcm.border, data: new Array(axis.keys.length).fill(0) });
	}

	function builder(compact) {
		var base = _echartsBase(compact);
		var includeYear = new Set(axis.keys.map(function (k) { return k.slice(0, 4); })).size > 1;
		return Object.assign(base, {
			color: seriesDefs.map(function (s) { return s.color; }),
			legend: Object.assign({}, base.legend, { data: seriesDefs.map(function (s) { return s.name; }) }),
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
					return '<div style="font-weight:600;margin-bottom:6px;">' + axis.keys[idx] + '</div>' + rows;
				},
			}),
			xAxis: {
				type: "category", boundaryGap: false, data: axis.keys,
				axisLine: { lineStyle: { color: "rgba(0,0,0,0.15)" } },
				axisTick: { show: false },
				axisLabel: {
					interval: 0, color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, hideOverlap: true,
					formatter: _isoWeekAxisFormatter(axis.keys, includeYear),
				},
			},
			yAxis: {
				type: "value", min: 0,
				splitLine: { lineStyle: { color: "rgba(0,0,0,0.06)", type: "dashed" } },
				axisLine: { show: false }, axisTick: { show: false },
				axisLabel: { color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, formatter: function (v) { return Math.round(v); } },
			},
			series: seriesDefs.map(function (s) {
				return {
					name: s.name, type: "line", smooth: false,
					symbol: "circle", symbolSize: compact ? 4 : 6, showSymbol: true, sampling: "lttb",
					lineStyle: { width: compact ? 2 : 2.5 },
					emphasis: { disabled: true },
					data: s.data,
				};
			}),
		});
	}

	renderEChart("fcm-moth-trend-chart", builder, {
		title: "FCM & Moth Trends",
		subtitle: "Daily catches (traps) + scouting counts",
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
			? '<div class="empty-state">No recent focus zones</div>'
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
	_setText("#scout-gh-modal-period", rangeInfo.fromDate + " to " + rangeInfo.toDate);
	_setText("#ghk-pests", ghData.pests);
	_setText("#ghk-diseases", ghData.diseases);
	/* Match by either column — block-typed (orchard) entries set the
	   warehouse name on `block`, not `greenhouse`. */
	var matchesWarehouse = function (c) {
		return ((c && (c.greenhouse || c.block)) || "") === greenhouse;
	};
	var _ghTrapTotal = Object.keys(scoutingData.traps).reduce(function (sum, k) {
		return sum + scoutingData.traps[k].counts
			.filter(matchesWarehouse)
			.reduce(function (s, c) { return s + c.count; }, 0);
	}, 0);
	_setText("#ghk-traps", formatNumber(_ghTrapTotal));
	_setText("#ghk-scouts", ghData.scoutCount);
	_setText("#ghk-alerts", ghData.alerts);

	/* pests */
	var pestCounts = {};
	Object.keys(scoutingData.pests).forEach(function (pest) {
		var cnt = scoutingData.pests[pest].counts.filter(matchesWarehouse).length;
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
		var cnt = scoutingData.diseases[dis].counts.filter(matchesWarehouse).length;
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
		var cnt = scoutingData.traps[k].counts.filter(matchesWarehouse).length;
		if (cnt) {
			var name = scoutingData.traps[k].trap;
			var ghTot = scoutingData.traps[k].counts
				.filter(matchesWarehouse)
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
	if (!scoutingData) return;
	var rangeInfo = getSelectedWeekRangeInfo();
	var dayAxis   = rangeInfo ? getDayRangeAxis(rangeInfo) : null;

	/* Match the warehouse on either column — block-typed (orchard) entries
	   set `block` instead of `greenhouse`. */
	var ghEntries = scoutingData.entries.filter(function (e) { return getEntryWarehouse(e) === greenhouse; });
	/* Modal denominator is the *single* warehouse, not the dashboard scope:
	   zones for greenhouses, trees for blocks (with the legacy zone map as
	   fallback). */
	var unitInfo = unitsPerWarehouse && unitsPerWarehouse[greenhouse];
	var totalBeds = (unitInfo && Number(unitInfo.count))
		|| Number(zonesPerGreenhouse[greenhouse] || 0)
		|| getTotalBedsForDistribution(ghEntries) || 1;
	var unitWordPlural = (unitInfo && unitInfo.type === "block") ? "Trees" : "Zones";

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

	var dates;
	if (dayAxis) {
		dates  = dayAxis.keys;
	} else {
		var seen = new Set(ghEntries.map(function (e) { return e.date_of_capture; }));
		dates  = Array.from(seen).sort().slice(-21);
	}
	if (!dates.length) return;

	var pestPct = dates.map(function (d) { return toBedInfectionPercent((pestBeds[d] || { size: 0 }).size, totalBeds); });
	var disPct  = dates.map(function (d) { return toBedInfectionPercent((disBeds[d]  || { size: 0 }).size, totalBeds); });
	var trapVal = dates.map(function (d) { return trapCounts[d] || 0; });

	var pestSeriesName = "Pests · " + unitWordPlural + " Affected (%)";
	var disSeriesName  = "Diseases · " + unitWordPlural + " Affected (%)";
	var trapSeriesName = "Trap Catch Count";
	function builder(compact) {
		var base = _echartsBase(compact);
		var includeYear = new Set(dates.map(function (d) { return d.slice(0, 4); })).size > 1;
		return Object.assign(base, {
			color: ["#10b981", "#f59e0b", "#3b82f6"],
			legend: Object.assign({}, base.legend, { data: [pestSeriesName, disSeriesName, trapSeriesName] }),
			tooltip: Object.assign({}, base.tooltip, {
				trigger: "axis",
				axisPointer: { type: "line", lineStyle: { color: "rgba(13,43,94,0.35)" } },
				formatter: function (params) {
					if (!params || !params.length) return "";
					var idx = params[0].dataIndex;
					var rows = params.map(function (p) {
						var v = p.seriesIndex === 2 ? formatNumber(p.value) : Number(p.value).toFixed(1) + "%";
						return '<div style="display:flex;justify-content:space-between;gap:14px;font-size:12px;">'
							+ '<span>' + p.marker + p.seriesName + '</span>'
							+ '<span style="font-weight:600;">' + v + '</span></div>';
					}).join("");
					return '<div style="font-weight:600;margin-bottom:6px;">' + dates[idx] + '</div>' + rows;
				},
			}),
			grid: { left: 40, right: 50, top: 16, bottom: compact ? 36 : 56, containLabel: false },
			xAxis: {
				type: "category", boundaryGap: false, data: dates,
				axisLine: { lineStyle: { color: "rgba(0,0,0,0.15)" } },
				axisTick: { show: false },
				axisLabel: {
					interval: 0, color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, hideOverlap: true,
					formatter: _isoWeekAxisFormatter(dates, includeYear),
				},
			},
			yAxis: [
				{ type: "value", min: 0, name: unitWordPlural + " Affected %",
				  nameTextStyle: { color: "#64748b", fontSize: 10, fontFamily: SD_FONT_FAMILY },
				  splitLine: { lineStyle: { color: "rgba(0,0,0,0.06)", type: "dashed" } },
				  axisLine: { show: false }, axisTick: { show: false },
				  axisLabel: { color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, formatter: function (v) { return v.toFixed(0) + "%"; } } },
				{ type: "value", min: 0, name: "Trap Count", position: "right",
				  nameTextStyle: { color: "#64748b", fontSize: 10, fontFamily: SD_FONT_FAMILY },
				  splitLine: { show: false },
				  axisLine: { show: false }, axisTick: { show: false },
				  axisLabel: { color: "#64748b", fontSize: 11, fontFamily: SD_FONT_FAMILY, formatter: function (v) { return Math.round(v); } } },
			],
			series: [
				{ name: pestSeriesName, type: "line", smooth: false, yAxisIndex: 0,
				  symbol: "circle", symbolSize: compact ? 4 : 6, showSymbol: true,
				  lineStyle: { width: compact ? 2 : 2.5 }, areaStyle: { opacity: 0.15 },
				  emphasis: { disabled: true }, data: pestPct },
				{ name: disSeriesName, type: "line", smooth: false, yAxisIndex: 0,
				  symbol: "circle", symbolSize: compact ? 4 : 6, showSymbol: true,
				  lineStyle: { width: compact ? 2 : 2.5 }, areaStyle: { opacity: 0.15 },
				  emphasis: { disabled: true }, data: disPct },
				{ name: trapSeriesName, type: "line", smooth: false, yAxisIndex: 1,
				  symbol: "circle", symbolSize: compact ? 4 : 6, showSymbol: true,
				  lineStyle: { width: compact ? 2 : 2.5 },
				  emphasis: { disabled: true }, data: trapVal },
			],
		});
	}

	renderEChart("scout-gh-trend-chart", builder, {
		title: greenhouse + " · Daily Trend",
		subtitle: "Pests · Diseases · Trap counts",
	});
}

function closeScoutModal() {
	var modal = root_element.querySelector("#scout-gh-modal");
	if (modal) modal.classList.remove("active");
}
