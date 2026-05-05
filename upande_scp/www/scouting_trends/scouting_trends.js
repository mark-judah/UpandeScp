/* ════════════════════════════════════════════════════════
   SCOUTING TRENDS PAGE
   Standalone trend explorer:
   - Tree:  Farm  →  Station (greenhouse / block)
   - Three multi-select pickers: Pest · Stage · Section
   - Right pane renders one chart panel per
     (pest × stage × section) combo, each with one
     line per checked station.
   Y-axis = total observations matching the panel's filter,
   summed daily.
   ════════════════════════════════════════════════════════ */

(function () {
	"use strict";

	var rootEl = document.querySelector("#scouting-trends-root");
	if (!rootEl) return;

	/* ─── State ─── */
	var state = {
		fromDate: "",
		toDate:   "",
		crop:     "Rose",      // header crop filter; default Rose
		entries:  [],          // raw entries straight from the API
		filteredEntries: [],   // entries narrowed by state.crop
		stationFarms: {},      // station -> farm  (from units_by_greenhouse meta)
		stationUnits: {},      // station -> { type: "greenhouse"|"block", count: N }
		stagePicks: {},        // obsId ("pest:Thrips" / "disease:..") -> [stageName,...]
	};

	var panelHostIds = [];     // dynamic chart-host ids for dispose tracking
	var echartInstances = {};  // id -> echarts instance
	var echartResizeBound = false;
	var _hostSeq = 0;          // monotonic id counter so incremental adds don't collide

	/* ════════════════════════════════════════
	   ECharts loading + rendering helpers
	   ════════════════════════════════════════ */

	function loadEcharts() {
		if (typeof window.echarts !== "undefined") return Promise.resolve();
		return new Promise(function (resolve, reject) {
			var s = document.createElement("script");
			s.src = "https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js";
			s.onload = resolve;
			s.onerror = reject;
			document.head.appendChild(s);
		});
	}

	function bindResizeOnce() {
		if (echartResizeBound) return;
		echartResizeBound = true;
		var rzTimer = null;
		window.addEventListener("resize", function () {
			clearTimeout(rzTimer);
			rzTimer = setTimeout(function () {
				Object.keys(echartInstances).forEach(function (id) {
					try { echartInstances[id].resize(); } catch (e) {}
				});
			}, 80);
		});
	}

	function disposePanels() {
		panelHostIds.forEach(function (id) {
			var inst = echartInstances[id];
			if (inst) { try { inst.dispose(); } catch (e) {} delete echartInstances[id]; }
		});
		panelHostIds = [];
	}

	function renderEcharts(hostEl, option) {
		bindResizeOnce();
		var inst = window.echarts.init(hostEl, null, { renderer: "svg" });
		inst.setOption(option, true);
		echartInstances[hostEl.id] = inst;

		/* Click-to-pin highlight: clicking a line locks it in focus; clicking
		   the same line again (or another) toggles. Hover focus continues to
		   work normally via emphasis.focus = "series". */
		var pinned = -1;
		inst.on("click", function (params) {
			if (params.componentType !== "series") return;
			var i = params.seriesIndex;
			if (pinned === i) {
				inst.dispatchAction({ type: "downplay", seriesIndex: i });
				pinned = -1;
			} else {
				if (pinned >= 0) inst.dispatchAction({ type: "downplay", seriesIndex: pinned });
				inst.dispatchAction({ type: "highlight", seriesIndex: i });
				pinned = i;
			}
		});
		return inst;
	}

	/* ════════════════════════════════════════
	   Date helpers (page-local; default range = last 4 weeks)
	   ════════════════════════════════════════ */

	function fmtDate(d) {
		var y = d.getFullYear();
		var m = ("0" + (d.getMonth() + 1)).slice(-2);
		var dd = ("0" + d.getDate()).slice(-2);
		return y + "-" + m + "-" + dd;
	}

	function defaultDateRange() {
		var to = new Date();
		var from = new Date();
		from.setDate(to.getDate() - 28);
		return { from: fmtDate(from), to: fmtDate(to) };
	}

	function dateKeysBetween(fromStr, toStr) {
		var out = [];
		var f = new Date(fromStr + "T00:00:00");
		var t = new Date(toStr + "T00:00:00");
		while (f <= t) {
			out.push(fmtDate(f));
			f.setDate(f.getDate() + 1);
		}
		return out;
	}

	/* ISO 8601 week string (YYYY-Www) for a YYYY-MM-DD date. Mon=1…Sun=7. */
	function isoWeekStringForDate(dateStr) {
		var d = new Date(dateStr + "T00:00:00Z");
		var dayNum = d.getUTCDay() || 7;
		d.setUTCDate(d.getUTCDate() + 4 - dayNum);
		var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
		var weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
		return d.getUTCFullYear() + "-W" + ("0" + weekNum).slice(-2);
	}

	/* Daily x-axis with Sundays excluded — no scouting on Sundays, so dropping
	   them keeps the trend from snapping to zero each weekend. */
	function buildDayAxisSkippingSunday(fromStr, toStr) {
		var keys = [];
		var f = new Date(fromStr + "T00:00:00");
		var t = new Date(toStr + "T00:00:00");
		while (f <= t) {
			if (f.getDay() !== 0) keys.push(fmtDate(f));
			f.setDate(f.getDate() + 1);
		}
		return keys;
	}

	/* ════════════════════════════════════════
	   Data loading
	   ════════════════════════════════════════ */

	function showLoader(text) {
		var el = document.getElementById("st-loader");
		var t  = document.getElementById("st-loader-text");
		if (t) t.textContent = text || "Loading…";
		if (el) el.removeAttribute("hidden");
	}

	function hideLoader() {
		var el = document.getElementById("st-loader");
		if (el) el.setAttribute("hidden", "");
	}

	/* Mirrors scouting_dashboard.js's callFrappe: prefer window.frappe.call,
	   fall back to REST so the page works in contexts where the bundle hasn't
	   booted yet. Resolves with the full response envelope; callers unwrap
	   `.message`. */
	function callFrappe(method, args) {
		if (window.frappe && typeof window.frappe.call === "function") {
			return new Promise(function (resolve, reject) {
				window.frappe.call({
					method: method,
					args: args,
					callback: function (r) { resolve(r || {}); },
					error: function (err) { reject(err); },
				});
			});
		}
		var params = new URLSearchParams();
		Object.keys(args || {}).forEach(function (key) {
			var v = args[key];
			if (v == null) return;
			params.set(key, typeof v === "string" ? v : JSON.stringify(v));
		});
		var url = "/api/method/" + method;
		var qs = params.toString();
		if (qs) url += "?" + qs;
		return fetch(url, {
			method: "GET",
			credentials: "same-origin",
			headers: { Accept: "application/json" },
		}).then(function (res) {
			return res.json().catch(function () { return null; }).then(function (data) {
				if (!res.ok) {
					var err = new Error((data && (data.exc || data.message)) || ("HTTP " + res.status));
					err.response = data;
					throw err;
				}
				return data || {};
			});
		});
	}

	/* ─── Monthly chunked fetch (mirrors scouting_dashboard) ───
	   Each chunk is a separate Redis key on the server, so any month
	   already loaded by the dashboard is reused here (and vice versa).
	   monthCache persists across navigations within the page session;
	   only missing months are fetched. */
	var monthCache = { key: "", months: {} };
	var metaCache  = null;

	function _pad2(n) { return ("0" + n).slice(-2); }

	function getMonthKeysBetween(fromStr, toStr) {
		var out = [];
		var fy = parseInt(fromStr.slice(0, 4), 10);
		var fm = parseInt(fromStr.slice(5, 7), 10);
		var ty = parseInt(toStr.slice(0, 4), 10);
		var tm = parseInt(toStr.slice(5, 7), 10);
		while (fy < ty || (fy === ty && fm <= tm)) {
			out.push(fy + "-" + _pad2(fm));
			fm++; if (fm > 12) { fm = 1; fy++; }
		}
		return out;
	}

	function monthBounds(monthKey) {
		var y = parseInt(monthKey.slice(0, 4), 10);
		var m = parseInt(monthKey.slice(5, 7), 10);
		var lastDay = new Date(y, m, 0).getDate();
		return {
			fromDate: monthKey + "-01",
			toDate:   monthKey + "-" + _pad2(lastDay),
		};
	}

	function fetchScoutingChunk(fromDate, toDate, includeMeta) {
		return callFrappe(
			"upande_scp.serverscripts.get_complete_scouting_entries.getScoutingEntriesChunk",
			{ from_date: fromDate, to_date: toDate, include_meta: includeMeta ? 1 : 0 }
		).then(function (r) { return (r && r.message) || {}; });
	}

	function collectCachedEntries(fromStr, toStr) {
		var out = [];
		Object.keys(monthCache.months).forEach(function (mk) {
			(monthCache.months[mk] || []).forEach(function (e) {
				var d = (e && e.date_of_capture || "").slice(0, 10);
				if (d >= fromStr && d <= toStr) out.push(e);
			});
		});
		return out;
	}

	/* Returns a payload shaped like the old single-call response so the rest
	   of the page can treat it identically. Only fetches months not already
	   in monthCache. Meta payload (zone counts, colors, …) is fetched once
	   alongside the first missing month. */
	function fetchScoutingData() {
		var fromYear = state.fromDate.slice(0, 4);
		var toYear   = state.toDate.slice(0, 4);
		var key = fromYear + "|" + toYear;
		if (monthCache.key !== key) {
			monthCache = { key: key, months: {} };
		}

		var months = getMonthKeysBetween(state.fromDate, state.toDate);
		var missing = months.filter(function (mk) { return !monthCache.months[mk]; });

		if (missing.length === 0 && metaCache) {
			return Promise.resolve(_payloadFromCache());
		}

		var needMeta = !metaCache;
		var chain = Promise.resolve();
		missing.forEach(function (monthKey, idx) {
			chain = chain.then(function () {
				var bounds = monthBounds(monthKey);
				var withMeta = needMeta && idx === 0;
				return fetchScoutingChunk(bounds.fromDate, bounds.toDate, withMeta).then(function (res) {
					monthCache.months[monthKey] = res.entries || [];
					if (withMeta) {
						metaCache = {
							pest_colors:         res.pest_colors         || [],
							disease_colors:      res.disease_colors      || [],
							zones_by_greenhouse: res.zones_by_greenhouse || {},
							units_by_greenhouse: res.units_by_greenhouse || {},
							crops_scouted:       res.crops_scouted       || [],
							severity_thresholds: res.severity_thresholds || {},
						};
					}
				});
			});
		});
		return chain.then(_payloadFromCache);
	}

	function _payloadFromCache() {
		var p = {
			entries: collectCachedEntries(state.fromDate, state.toDate),
		};
		if (metaCache) {
			p.pest_colors         = metaCache.pest_colors;
			p.disease_colors      = metaCache.disease_colors;
			p.zones_by_greenhouse = metaCache.zones_by_greenhouse;
			p.units_by_greenhouse = metaCache.units_by_greenhouse;
			p.crops_scouted       = metaCache.crops_scouted;
			p.severity_thresholds = metaCache.severity_thresholds;
		}
		return p;
	}

	/* Build station→farm and station→unit-count lookups from the
	   `units_by_greenhouse` meta map. Greenhouse stations use zone counts;
	   block stations use orchard-tree counts. The denominator drives the
	   percentage axis. */
	function ingestStationMeta(payload) {
		var farms = {};
		var units = {};
		var src = payload.units_by_greenhouse || {};
		Object.keys(src).forEach(function (wh) {
			var rec = src[wh] || {};
			if (rec.farm) farms[wh] = rec.farm;
			units[wh] = {
				type:  rec.type || "",
				count: Number(rec.count || 0) || 0,
			};
		});
		state.stationFarms = farms;
		state.stationUnits = units;
	}

	function farmFor(station) {
		return state.stationFarms[station] || "Unspecified";
	}

	function unitCountFor(station) {
		var rec = state.stationUnits[station];
		return rec ? rec.count : 0;
	}

	/* Crop filter. Empty / null crop_scouted is treated as "Rose" since
	   pre-Avocado historic entries didn't fill the field. */
	function entryMatchesCrop(entry, crop) {
		var c = (entry.crop_scouted || "").trim();
		if (crop === "Rose") return !c || c === "Rose";
		return c === crop;
	}

	function applyCropFilter() {
		state.filteredEntries = state.entries.filter(function (e) {
			return entryMatchesCrop(e, state.crop);
		});
	}

	function discoverCrops() {
		/* Always include Rose (default) plus every distinct non-empty
		   crop_scouted value seen in the loaded entries. */
		var set = { Rose: true };
		state.entries.forEach(function (e) {
			var c = (e.crop_scouted || "").trim();
			if (c) set[c] = true;
		});
		return Object.keys(set).sort();
	}

	function renderCropOptions() {
		var sel = document.getElementById("st-crop");
		if (!sel) return;
		var crops = discoverCrops();
		var current = state.crop;
		sel.innerHTML = "";
		crops.forEach(function (c) {
			var opt = document.createElement("option");
			opt.value = c;
			opt.textContent = c;
			if (c === current) opt.selected = true;
			sel.appendChild(opt);
		});
	}

	function unitKeyForEntry(entry) {
		/* Greenhouse stations key on Zone (or Bed as a fallback when zone is
		   blank); block stations key on (block, tree). Mirrors the dashboard's
		   getDistributionBedKey so the denominator and the numerator agree. */
		var block = (entry.block || "").trim();
		if (block) {
			var tree = (entry.tree || "").trim();
			if (!tree) return "";
			return block + "::tree::" + tree;
		}
		var zone = (entry.zone || "").trim();
		if (zone) return "zone::" + zone;
		var bed = (entry.bed || "").trim();
		return bed ? "bed::" + bed : "";
	}

	/* ════════════════════════════════════════
	   Available options derived from entries
	   ════════════════════════════════════════ */

	function gatherOptions() {
		var farmStations = {};   // farm -> { station -> totalObservations }
		var pestCounts    = {};
		var diseaseCounts = {};
		var stageCounts   = {};
		var sectionCounts = {};

		state.filteredEntries.forEach(function (e) {
			var station = (e.block || e.greenhouse || "").trim();
			var pestRows  = e.pests    || [];
			var dzRows    = e.diseases || [];
			if (station) {
				var farm = farmFor(station);
				if (!farmStations[farm]) farmStations[farm] = {};
				farmStations[farm][station] = (farmStations[farm][station] || 0) + pestRows.length + dzRows.length;
			}
			pestRows.forEach(function (p) {
				var pn = (p.pest          || "").trim();
				var sg = (p.stage         || "").trim();
				var sc = (p.plant_section || "").trim();
				if (pn) pestCounts[pn]    = (pestCounts[pn]    || 0) + 1;
				if (sg) stageCounts[sg]   = (stageCounts[sg]   || 0) + 1;
				if (sc) sectionCounts[sc] = (sectionCounts[sc] || 0) + 1;
			});
			dzRows.forEach(function (d) {
				var dn = (d.disease       || "").trim();
				var sg = (d.stage         || "").trim();
				var sc = (d.plant_section || "").trim();
				if (dn) diseaseCounts[dn] = (diseaseCounts[dn] || 0) + 1;
				if (sg) stageCounts[sg]   = (stageCounts[sg]   || 0) + 1;
				if (sc) sectionCounts[sc] = (sectionCounts[sc] || 0) + 1;
			});
		});

		return {
			farmStations: farmStations,
			pests:        pestCounts,
			diseases:     diseaseCounts,
			stages:       stageCounts,
			sections:     sectionCounts,
		};
	}

	/* ════════════════════════════════════════
	   Tree component (Farm → Station, with tristate)
	   ════════════════════════════════════════ */

	var TT_CARET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
	var TT_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 13 10 18 19 7"/></svg>';

	function buildTreeNodes(options) {
		var fs = options.farmStations || {};
		var farms = Object.keys(fs).sort();
		return farms.map(function (farm) {
			var stations = Object.keys(fs[farm] || {}).sort();
			var stationKids = stations.map(function (st) {
				return {
					id: "station:" + farm + "|" + st,
					label: st,
					count: fs[farm][st],
				};
			});
			var farmTotal = stationKids.reduce(function (s, k) { return s + (k.count || 0); }, 0);
			return {
				id: "farm:" + farm,
				label: farm,
				count: farmTotal,
				children: stationKids,
			};
		});
	}

	function buildObsTreeNodes(options) {
		var pestKeys = Object.keys(options.pests    || {}).sort();
		var dzKeys   = Object.keys(options.diseases || {}).sort();
		var nodes = [];
		if (pestKeys.length) {
			nodes.push({
				id: "obs:group:pest",
				label: "Pests",
				count: pestKeys.reduce(function (s, k) { return s + (options.pests[k] || 0); }, 0),
				children: pestKeys.map(function (k) {
					return { id: "obs:pest:" + k, label: k, count: options.pests[k] };
				}),
			});
		}
		if (dzKeys.length) {
			nodes.push({
				id: "obs:group:disease",
				label: "Diseases",
				count: dzKeys.reduce(function (s, k) { return s + (options.diseases[k] || 0); }, 0),
				children: dzKeys.map(function (k) {
					return { id: "obs:disease:" + k, label: k, count: options.diseases[k] };
				}),
			});
		}
		return nodes;
	}

	function renderTree(hostEl, nodes, onChange) {
		hostEl.innerHTML = "";
		if (!nodes.length) {
			hostEl.innerHTML = '<div class="st-tree-empty">No stations in this date range.</div>';
			return;
		}

		function makeNode(node, level, parentEl) {
			var nodeEl = document.createElement("div");
			nodeEl.className = "st-node";
			nodeEl.dataset.id = node.id;
			nodeEl.dataset.label = node.label;
			nodeEl.dataset.expanded = level === 0 ? "true" : "false";
			nodeEl.dataset.hidden = "false";

			var hasChildren = !!(node.children && node.children.length);

			var rowEl = document.createElement("div");
			rowEl.className = "st-row";
			rowEl.dataset.checked = "false";
			rowEl.dataset.indeterminate = "false";

			var toggleBtn = document.createElement("button");
			toggleBtn.type = "button";
			toggleBtn.className = "st-toggle";
			toggleBtn.tabIndex = -1;
			toggleBtn.innerHTML = TT_CARET;
			if (!hasChildren) toggleBtn.dataset.leaf = "true";
			rowEl.appendChild(toggleBtn);

			var checkboxEl = document.createElement("span");
			checkboxEl.className = "st-checkbox";
			checkboxEl.innerHTML = TT_CHECK;
			rowEl.appendChild(checkboxEl);

			var nameEl = document.createElement("span");
			nameEl.className = "st-name";
			nameEl.textContent = node.label;
			rowEl.appendChild(nameEl);

			if (typeof node.count === "number") {
				var metaEl = document.createElement("span");
				metaEl.className = "st-meta";
				metaEl.textContent = node.count;
				rowEl.appendChild(metaEl);
			}

			nodeEl.appendChild(rowEl);

			if (hasChildren) {
				var childrenEl = document.createElement("div");
				childrenEl.className = "st-children";
				nodeEl.appendChild(childrenEl);
				node.children.forEach(function (c) { makeNode(c, level + 1, childrenEl); });
			}

			rowEl.addEventListener("click", function (ev) {
				if (ev.target.closest(".st-toggle")) return;
				ev.preventDefault();
				var fullyChecked = rowEl.dataset.checked === "true" && rowEl.dataset.indeterminate !== "true";
				setSubtreeChecked(nodeEl, !fullyChecked);
				refreshAncestors(nodeEl, hostEl);
				onChange();
			});

			toggleBtn.addEventListener("click", function (ev) {
				ev.stopPropagation();
				ev.preventDefault();
				if (!hasChildren) return;
				nodeEl.dataset.expanded = nodeEl.dataset.expanded === "true" ? "false" : "true";
			});

			parentEl.appendChild(nodeEl);
		}

		nodes.forEach(function (n) { makeNode(n, 0, hostEl); });
	}

	function setSubtreeChecked(scopeEl, checked) {
		var rows = scopeEl.querySelectorAll(".st-row");
		rows.forEach(function (r) {
			r.dataset.checked = checked ? "true" : "false";
			r.dataset.indeterminate = "false";
		});
	}

	function refreshAncestors(startNodeEl, hostEl) {
		var cur = startNodeEl.parentElement;
		while (cur && cur !== hostEl) {
			if (cur.classList.contains("st-children")) {
				var parentNode = cur.parentElement;
				var parentRow  = parentNode.querySelector(":scope > .st-row");
				var siblings   = Array.prototype.slice.call(cur.children);
				var checkedN = 0, indetN = 0;
				siblings.forEach(function (s) {
					var r = s.querySelector(":scope > .st-row");
					if (!r) return;
					if (r.dataset.checked === "true") checkedN++;
					else if (r.dataset.indeterminate === "true") indetN++;
				});
				if (checkedN === siblings.length) {
					parentRow.dataset.checked = "true";
					parentRow.dataset.indeterminate = "false";
				} else if (checkedN === 0 && indetN === 0) {
					parentRow.dataset.checked = "false";
					parentRow.dataset.indeterminate = "false";
				} else {
					parentRow.dataset.checked = "false";
					parentRow.dataset.indeterminate = "true";
				}
				cur = parentNode.parentElement;
			} else {
				cur = cur.parentElement;
			}
		}
	}

	function getSelectedStations() {
		var hostEl = document.getElementById("st-tree");
		if (!hostEl) return [];
		var out = [];
		hostEl.querySelectorAll('.st-node[data-id^="station:"]').forEach(function (nodeEl) {
			var row = nodeEl.querySelector(":scope > .st-row");
			if (!row || row.dataset.checked !== "true") return;
			var rest = nodeEl.dataset.id.slice("station:".length);
			var pipe = rest.indexOf("|");
			out.push({
				farm:    pipe >= 0 ? rest.slice(0, pipe) : "",
				station: pipe >= 0 ? rest.slice(pipe + 1) : rest,
				label:   nodeEl.dataset.label,
			});
		});
		return out;
	}

	/* Walks every leaf observation node ("obs:pest:Name" / "obs:disease:Name")
	   whose row is checked — including those whose parent group ("obs:group:pest")
	   was checked (propagation marked them). Returns [{kind, name, label}]. */
	function getSelectedObservations() {
		var hostEl = document.getElementById("st-obs-tree");
		if (!hostEl) return [];
		var out = [];
		hostEl.querySelectorAll('.st-node[data-id^="obs:"]').forEach(function (nodeEl) {
			var id = nodeEl.dataset.id || "";
			if (id.indexOf("obs:group:") === 0) return; // skip group parents
			var row = nodeEl.querySelector(":scope > .st-row");
			if (!row || row.dataset.checked !== "true") return;
			var rest = id.slice("obs:".length);
			var colon = rest.indexOf(":");
			out.push({
				kind:  colon >= 0 ? rest.slice(0, colon) : "",
				name:  colon >= 0 ? rest.slice(colon + 1) : rest,
				label: nodeEl.dataset.label,
			});
		});
		return out;
	}

	function _treeAllExpanded(hostEl, expanded) {
		if (!hostEl) return;
		hostEl.querySelectorAll(".st-node").forEach(function (n) {
			if (n.querySelector(":scope > .st-children")) {
				n.dataset.expanded = expanded ? "true" : "false";
			}
		});
	}

	function _treeClear(hostEl) {
		if (!hostEl) return;
		hostEl.querySelectorAll(".st-row").forEach(function (r) {
			r.dataset.checked = "false";
			r.dataset.indeterminate = "false";
		});
	}

	function _treeApplyFilter(hostEl, query) {
		if (!hostEl) return;
		var q = (query || "").trim().toLowerCase();
		function walk(nodeEl) {
			var label = (nodeEl.dataset.label || "").toLowerCase();
			var selfMatch = !q || label.indexOf(q) !== -1;
			var kidsContainer = nodeEl.querySelector(":scope > .st-children");
			var anyChildMatch = false;
			if (kidsContainer) {
				Array.prototype.slice.call(kidsContainer.children).forEach(function (c) {
					if (walk(c)) anyChildMatch = true;
				});
			}
			var visible = selfMatch || anyChildMatch;
			nodeEl.dataset.hidden = visible ? "false" : "true";
			var row = nodeEl.querySelector(":scope > .st-row");
			if (row) row.dataset.match = (q && selfMatch) ? "true" : "false";
			if (anyChildMatch && q) nodeEl.dataset.expanded = "true";
			return visible;
		}
		Array.prototype.slice.call(hostEl.children).forEach(walk);
	}

	function setTreeAllExpanded(expanded) { _treeAllExpanded(document.getElementById("st-tree"), expanded); }
	function clearTree()                  { _treeClear(document.getElementById("st-tree")); }
	function applyTreeFilter(query)       { _treeApplyFilter(document.getElementById("st-tree"), query); }
	function setObsAllExpanded(expanded)  { _treeAllExpanded(document.getElementById("st-obs-tree"), expanded); }
	function clearObsTree()               { _treeClear(document.getElementById("st-obs-tree")); }
	function applyObsTreeFilter(query)    { _treeApplyFilter(document.getElementById("st-obs-tree"), query); }

	/* ════════════════════════════════════════
	   Stage drill-down (per parent card)
	   ════════════════════════════════════════ */

	function obsId(obs) { return obs ? (obs.kind + ":" + obs.name) : ""; }

	/* Distinct stages that exist in the loaded entries for this observation —
	   so the inline checkbox row only offers stages that will actually plot. */
	function stagesForObservation(obs) {
		if (!obs) return [];
		var stages = {};
		state.filteredEntries.forEach(function (e) {
			var rows = obs.kind === "pest" ? (e.pests || []) : (e.diseases || []);
			rows.forEach(function (r) {
				var name = obs.kind === "pest" ? (r.pest || "").trim() : (r.disease || "").trim();
				if (name !== obs.name) return;
				var sg = (r.stage || "").trim();
				if (sg) stages[sg] = (stages[sg] || 0) + 1;
			});
		});
		return Object.keys(stages).sort();
	}

	function getStagePicksFor(obs) {
		var key = obsId(obs);
		return key ? (state.stagePicks[key] || []) : [];
	}

	function toggleStagePick(obs, stage) {
		var key = obsId(obs);
		if (!key) return;
		var arr = state.stagePicks[key] || [];
		var idx = arr.indexOf(stage);
		var added = idx < 0;
		if (added) arr.push(stage);
		else arr.splice(idx, 1);
		state.stagePicks[key] = arr;

		/* Locate the parent card; if it's not on screen for some reason, fall
		   back to a full re-render. */
		var panelsEl = document.getElementById("st-panels");
		var parentCard = panelsEl && Array.prototype.slice.call(panelsEl.querySelectorAll(".st-card")).filter(function (c) {
			return c.dataset.obsKey === key;
		})[0];
		if (!parentCard) { renderPanels(); return; }

		/* Sync the stage check pill's visual state. */
		var pill = Array.prototype.slice.call(parentCard.querySelectorAll(".st-stage-check")).filter(function (b) {
			return b.dataset.stage === stage;
		})[0];
		if (pill) pill.dataset.checked = added ? "true" : "false";

		var children = parentCard.querySelector(".st-card-children");
		if (!children) return;

		if (added) {
			/* Add a new child card for this stage without re-rendering anything
			   else — preserves scroll position and existing chart instances. */
			var stations = getSelectedStations();
			if (!stations.length) return;
			var days = buildDayAxisSkippingSunday(state.fromDate, state.toDate);
			var built = _buildChildCard(obs, stage, stations, days, _stationsMetaLabel(stations));
			children.appendChild(built.el);
			panelHostIds.push(built.hostId);
			built.render();
			return;
		}

		/* Removed: dispose just this child's chart and remove the element. */
		var existing = Array.prototype.slice.call(children.querySelectorAll(".st-card-child")).filter(function (c) {
			return c.dataset.stage === stage;
		})[0];
		if (!existing) return;
		var hostEl = existing.querySelector(".st-card-child-host");
		if (hostEl) {
			var inst = echartInstances[hostEl.id];
			if (inst) {
				try { inst.dispose(); } catch (e) {}
				delete echartInstances[hostEl.id];
			}
			var i = panelHostIds.indexOf(hostEl.id);
			if (i >= 0) panelHostIds.splice(i, 1);
		}
		existing.remove();
	}

	/* ════════════════════════════════════════
	   Chart rendering
	   ════════════════════════════════════════ */

	function _normalizeRow(row, kind) {
		/* Return a row with consistent shape regardless of pest vs disease. */
		if (kind === "pest") {
			return {
				name:    (row.pest          || "").trim(),
				stage:   (row.stage         || "").trim(),
				section: (row.plant_section || "").trim(),
			};
		}
		return {
			name:    (row.disease       || "").trim(),
			stage:   (row.stage         || "").trim(),
			section: (row.plant_section || "").trim(),
		};
	}

	function _entryRowsMatching(entry, filter) {
		/* Yield each child row that matches the panel filter. obs picks can be
		   a specific {kind, name} or null (meaning "all observations"). */
		var rows = [];
		var obs = filter.obs;
		if (!obs || obs.kind === "pest") {
			(entry.pests || []).forEach(function (p) { rows.push(_normalizeRow(p, "pest")); });
		}
		if (!obs || obs.kind === "disease") {
			(entry.diseases || []).forEach(function (d) { rows.push(_normalizeRow(d, "disease")); });
		}
		return rows.filter(function (r) {
			if (obs && obs.name && r.name !== obs.name) return false;
			if (filter.stage   && r.stage   !== filter.stage)   return false;
			if (filter.section && r.section !== filter.section) return false;
			return true;
		});
	}

	function buildSeriesForPanel(filter, stations, days) {
		/* filter:   { obs: {kind,name}|null, stage, section }
		   stations: [{farm, station}]
		   days:     daily YYYY-MM-DD keys with Sundays already excluded
		   Returns [{name, color, data:[Number], denom}] — one series per
		   selected station; values = % of zones/trees with ≥1 matching obs
		   that day. Falls back to 0 where the station has no unit count. */
		var dayIndex = {};
		days.forEach(function (d, i) { dayIndex[d] = i; });

		return stations.map(function (st, idx) {
			var perDay = days.map(function () { return new Set(); });
			state.filteredEntries.forEach(function (e) {
				var stStr = (e.block || e.greenhouse || "").trim();
				if (stStr !== st.station) return;
				var di = dayIndex[(e.date_of_capture || "").slice(0, 10)];
				if (di == null) return; // Sundays / out of range
				if (!_entryRowsMatching(e, filter).length) return;
				var key = unitKeyForEntry(e);
				if (key) perDay[di].add(key);
			});

			var denom = unitCountFor(st.station);
			var data = perDay.map(function (s) {
				if (denom > 0) return Number(((s.size / denom) * 100).toFixed(2));
				return 0;
			});
			return {
				name:  st.station,
				color: paletteColor(idx),
				data:  data,
				denom: denom,
			};
		});
	}

	var PALETTE = [
		"#2BA6E0", "#E66BAA", "#8466C7", "#5BB45D",
		"#E9A23B", "#3D54B0", "#E63946", "#14b8a6",
		"#f97316", "#6366f1", "#06b6d4", "#84cc16",
	];
	function paletteColor(i) { return PALETTE[i % PALETTE.length]; }

	function buildChartOption(seriesDefs, xLabels, panelTitle) {
		return {
			color: seriesDefs.map(function (s) { return s.color; }),
			textStyle: { fontFamily: '"Inter", "Helvetica Neue", Arial, sans-serif' },
			grid: { left: 56, right: 24, top: 64, bottom: 44, containLabel: false },
			legend: {
				show: seriesDefs.length > 1,
				type: "scroll",
				top: 8,
				left: 16,
				right: 16,
				icon: "roundRect",
				itemWidth: 14,
				itemHeight: 4,
				itemGap: 18,
				padding: [4, 12],
				textStyle: { color: "#374151", fontSize: 12, padding: [0, 0, 0, 4] },
				inactiveColor: "#cbd5e1",
				selectedMode: "multiple",
				data: seriesDefs.map(function (s) { return s.name; }),
			},
			legendHoverLink: true,
			/* Per-item tooltip: hovering a specific point/line shows just the
			   station name, nothing else. */
			tooltip: {
				trigger: "item",
				backgroundColor: "rgba(75,85,99,0.96)",
				borderColor: "rgba(75,85,99,0.96)",
				textStyle: { color: "#fff", fontSize: 12 },
				padding: [6, 10],
				formatter: function (params) {
					return params && params.seriesName ? params.seriesName : "";
				},
			},
			xAxis: {
				type: "category",
				boundaryGap: false,
				data: xLabels,
				axisLine: { lineStyle: { color: "rgba(0,0,0,0.15)" } },
				axisTick: { show: false },
				axisLabel: {
					color: "#64748b",
					fontSize: 11,
					interval: 0,
					hideOverlap: true,
					/* Daily x-axis with ISO-week labels: only render the label
					   on the first day of each new ISO week (and on the very
					   first day of the range). Year prefix appears on year
					   transitions so the axis stays readable across boundaries. */
					formatter: function (v, idx) {
						if (!v) return "";
						var iso = isoWeekStringForDate(v);
						var prevIso = idx > 0 ? isoWeekStringForDate(xLabels[idx - 1]) : null;
						if (prevIso === iso) return "";
						var parts = iso.split("-W");
						var year = parts[0], wk = parts[1];
						var prevYear = prevIso ? prevIso.split("-W")[0] : null;
						return (prevYear !== year ? year + " · " : "") + "W" + wk;
					},
				},
			},
			yAxis: {
				type: "value",
				min: 0,
				splitLine: { lineStyle: { color: "rgba(0,0,0,0.06)", type: "dashed" } },
				axisLine: { show: false },
				axisTick: { show: false },
				axisLabel: {
					color: "#64748b",
					fontSize: 11,
					formatter: function (v) { return Number(v).toFixed(0) + "%"; },
				},
			},
			series: seriesDefs.map(function (s) {
				return {
					name: s.name,
					type: "line",
					smooth: false,
					symbol: "circle",
					symbolSize: 5,
					showSymbol: true,
					sampling: "lttb",
					lineStyle: { width: 2 },
					/* Hovering or clicking a legend / line focuses that series:
					   thicker stroke, larger marker; everything else dims. */
					emphasis: {
						focus: "series",
						scale: false,
						lineStyle: { width: 4 },
						symbolSize: 8,
					},
					blur: {
						lineStyle: { opacity: 0.18 },
						itemStyle: { opacity: 0.18 },
					},
					data: s.data,
				};
			}),
		};
	}

	/* Compute the meta line shown on each card head. */
	function _stationsMetaLabel(stations) {
		var denomTotal = stations.reduce(function (s, st) { return s + unitCountFor(st.station); }, 0);
		var unitWord = denomTotal > 0
			? "% of zones/trees with matching observations"
			: "no zone/tree counts configured";
		return stations.length + " station" + (stations.length === 1 ? "" : "s") + " · " + unitWord;
	}

	/* Build one stage drill-down child card and its chart. Caller is
	   responsible for appending the returned element + tracking the host id. */
	function _buildChildCard(obs, stage, stations, days, stationsMeta) {
		var childFilter = { obs: obs, stage: stage, section: null };
		var childSeries = buildSeriesForPanel(childFilter, stations, days);

		var child = document.createElement("div");
		child.className = "st-card-child";
		child.dataset.stage = stage;

		var childHead = document.createElement("div");
		childHead.className = "st-card-child-head";
		var childTitle = document.createElement("div");
		childTitle.className = "st-card-child-title";
		childTitle.textContent = obs.name + " · " + stage;
		childHead.appendChild(childTitle);
		var childTag = document.createElement("span");
		childTag.className = "st-card-child-tag";
		childTag.textContent = "Stage";
		childHead.appendChild(childTag);
		var childMeta = document.createElement("div");
		childMeta.className = "st-card-child-meta";
		childMeta.textContent = stationsMeta;
		childHead.appendChild(childMeta);
		child.appendChild(childHead);

		var childHostId = "st-panel-host-" + (_hostSeq++);
		var childHost = document.createElement("div");
		childHost.className = "st-card-child-host";
		childHost.id = childHostId;
		child.appendChild(childHost);

		return {
			el: child,
			hostId: childHostId,
			render: function () {
				renderEcharts(childHost, buildChartOption(childSeries, days, childTitle.textContent));
			},
		};
	}

	function renderPanels() {
		disposePanels();
		var emptyEl  = document.getElementById("st-empty");
		var panelsEl = document.getElementById("st-panels");
		if (!panelsEl) return;
		panelsEl.innerHTML = "";

		var stations = getSelectedStations();
		if (!stations.length) {
			panelsEl.setAttribute("hidden", "");
			if (emptyEl) emptyEl.style.display = "";
			return;
		}
		if (emptyEl) emptyEl.style.display = "none";
		panelsEl.removeAttribute("hidden");

		var days = buildDayAxisSkippingSunday(state.fromDate, state.toDate);
		var observations = getSelectedObservations();
		var obsSlots = observations.length ? observations : [null];
		var stationsMeta = _stationsMetaLabel(stations);

		obsSlots.forEach(function (obs) {
			/* Parent card: this observation, no stage filter. */
			var parentFilter = { obs: obs, stage: null, section: null };
			var parentSeries = buildSeriesForPanel(parentFilter, stations, days);

			var card = document.createElement("div");
			card.className = "st-card";
			if (obs) card.dataset.obsKey = obsId(obs);

			var head = document.createElement("div");
			head.className = "st-card-head";
			var title = document.createElement("div");
			title.className = "st-card-title";
			title.textContent = obs ? obs.name : "All Observations";
			head.appendChild(title);

			var tags = document.createElement("div");
			tags.className = "st-card-tags";
			if (obs) {
				var ot = document.createElement("span");
				ot.className = "st-card-tag";
				ot.dataset.kind = "pest";
				ot.textContent = obs.kind === "disease" ? "Disease" : "Pest";
				tags.appendChild(ot);
			}
			head.appendChild(tags);

			var meta = document.createElement("div");
			meta.className = "st-card-meta";
			meta.textContent = stationsMeta;
			head.appendChild(meta);
			card.appendChild(head);

			var parentHostId = "st-panel-host-" + (_hostSeq++);
			var parentHost = document.createElement("div");
			parentHost.className = "st-card-host";
			parentHost.id = parentHostId;
			card.appendChild(parentHost);

			/* Inline stage drill-down — only when we have a specific obs (not
			   the "All" panel). Empty when this observation has no recorded
			   stages, with a quiet hint. */
			if (obs) {
				var stageRow = document.createElement("div");
				stageRow.className = "st-card-stages";
				var stageLabel = document.createElement("div");
				stageLabel.className = "st-card-stages-label";
				stageLabel.textContent = "Drill into stages";
				stageRow.appendChild(stageLabel);

				var stageList = document.createElement("div");
				stageList.className = "st-stage-checks";
				var availableStages = stagesForObservation(obs);
				var pickedStages = new Set(getStagePicksFor(obs));

				if (!availableStages.length) {
					var emptyHint = document.createElement("div");
					emptyHint.className = "st-stage-check-empty";
					emptyHint.textContent = "no stage data recorded for this observation";
					stageList.appendChild(emptyHint);
				} else {
					availableStages.forEach(function (sg) {
						var check = document.createElement("button");
						check.type = "button";
						check.className = "st-stage-check";
						check.dataset.stage = sg;
						check.dataset.checked = pickedStages.has(sg) ? "true" : "false";
						check.innerHTML =
							'<span class="st-stage-check-box">' + TT_CHECK + '</span>'
							+ '<span class="st-stage-check-name"></span>';
						check.querySelector(".st-stage-check-name").textContent = sg;
						check.addEventListener("click", function (ev) {
							ev.stopPropagation();
							toggleStagePick(obs, sg);
						});
						stageList.appendChild(check);
					});
				}
				stageRow.appendChild(stageList);
				card.appendChild(stageRow);
			}

			/* Children container — one nested card per picked stage. */
			var children = document.createElement("div");
			children.className = "st-card-children";
			card.appendChild(children);

			panelsEl.appendChild(card);
			panelHostIds.push(parentHostId);
			renderEcharts(parentHost, buildChartOption(parentSeries, days, title.textContent));

			if (obs) {
				getStagePicksFor(obs).forEach(function (stage) {
					var built = _buildChildCard(obs, stage, stations, days, stationsMeta);
					children.appendChild(built.el);
					panelHostIds.push(built.hostId);
					built.render();
				});
			}
		});
	}

	/* ════════════════════════════════════════
	   Tree binding
	   ════════════════════════════════════════ */

	function rebuildTree() {
		var options = gatherOptions();
		state.options = options;

		renderTree(document.getElementById("st-tree"), buildTreeNodes(options), function () {
			renderPanels();
			updateNavCounts();
		});

		renderTree(document.getElementById("st-obs-tree"), buildObsTreeNodes(options), function () {
			renderPanels();
			updateNavCounts();
		});

		renderPanels();
		updateNavCounts();
	}

	/* ════════════════════════════════════════
	   Wire up controls
	   ════════════════════════════════════════ */

	/* Debounced reload so flatpickr's per-keystroke onChange events don't
	   fire a network request every typed digit. */
	var _reloadTimer = null;
	function debouncedReload() {
		if (_reloadTimer) clearTimeout(_reloadTimer);
		_reloadTimer = setTimeout(function () { _reloadTimer = null; reload(); }, 250);
	}

	function bindHeader() {
		var fromEl = document.getElementById("st-from");
		var toEl   = document.getElementById("st-to");
		var refresh = document.getElementById("st-refresh");

		var def = defaultDateRange();
		state.fromDate = def.from;
		state.toDate   = def.to;
		fromEl.value = def.from;
		toEl.value   = def.to;

		function onDateInputChange() {
			state.fromDate = fromEl.value;
			state.toDate   = toEl.value;
			debouncedReload();
		}

		/* Take ownership of flatpickr on these inputs so we can switch on
		   weekNumbers (the ISO-week column) and forward onChange to reload.
		   Marker tells map_base.html's global initializer to skip them. */
		function initLocalFlatpickr() {
			if (typeof flatpickr === "undefined") {
				/* flatpickr loads later in some contexts — try again on `load`. */
				window.addEventListener("load", initLocalFlatpickr, { once: true });
				return;
			}
			[fromEl, toEl].forEach(function (el) {
				if (el._flatpickr) el._flatpickr.destroy();
				el.setAttribute("data-fp-init", "1");
				flatpickr(el, {
					dateFormat: "Y-m-d",
					allowInput: true,
					disableMobile: true,
					weekNumbers: true,
					locale: { firstDayOfWeek: 1 },  /* Mon = 1, so the week column lines up with ISO weeks */
					onChange: onDateInputChange,
				});
			});
		}
		initLocalFlatpickr();

		/* Native fallback covers typed-and-blur cases or browsers without
		   flatpickr. The debounce keeps duplicate fires harmless. */
		[fromEl, toEl].forEach(function (el) {
			el.addEventListener("change", onDateInputChange);
		});

		refresh.addEventListener("click", function () {
			/* Reload button = "give me fresh data" — drop the local month
			   cache so we re-hit the server (which still benefits from its
			   Redis cache, invalidated by Scouting Entry change hooks). */
			monthCache = { key: "", months: {} };
			metaCache = null;
			reload();
		});

		var cropEl = document.getElementById("st-crop");
		if (cropEl) {
			cropEl.addEventListener("change", function () {
				state.crop = cropEl.value || "Rose";
				/* Crop change shifts the data set the trees and panels read
				   from; rebuild from filteredEntries without re-fetching. */
				applyCropFilter();
				rebuildTree();
			});
		}
	}

	function bindTreeControls() {
		document.querySelectorAll('[data-tree-action]').forEach(function (btn) {
			btn.addEventListener("click", function (ev) {
				ev.stopPropagation();
				var act = btn.dataset.treeAction;
				if      (act === "expand-all")   setTreeAllExpanded(true);
				else if (act === "collapse-all") setTreeAllExpanded(false);
				else if (act === "clear")        { clearTree(); renderPanels(); updateNavCounts(); }
			});
		});
		document.querySelectorAll('[data-obs-action]').forEach(function (btn) {
			btn.addEventListener("click", function (ev) {
				ev.stopPropagation();
				var act = btn.dataset.obsAction;
				if      (act === "expand-all")   setObsAllExpanded(true);
				else if (act === "collapse-all") setObsAllExpanded(false);
				else if (act === "clear")        { clearObsTree(); renderPanels(); updateNavCounts(); }
			});
		});

		var search = document.getElementById("st-tree-search");
		if (search) {
			search.addEventListener("input", function () { applyTreeFilter(search.value); });
			search.addEventListener("click", function (ev) { ev.stopPropagation(); });
		}
		var obsSearch = document.getElementById("st-obs-search");
		if (obsSearch) {
			obsSearch.addEventListener("input", function () { applyObsTreeFilter(obsSearch.value); });
			obsSearch.addEventListener("click", function (ev) { ev.stopPropagation(); });
		}
	}

	/* ─── Header dropdown popovers ─── */

	function closeAllNavPopovers() {
		document.querySelectorAll(".st-nav-popover").forEach(function (p) { p.setAttribute("hidden", ""); });
		document.querySelectorAll(".st-nav-btn").forEach(function (b) { b.setAttribute("aria-expanded", "false"); });
	}

	function toggleNavPopover(dropdownEl) {
		var btn = dropdownEl.querySelector(".st-nav-btn");
		var pop = document.getElementById(dropdownEl.dataset.popoverId);
		if (!btn || !pop) return;
		var open = btn.getAttribute("aria-expanded") === "true";
		closeAllNavPopovers();
		if (!open) {
			pop.removeAttribute("hidden");
			btn.setAttribute("aria-expanded", "true");
		}
	}

	function bindNavDropdowns() {
		document.querySelectorAll(".st-nav-dropdown").forEach(function (dd) {
			var btn = dd.querySelector(".st-nav-btn");
			if (btn) {
				btn.addEventListener("click", function (ev) {
					ev.stopPropagation();
					toggleNavPopover(dd);
				});
			}
			var pop = document.getElementById(dd.dataset.popoverId);
			if (pop) pop.addEventListener("click", function (ev) { ev.stopPropagation(); });
		});
		document.addEventListener("click", function () { closeAllNavPopovers(); });
		document.addEventListener("keydown", function (ev) {
			if (ev.key === "Escape") closeAllNavPopovers();
		});
	}

	function updateNavCounts() {
		var stationCount = getSelectedStations().length;
		var obsCount     = getSelectedObservations().length;
		var stEl = document.getElementById("st-stations-count");
		var obEl = document.getElementById("st-obs-count");
		if (stEl) {
			stEl.textContent = stationCount;
			stEl.dataset.active = stationCount > 0 ? "true" : "false";
		}
		if (obEl) {
			obEl.textContent = obsCount;
			obEl.dataset.active = obsCount > 0 ? "true" : "false";
		}
	}

	/* ════════════════════════════════════════
	   Top-level lifecycle
	   ════════════════════════════════════════ */

	function reload() {
		showLoader("Loading observations…");
		Promise.all([loadEcharts(), fetchScoutingData()])
			.then(function (results) {
				var payload = results[1] || {};
				ingestStationMeta(payload);
				state.entries = Array.isArray(payload.entries) ? payload.entries : [];
				renderCropOptions();
				applyCropFilter();
				rebuildTree();
			})
			.catch(function (err) {
				console.error("scouting_trends: load failed", err);
				var emptyEl = document.getElementById("st-empty");
				if (emptyEl) {
					emptyEl.style.display = "";
					emptyEl.querySelector(".st-empty-title").textContent = "Couldn't load data";
					var msg = "Unknown error.";
					if (err) {
						if (err.responseJSON && (err.responseJSON.exc_type || err.responseJSON._server_messages)) {
							msg = err.responseJSON.exc_type || err.responseJSON._server_messages;
						} else if (err.statusText) {
							msg = err.statusText + (err.status ? " (" + err.status + ")" : "");
						} else if (err.message) {
							msg = err.message;
						} else if (typeof err === "string") {
							msg = err;
						}
					}
					emptyEl.querySelector(".st-empty-text").textContent = String(msg).slice(0, 240) + " — see console for details.";
				}
			})
			.then(function () { hideLoader(); });
	}

	function init() {
		bindHeader();
		bindTreeControls();
		bindNavDropdowns();
		reload();
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	} else {
		init();
	}
})();
