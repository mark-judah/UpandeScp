/* ================================================================
   Spray Plan Approval — Page JS
   ================================================================ */

// ── API helper (www pages don't guarantee frappe global) ──────────────────────
function _call(method, args) {
  var token = (window.frappe && window.frappe.csrf_token) || window._spaCSRF || "";
  return fetch("/api/method/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Frappe-CSRF-Token": token },
    body: JSON.stringify(args || {})
  }).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }).then(function (data) {
    if (data.exc) throw new Error(data.exc);
    return data;
  });
}

// ── API paths ─────────────────────────────────────────────────────────────────
var API = {
  GET_WO:    "upande_scp.serverscripts.spray_plan_approval.get_pending_work_orders",
  GET_FARMS: "upande_scp.serverscripts.spray_plan_approval.get_farms_and_greenhouses",
  APPROVE:   "upande_scp.serverscripts.spray_plan_approval.approve_single_work_order",
  STOP:      "upande_scp.serverscripts.spray_plan_approval.stop_single_work_order",
  SCOUTING:  "upande_scp.serverscripts.get_scouting_report.getScoutingData",
};

// ── State ─────────────────────────────────────────────────────────────────────
var _allWos       = [];          // All loaded WOs
var _visibleWos   = [];          // Currently shown (after tab filter)
var _expanded     = new Set();   // Expanded row names
var _checked      = new Set();   // Checked WO names
var _statusFilter = "pending";   // "pending" | "forwarded" | "all"
var _scoutCache   = {};          // gh → scouting data
var _allQrLabels  = [];          // Accumulated QR labels from approval run

// ── Bootstrap ─────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", function () {
  _setDefaultDates();
  _bindEvents();
  _loadFarmsAndGreenhouses();
  loadWorkOrders();
});

// ── Date defaults ─────────────────────────────────────────────────────────────
function _setDefaultDates() {
  var today = _todayISO();
  document.getElementById("f-from").value = today;
  document.getElementById("f-to").value   = today;
}

function _todayISO() {
  var d = new Date(), mm = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + mm + "-" + dd;
}

// ── Event bindings ────────────────────────────────────────────────────────────
function _bindEvents() {
  document.getElementById("btn-load").addEventListener("click", loadWorkOrders);
  document.getElementById("btn-clear").addEventListener("click", _clearFilters);
  document.getElementById("btn-show-all").addEventListener("click", function () { _clearFilters(); loadWorkOrders(); });
  document.getElementById("btn-retry").addEventListener("click", loadWorkOrders);

  document.getElementById("f-farm").addEventListener("change", _onFarmChange);

  // Enter key on date inputs
  ["f-from", "f-to"].forEach(function (id) {
    document.getElementById(id).addEventListener("keydown", function (e) {
      if (e.key === "Enter") loadWorkOrders();
    });
  });

  // Status tabs
  document.querySelectorAll(".spa-tab[data-filter]").forEach(function (btn) {
    btn.addEventListener("click", function () { _setStatusFilter(btn.dataset.filter); });
  });

  // Select all checkbox
  document.getElementById("spa-select-all").addEventListener("change", _onSelectAll);

  // Approve / Stop buttons
  document.getElementById("btn-approve").addEventListener("click", _onApprove);
  document.getElementById("btn-stop").addEventListener("click", _onStopClick);
  document.getElementById("btn-confirm-stop").addEventListener("click", _onConfirmStop);
  document.getElementById("btn-dismiss-stop").addEventListener("click", _dismissStopConfirm);

  // Progress close
  document.getElementById("btn-pp-close").addEventListener("click", _closeProgressPanel);

  // Heatmap overlay close on background click
  document.getElementById("hmv-overlay").addEventListener("click", function (e) {
    if (e.target === this) _closeHeatmap();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") _closeHeatmap();
  });
}

function _clearFilters() {
  document.getElementById("f-from").value = "";
  document.getElementById("f-to").value   = "";
  document.getElementById("f-farm").value = "";
  _onFarmChange();
}

// ── Farms & Greenhouses ───────────────────────────────────────────────────────
var _ghByFarm = {};

function _loadFarmsAndGreenhouses() {
  _call(API.GET_FARMS)
    .then(function (r) {
      var data = r.message || {};
      _ghByFarm = data.greenhouses_by_farm || {};
      var farmSel = document.getElementById("f-farm");
      // Clear and repopulate
      while (farmSel.options.length > 1) farmSel.remove(1);
      (data.farms || []).forEach(function (f) {
        var opt = document.createElement("option");
        opt.value = f; opt.textContent = f;
        farmSel.appendChild(opt);
      });
    })
    .catch(function () {});  // Silently fail — filters still work
}

function _onFarmChange() {
  var farm = document.getElementById("f-farm").value;
  var ghSel = document.getElementById("f-gh");
  while (ghSel.options.length > 1) ghSel.remove(1);

  if (farm && _ghByFarm[farm]) {
    ghSel.disabled = false;
    _ghByFarm[farm].forEach(function (gh) {
      var opt = document.createElement("option");
      opt.value = gh; opt.textContent = gh;
      ghSel.appendChild(opt);
    });
  } else {
    ghSel.disabled = true;
    ghSel.value = "";
  }
}

// ── Load Work Orders ──────────────────────────────────────────────────────────
function loadWorkOrders() {
  _showState("loading");
  _allWos = [];
  _visibleWos = [];
  _checked.clear();
  _expanded.clear();

  var args = {
    from_date:  document.getElementById("f-from").value  || null,
    to_date:    document.getElementById("f-to").value    || null,
    farm:       document.getElementById("f-farm").value  || null,
    greenhouse: document.getElementById("f-gh").value    || null,
  };

  _call(API.GET_WO, args)
    .then(function (r) {
      var data = r.message || {};
      _allWos = data.work_orders || [];

      if (!_allWos.length) {
        _showState("empty");
        document.getElementById("spa-empty-msg").textContent =
          (args.from_date || args.to_date || args.farm || args.greenhouse)
            ? "No spray plans found for these filters."
            : "No pending spray plans found.";
        _updateTabCounts(0, 0);
        _updateHeaderStats(0, 0);
        return;
      }

      var pending   = _allWos.filter(function (w) { return !w.is_forwarded; }).length;
      var forwarded = _allWos.length - pending;
      _updateTabCounts(pending, forwarded);
      _updateHeaderStats(pending, forwarded);
      _applyStatusFilter(_statusFilter, true);
    })
    .catch(function (err) {
      _showState("error");
      document.getElementById("spa-error-msg").textContent =
        "Failed to load work orders. Check your connection or permissions.";
      console.error("[SPA] Load error:", err);
    });
}

// ── Status filter & tabs ──────────────────────────────────────────────────────
function _setStatusFilter(filter) {
  _statusFilter = filter;
  document.querySelectorAll(".spa-tab[data-filter]").forEach(function (btn) {
    btn.classList.toggle("active", btn.dataset.filter === filter);
  });
  _applyStatusFilter(filter, false);
}

function _applyStatusFilter(filter, firstLoad) {
  if (filter === "pending") {
    _visibleWos = _allWos.filter(function (w) { return !w.is_forwarded; });
  } else if (filter === "forwarded") {
    _visibleWos = _allWos.filter(function (w) { return  w.is_forwarded; });
  } else {
    _visibleWos = _allWos.slice();
  }

  // Remove checked items that are no longer visible
  var visNames = new Set(_visibleWos.map(function (w) { return w.name; }));
  _checked.forEach(function (n) { if (!visNames.has(n)) _checked.delete(n); });

  if (!_visibleWos.length) {
    _showState("empty");
    document.getElementById("spa-empty-msg").textContent = filter === "pending"
      ? "No pending spray plans — all have been forwarded."
      : filter === "forwarded"
        ? "No forwarded plans in this selection."
        : "No work orders match the current filters.";
  } else {
    _showState("table");
    _renderTable();
  }

  _updateSelectionUI();
}

// ── Table rendering ───────────────────────────────────────────────────────────
function _renderTable() {
  var tbody = document.getElementById("spa-tbody");
  tbody.innerHTML = "";

  _visibleWos.forEach(function (wo) {
    tbody.appendChild(_buildMainRow(wo));
    tbody.appendChild(_buildDetailRow(wo));
    if (_expanded.has(wo.name)) {
      _showDetailRow(wo.name);
    }
  });

  var lbl = document.getElementById("spa-count-label");
  lbl.textContent = _visibleWos.length + " work order" + (_visibleWos.length !== 1 ? "s" : "");
  _syncSelectAll();
}

function _buildMainRow(wo) {
  var tr = document.createElement("tr");
  tr.className = "spa-row" + (_checked.has(wo.name) ? " selected" : "");
  tr.dataset.wo = wo.name;

  var schedDate = wo.custom_scheduled_application_time
    ? wo.custom_scheduled_application_time.split(" ")[0] : "—";
  var chemCount = (wo.required_items || []).length;

  tr.innerHTML =
    '<td class="td-check"><input type="checkbox" class="wo-check" data-wo="' + _esc(wo.name) + '"' +
      (_checked.has(wo.name) ? " checked" : "") + '></td>' +
    '<td><a href="/app/work-order/' + _esc(wo.name) + '" target="_blank" class="spa-wo-link">' + _esc(wo.name) + '</a></td>' +
    '<td>' + _esc(wo.custom_greenhouse || "—") + '</td>' +
    '<td><span class="spa-sched-badge">' + _esc(schedDate) + '</span></td>' +
    '<td>' + (wo.custom_spray_type ? '<span class="spa-type-tag" title="' + _esc(wo.custom_spray_type) + '">' + _esc(wo.custom_spray_type) + '</span>' : '<span style="color:#9ca3af">—</span>') + '</td>' +
    '<td><span class="spa-chem-count">' + chemCount + '</span></td>' +
    '<td>' + _statusBadge(wo.is_forwarded) + '</td>' +
    '<td><button class="spa-toggle-btn" data-wo="' + _esc(wo.name) + '" title="Show details">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14"><polyline points="6 9 12 15 18 9"/></svg>' +
    '</button></td>';

  // Checkbox change
  var cb = tr.querySelector(".wo-check");
  cb.addEventListener("change", function () {
    if (cb.checked) _checked.add(wo.name); else _checked.delete(wo.name);
    tr.classList.toggle("selected", cb.checked);
    _syncSelectAll();
    _updateSelectionUI();
  });

  // Row click (except checkbox, link, toggle)
  tr.addEventListener("click", function (e) {
    if (e.target.type === "checkbox" || e.target.closest("a") || e.target.closest(".spa-toggle-btn")) return;
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event("change"));
  });

  // Toggle button
  var toggleBtn = tr.querySelector(".spa-toggle-btn");
  toggleBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    _toggleDetail(wo.name, toggleBtn);
  });

  return tr;
}

function _buildDetailRow(wo) {
  var tr = document.createElement("tr");
  tr.className = "spa-detail-row hidden";
  tr.dataset.detail = wo.name;

  var td = document.createElement("td");
  td.colSpan = 8;
  td.appendChild(_buildDetailInner(wo));
  tr.appendChild(td);
  return tr;
}

function _buildDetailInner(wo) {
  var div = document.createElement("div");
  div.className = "spa-detail-inner";

  var scopeVal = [wo.custom_scope, wo.custom_scope_details].filter(Boolean).join(" — ");

  // Details grid
  var grid = document.createElement("div");
  grid.className = "spa-detail-grid";
  [
    ["Scope",        scopeVal || "—"],
    ["Area",         wo.custom_area          ? wo.custom_area + " Ha"          : "—"],
    ["Water Volume", wo.custom_water_volume   ? wo.custom_water_volume + " L"   : "—"],
    ["Water pH",     wo.custom_water_ph       || "—"],
    ["Hardness",     wo.custom_water_hardness ? wo.custom_water_hardness + " ppm" : "—"],
    ["Kit",          wo.custom_kit            || "—"],
    ["CSU / WIP",    wo.wip_warehouse         || "—"],
    ["Created",      wo.creation ? new Date(wo.creation).toLocaleDateString("en-GB", {day:"numeric",month:"short",year:"numeric"}) : "—"],
  ].forEach(function (pair) {
    grid.innerHTML += '<div class="spa-detail-item">' +
      '<span class="spa-detail-label">' + pair[0] + '</span>' +
      '<span class="spa-detail-value">' + _esc(pair[1]) + '</span></div>';
  });
  div.appendChild(grid);

  // Chemicals
  var items = wo.required_items || [];
  if (items.length) {
    var chemSec = document.createElement("div");
    chemSec.className = "spa-chem-section";
    chemSec.innerHTML = '<div class="spa-section-label">Chemicals (' + items.length + ')</div>';
    var tbl = document.createElement("table");
    tbl.className = "spa-chem-table";
    tbl.innerHTML = '<thead><tr><th>Item Name</th><th>Item Code</th><th style="text-align:right">Qty</th><th>UoM</th></tr></thead>';
    var tbody = document.createElement("tbody");
    items.forEach(function (it) {
      var tr = document.createElement("tr");
      tr.innerHTML = '<td>' + _esc(it.item_name || it.item_code) + '</td>' +
        '<td style="color:#6b7280;font-size:.75rem">' + _esc(it.item_code) + '</td>' +
        '<td style="text-align:right;font-weight:700">' + _fmtQty(it.required_qty) + '</td>' +
        '<td>' + _esc(it.stock_uom || "") + '</td>';
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    chemSec.appendChild(tbl);
    div.appendChild(chemSec);
  }

  // Targets
  var targets = _parseTargets(wo.custom_targets);
  if (targets.length) {
    var tgtSec = document.createElement("div");
    tgtSec.className = "spa-targets-section";
    tgtSec.innerHTML = '<div class="spa-section-label">Targets <span style="font-size:.62rem;font-weight:400;color:#9ca3af;margin-left:4px">click pill to view heatmap</span></div>';
    var pills = document.createElement("div");
    pills.className = "spa-pills";
    targets.forEach(function (t) {
      var p = document.createElement("span");
      p.className = "spa-pill";
      p.textContent = t;
      p.addEventListener("click", function (e) { e.stopPropagation(); _openHeatmap(wo.custom_greenhouse || "", t); });
      pills.appendChild(p);
    });
    tgtSec.appendChild(pills);
    div.appendChild(tgtSec);
  }

  return div;
}

function _statusBadge(isForwarded) {
  if (isForwarded) {
    return '<span class="spa-status-badge forwarded"><span class="status-dot"></span>Forwarded</span>';
  }
  return '<span class="spa-status-badge pending"><span class="status-dot"></span>Pending</span>';
}

// ── Row expand / collapse ─────────────────────────────────────────────────────
function _toggleDetail(woName, btn) {
  if (_expanded.has(woName)) {
    _expanded.delete(woName);
    _hideDetailRow(woName);
    btn.classList.remove("open");
  } else {
    _expanded.add(woName);
    _showDetailRow(woName);
    btn.classList.add("open");
  }
}

function _showDetailRow(woName) {
  var row = document.querySelector(".spa-detail-row[data-detail='" + _escSel(woName) + "']");
  if (row) row.classList.remove("hidden");
}

function _hideDetailRow(woName) {
  var row = document.querySelector(".spa-detail-row[data-detail='" + _escSel(woName) + "']");
  if (row) row.classList.add("hidden");
}

// ── Select all ────────────────────────────────────────────────────────────────
function _onSelectAll() {
  var checked = document.getElementById("spa-select-all").checked;
  _visibleWos.forEach(function (wo) {
    if (checked) _checked.add(wo.name); else _checked.delete(wo.name);
  });
  document.querySelectorAll(".wo-check").forEach(function (cb) {
    cb.checked = checked;
    var tr = cb.closest(".spa-row");
    if (tr) tr.classList.toggle("selected", checked);
  });
  _updateSelectionUI();
}

function _syncSelectAll() {
  var total   = _visibleWos.length;
  var checked = _visibleWos.filter(function (w) { return _checked.has(w.name); }).length;
  var selAll  = document.getElementById("spa-select-all");
  selAll.checked       = checked > 0 && checked === total;
  selAll.indeterminate = checked > 0 && checked < total;
}

function _updateSelectionUI() {
  var count = _checked.size;
  document.getElementById("spa-sel-count").textContent = count;
  document.getElementById("btn-approve").disabled = count === 0;
  document.getElementById("btn-stop").disabled    = count === 0;
  if (count === 0) _dismissStopConfirm();
}

// ── State display ─────────────────────────────────────────────────────────────
function _showState(which) {
  ["loading", "empty", "error", "table"].forEach(function (s) {
    var el = document.getElementById("spa-state-" + s);
    if (el) el.classList.toggle("hidden", s !== which);
  });
}

// ── Tab counts & header stats ─────────────────────────────────────────────────
function _updateTabCounts(pending, forwarded) {
  document.getElementById("tab-count-pending").textContent   = pending;
  document.getElementById("tab-count-forwarded").textContent = forwarded;
  document.getElementById("tab-count-all").textContent       = pending + forwarded;
}

function _updateHeaderStats(pending, forwarded) {
  var el = document.getElementById("spa-header-stats");
  el.innerHTML = "";
  if (pending > 0) {
    el.innerHTML += '<span class="spa-stat-chip pending"><span class="dot"></span>' + pending + ' pending</span>';
  }
  if (forwarded > 0) {
    el.innerHTML += '<span class="spa-stat-chip forwarded"><span class="dot"></span>' + forwarded + ' forwarded</span>';
  }
}

// ── Stop confirmation ─────────────────────────────────────────────────────────
function _onStopClick() {
  var selected = Array.from(_checked);
  if (!selected.length) return;
  var confirm = document.getElementById("spa-stop-confirm");
  confirm.querySelector(".spa-confirm-text").textContent =
    "Stop " + selected.length + " work order" + (selected.length !== 1 ? "s" : "") +
    "? This sets their status to Stopped and cannot be undone.";
  confirm.classList.remove("hidden");
}

function _dismissStopConfirm() {
  document.getElementById("spa-stop-confirm").classList.add("hidden");
}

function _onConfirmStop() {
  _dismissStopConfirm();
  var selected = Array.from(_checked);
  if (selected.length) _runStop(selected);
}

function _onApprove() {
  var selected = Array.from(_checked);
  if (selected.length) _runApproval(selected);
}

// ── Approval flow ─────────────────────────────────────────────────────────────
function _runApproval(woNames) {
  _allQrLabels = [];
  _showProgressPanel("Approving " + woNames.length + " spray plan" + (woNames.length !== 1 ? "s" : "") + "...", false);
  _setProgressFill(0, false);

  var done = 0, okCount = 0, errCount = 0;

  function next(i) {
    if (i >= woNames.length) {
      _setProgressFill(100, false);
      var color = errCount === 0 ? "#34d399" : errCount === woNames.length ? "#f87171" : "#fbbf24";
      _setProgressTitle("Done — " + okCount + " approved, " + errCount + " failed.", color);
      document.getElementById("btn-pp-close").classList.remove("hidden");
      if (_allQrLabels.length) _showQrSection(_allQrLabels);
      // Reload to reflect new forwarded status
      setTimeout(loadWorkOrders, 800);
      return;
    }

    var woName = woNames[i];
    _call(API.APPROVE, { wo_name: woName })
      .then(function (r) {
        var res = r.message || {};
        done++;
        if (res.status === "approved") {
          okCount++;
          _addLog(
            "&#10003; <strong>" + _esc(woName) + "</strong> — " +
            "SE <a href='/app/stock-entry/" + _esc(res.se) + "' target='_blank' style='color:#34d399'>" + _esc(res.se) + "</a> " +
            "raised to <strong>" + _esc(res.warehouse || "WIP") + "</strong>" +
            (res.qr_labels && res.qr_labels.length ? " · " + res.qr_labels.length + " QR label" + (res.qr_labels.length > 1 ? "s" : "") : ""),
            "log-ok"
          );
          if (res.qr_labels) res.qr_labels.forEach(function (lbl) {
            lbl.wo = woName;
            _allQrLabels.push(lbl);
          });
        } else if (res.status === "already_forwarded") {
          _addLog("&#9432; <strong>" + _esc(woName) + "</strong> — " + _esc(res.message || "Already forwarded."), "log-warn");
          okCount++;
        } else if (res.status === "skipped") {
          _addLog("&#8212; <strong>" + _esc(woName) + "</strong> — " + _esc(res.message || "Skipped."), "log-skip");
        } else {
          errCount++;
          _addLog("&#10007; <strong>" + _esc(woName) + "</strong> — " + _esc(res.message || "Unknown error."), "log-err");
        }
      })
      .catch(function () {
        done++; errCount++;
        _addLog("&#10007; <strong>" + _esc(woName) + "</strong> — Could not connect to server.", "log-err");
      })
      .finally(function () {
        _setProgressFill(Math.round((done / woNames.length) * 100), false);
        next(i + 1);
      });
  }

  next(0);
}

// ── Stop flow ─────────────────────────────────────────────────────────────────
function _runStop(woNames) {
  _showProgressPanel("Stopping " + woNames.length + " work order" + (woNames.length !== 1 ? "s" : "") + "...", true);
  _setProgressFill(0, true);

  var done = 0, okCount = 0, errCount = 0;

  function next(i) {
    if (i >= woNames.length) {
      _setProgressFill(100, true);
      var color = errCount === 0 ? "#f87171" : errCount === woNames.length ? "#f87171" : "#fbbf24";
      _setProgressTitle("Done — " + okCount + " stopped, " + errCount + " failed.", color);
      document.getElementById("btn-pp-close").classList.remove("hidden");
      setTimeout(loadWorkOrders, 800);
      return;
    }

    var woName = woNames[i];
    _call(API.STOP, { wo_name: woName })
      .then(function (r) {
        var res = r.message || {};
        done++;
        if (res.status === "stopped") {
          okCount++;
          _addLog("&#9632; <strong>" + _esc(woName) + "</strong> — stopped successfully.", "log-warn");
        } else {
          errCount++;
          _addLog("&#10007; <strong>" + _esc(woName) + "</strong> — " + _esc(res.message || "Failed."), "log-err");
        }
      })
      .catch(function () {
        done++; errCount++;
        _addLog("&#10007; <strong>" + _esc(woName) + "</strong> — Could not connect to server.", "log-err");
      })
      .finally(function () {
        _setProgressFill(Math.round((done / woNames.length) * 100), true);
        next(i + 1);
      });
  }

  next(0);
}

// ── Progress panel ────────────────────────────────────────────────────────────
function _showProgressPanel(title, isStop) {
  var panel = document.getElementById("spa-progress-panel");
  panel.classList.remove("hidden");
  document.getElementById("spa-pp-title").textContent = title;
  document.getElementById("spa-pp-title").style.color = "";
  document.getElementById("btn-pp-close").classList.add("hidden");
  document.getElementById("spa-pp-log").innerHTML = "";
  document.getElementById("spa-pp-qr").classList.add("hidden");
  document.getElementById("spa-pp-qr").innerHTML = "";
  var fill = document.getElementById("spa-pp-fill");
  fill.classList.toggle("stop", isStop);
  fill.style.width = "0%";
}

function _closeProgressPanel() {
  document.getElementById("spa-progress-panel").classList.add("hidden");
}

function _setProgressFill(pct, isStop) {
  var fill = document.getElementById("spa-pp-fill");
  fill.style.width = pct + "%";
  fill.classList.toggle("stop", isStop);
}

function _setProgressTitle(text, color) {
  var el = document.getElementById("spa-pp-title");
  el.textContent = text;
  if (color) el.style.color = color;
}

function _addLog(html, cssClass) {
  var log  = document.getElementById("spa-pp-log");
  var line = document.createElement("div");
  if (cssClass) line.className = cssClass;
  line.innerHTML = html;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

// ── QR section (inside progress panel) ───────────────────────────────────────
function _showQrSection(labels) {
  if (!labels.length) return;
  var qrDiv = document.getElementById("spa-pp-qr");
  qrDiv.classList.remove("hidden");

  var header = document.createElement("div");
  header.className = "spa-pp-qr-header";
  var title = document.createElement("span");
  title.className = "spa-pp-qr-title";
  title.textContent = labels.length + " QR label" + (labels.length !== 1 ? "s" : "") + " generated";
  var printBtn = document.createElement("button");
  printBtn.className = "spa-btn spa-btn-approve";
  printBtn.style.cssText = "padding:5px 14px;font-size:.76rem;";
  printBtn.textContent = "Print Labels";
  printBtn.addEventListener("click", function () { _openQrPrintWindow(labels); });
  header.appendChild(title);
  header.appendChild(printBtn);
  qrDiv.appendChild(header);

  var strip = document.createElement("div");
  strip.className = "spa-pp-qr-strip";
  labels.slice(0, 8).forEach(function (lbl) {
    var chip = document.createElement("div");
    chip.className = "spa-qr-thumb";
    var img = document.createElement("img");
    img.src = "data:image/png;base64," + lbl.png_base64;
    var info = document.createElement("div");
    var cn = document.createElement("div");
    cn.style.cssText = "font-weight:700;color:#f9fafb;font-size:.7rem;white-space:nowrap;max-width:100px;overflow:hidden;text-overflow:ellipsis;";
    cn.textContent = lbl.chemical;
    var cm = document.createElement("div");
    cm.style.color = "#9ca3af";
    cm.textContent = lbl.qty + " " + lbl.uom;
    info.appendChild(cn);
    info.appendChild(cm);
    chip.appendChild(img);
    chip.appendChild(info);
    strip.appendChild(chip);
  });
  if (labels.length > 8) {
    var more = document.createElement("div");
    more.style.cssText = "display:flex;align-items:center;color:#9ca3af;font-size:.72rem;";
    more.textContent = "+" + (labels.length - 8) + " more";
    strip.appendChild(more);
  }
  qrDiv.appendChild(strip);
}

// ── QR Print Window ───────────────────────────────────────────────────────────
function _openQrPrintWindow(labels) {
  var win = window.open("", "_blank", "width=980,height=740");
  if (!win) {
    alert("Pop-ups are blocked. Allow pop-ups for this site to print labels.");
    return;
  }

  var rows = labels.map(function (lbl) {
    return "<div class='label'>" +
      "<div class='lhd'><div class='ltitle'>" + _esc(lbl.chemical) + "</div>" +
      "<div class='lsub'>" + _esc(lbl.wo || "") + "</div></div>" +
      "<div class='lbody'>" +
      "<img src='data:image/png;base64," + lbl.png_base64 + "' class='qrimg'>" +
      "<div class='lmeta'>" +
      _metaRow("Stock Entry", lbl.se || "—") +
      _metaRow("Quantity",    lbl.qty + " " + lbl.uom) +
      _metaRow("Warehouse",   lbl.src_wh || "—") +
      _metaRow("Date",        new Date().toLocaleDateString("en-GB")) +
      "</div></div>" +
      "<div class='lfooter'>Scan to verify at transfer checkpoint</div>" +
      "</div>";
  }).join("");

  win.document.write(
    "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Chemical QR Labels</title><style>" +
    "*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Helvetica Neue',Arial,sans-serif;background:#f3f4f6;padding:20px}" +
    "@media print{body{background:#fff;padding:0}.no-print{display:none!important}.label{break-inside:avoid;box-shadow:none;border:1.5px solid #000}}" +
    ".toolbar{display:flex;gap:10px;align-items:center;margin-bottom:20px;padding:12px 16px;background:#1f2937;border-radius:8px;color:#fff}" +
    ".toolbar h2{flex:1;font-size:.95rem;font-weight:700}" +
    ".toolbar button{padding:8px 18px;border:none;border-radius:6px;font-weight:600;font-size:.8rem;cursor:pointer}" +
    ".btn-print{background:#059669;color:#fff}.btn-close{background:#374151;color:#fff}" +
    ".grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px}" +
    ".label{background:#fff;border:2px solid #1f2937;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)}" +
    ".lhd{background:#1f2937;padding:10px 14px;color:#fff}" +
    ".ltitle{font-size:1rem;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    ".lsub{font-size:.82rem;color:#9ca3af;margin-top:3px}" +
    ".lbody{display:flex;gap:12px;padding:12px 14px;align-items:flex-start}" +
    ".qrimg{width:200px;height:200px;flex-shrink:0;border:1px solid #e5e7eb;border-radius:6px;image-rendering:pixelated}" +
    ".lmeta{flex:1;display:flex;flex-direction:column;gap:6px}" +
    ".mrow{display:flex;flex-direction:column;border-bottom:1px solid #f3f4f6;padding-bottom:4px}" +
    ".mrow:last-child{border-bottom:none}" +
    ".mkey{font-size:.6rem;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.4px}" +
    ".mval{font-size:.78rem;font-weight:600;color:#111827;word-break:break-all}" +
    ".lfooter{text-align:center;font-size:.65rem;color:#6b7280;padding:6px 10px;border-top:1px dashed #e5e7eb;background:#f9fafb;font-style:italic}" +
    "</style></head><body>" +
    "<div class='toolbar no-print'><h2>Chemical QR Labels — " + labels.length + " label" + (labels.length !== 1 ? "s" : "") + "</h2>" +
    "<button class='btn-print' onclick='window.print()'>Print</button>" +
    "<button class='btn-close' onclick='window.close()'>Close</button></div>" +
    "<div class='grid'>" + rows + "</div></body></html>"
  );
  win.document.close();
}

function _metaRow(key, val) {
  return "<div class='mrow'><span class='mkey'>" + _esc(key) + "</span><span class='mval'>" + _esc(val) + "</span></div>";
}

// ── Heatmap ───────────────────────────────────────────────────────────────────
function _openHeatmap(greenhouse, targetName) {
  var overlay = document.getElementById("hmv-overlay");
  var modal   = document.getElementById("hmv-modal");
  var header  = document.getElementById("hmv-header");
  var body    = document.getElementById("hmv-body");

  // Build header
  header.innerHTML = "";
  var hl = document.createElement("div"); hl.className = "hmv-header-left";
  var ghLbl  = document.createElement("span"); ghLbl.className = "hmv-gh-label";     ghLbl.textContent = greenhouse;
  var arrow  = document.createElement("span"); arrow.className = "hmv-arrow";        arrow.textContent = "›";
  var tgtLbl = document.createElement("span"); tgtLbl.className = "hmv-target-label"; tgtLbl.textContent = targetName;
  hl.appendChild(ghLbl); hl.appendChild(arrow); hl.appendChild(tgtLbl);

  var hr = document.createElement("div"); hr.className = "hmv-header-right";
  var dateBadge = document.createElement("span"); dateBadge.className = "hmv-date-badge"; dateBadge.id = "hmv-date-badge"; dateBadge.textContent = "Loading...";
  var closeBtn  = document.createElement("button"); closeBtn.className = "hmv-close"; closeBtn.innerHTML = "&times;";
  closeBtn.addEventListener("click", _closeHeatmap);
  hr.appendChild(dateBadge); hr.appendChild(closeBtn);
  header.appendChild(hl); header.appendChild(hr);

  body.innerHTML = '<div class="hmv-loading"><div class="hmv-spinner"></div><p>Loading scouting data...</p></div>';
  overlay.classList.remove("hidden");

  var fetchPromise = _scoutCache[greenhouse]
    ? Promise.resolve(_scoutCache[greenhouse])
    : _call(API.SCOUTING, { greenhouse: greenhouse })
        .then(function (r) {
          var data = r.message || r.data;
          if (data && data.scouting_entries && data.scouting_entries.length) {
            _scoutCache[greenhouse] = data;
          }
          return data;
        });

  fetchPromise
    .then(function (data) { _renderHeatmap(body, data, greenhouse, targetName); })
    .catch(function () {
      body.innerHTML = '<div class="hmv-error">Unable to load scouting data for <strong>' + _esc(greenhouse) + '</strong>.<br>Check that scouting entries exist for this greenhouse.</div>';
    });
}

function _closeHeatmap() {
  document.getElementById("hmv-overlay").classList.add("hidden");
}

function _renderHeatmap(body, data, greenhouse, targetName) {
  if (!data || !data.scouting_entries || !data.scouting_entries.length) {
    body.innerHTML = '<div class="hmv-error">No scouting data found for <strong>' + _esc(greenhouse) + '</strong>.</div>';
    return;
  }

  var badge = document.getElementById("hmv-date-badge");
  if (badge && data.scouting_date) {
    badge.textContent = "Scouting: " + new Date(data.scouting_date).toLocaleDateString("en-GB", {day:"numeric",month:"short",year:"numeric"});
  }

  body.innerHTML = "";

  var entries  = data.scouting_entries || [];
  var obsTypes = [];
  entries.forEach(function (e) {
    Object.keys(e).forEach(function (k) {
      if (k.endsWith("_scouting_entry") && !obsTypes.includes(k)) obsTypes.push(k);
    });
  });

  var obsColor = "#6b7280", maxBed = 0, maxZone = 0, matrix = {};

  entries.forEach(function (e) {
    var bed  = _bedNum(e.bed);
    var zone = _zoneNum(e.zone);
    if (!bed || !zone) return;
    if (bed  > maxBed)  maxBed  = bed;
    if (zone > maxZone) maxZone = zone;
    obsTypes.forEach(function (t) {
      (e[t] || []).forEach(function (obs) {
        if (obs.name !== targetName) return;
        obsColor = obs.color || obsColor;
        if (!matrix[bed])       matrix[bed]       = {};
        if (!matrix[bed][zone]) matrix[bed][zone] = { count: 0 };
        matrix[bed][zone].count += (obs.count || 1);
      });
    });
  });

  var maxCount = 0, total = 0;
  Object.values(matrix).forEach(function (row) {
    Object.values(row).forEach(function (c) { total += c.count; maxCount = Math.max(maxCount, c.count); });
  });

  if (maxCount === 0) {
    body.innerHTML = '<div class="hmv-no-data"><p><strong>' + _esc(targetName) + '</strong> was not observed in <strong>' + _esc(greenhouse) + '</strong>.</p></div>';
    return;
  }

  // Stats bar
  var statsBar = document.createElement("div"); statsBar.className = "hmv-stats-bar";
  statsBar.innerHTML =
    "<div class='hmv-stat'><span class='hmv-stat-label'>Total</span><span class='hmv-stat-val'>" + total + "</span></div>" +
    "<div class='hmv-stat'><span class='hmv-stat-label'>Peak / Zone</span><span class='hmv-stat-val'>" + maxCount + "</span></div>" +
    "<div class='hmv-stat'><span class='hmv-stat-label'>Beds Affected</span><span class='hmv-stat-val'>" + Object.keys(matrix).length + "</span></div>" +
    "<div class='hmv-intensity-legend'><span>None</span>" +
    "<span class='hmv-leg-box' style='background:#e5e7eb'></span>" +
    [.2,.4,.6,.8,1].map(function (o) { return "<span class='hmv-leg-box' style='background:" + obsColor + ";opacity:" + o + "'></span>"; }).join("") +
    "<span>High</span></div>";
  body.appendChild(statsBar);

  var bedOrder  = (data.custom_bed_numbering  || "Top to Bottom") === "Top to Bottom"
    ? Array.from({length: maxBed},  function (_, i) { return maxBed  - i; })
    : Array.from({length: maxBed},  function (_, i) { return i + 1; });
  var zoneOrder = (data.custom_zone_numbering || "Right to Left") === "Right to Left"
    ? Array.from({length: maxZone}, function (_, i) { return maxZone - i; })
    : Array.from({length: maxZone}, function (_, i) { return i + 1; });

  var gridWrap = document.createElement("div"); gridWrap.className = "hmv-grid-wrap";
  var gridEl   = document.createElement("div"); gridEl.className   = "hmv-grid";
  gridEl.style.gridTemplateColumns = "36px repeat(" + maxZone + ", 1fr)";

  var corner = document.createElement("div"); corner.className = "hmv-corner"; gridEl.appendChild(corner);
  zoneOrder.forEach(function (z) { var l = document.createElement("div"); l.className = "hmv-zlbl"; l.textContent = z; gridEl.appendChild(l); });

  bedOrder.forEach(function (bed) {
    var bl = document.createElement("div"); bl.className = "hmv-blbl"; bl.textContent = bed; gridEl.appendChild(bl);
    zoneOrder.forEach(function (zone) {
      var cell = matrix[bed] && matrix[bed][zone] ? matrix[bed][zone] : null;
      var cnt  = cell ? cell.count : 0;
      var el   = document.createElement("div"); el.className = "hmv-cell " + _iClass(cnt, maxCount);
      if (cnt > 0) el.style.backgroundColor = obsColor;
      var tip = document.createElement("div"); tip.className = "hmv-tip";
      tip.innerHTML = cnt > 0
        ? "<strong>B" + bed + " &middot; Z" + zone + "</strong><br>" + _esc(targetName) + ": <strong>" + cnt + "</strong>"
        : "<strong>B" + bed + " &middot; Z" + zone + "</strong><br>None";
      el.appendChild(tip);
      el.addEventListener("mouseenter", function () {
        var rect = el.getBoundingClientRect();
        tip.style.top = "100%"; tip.style.marginTop = "4px";
        if      (rect.left  < window.innerWidth / 3)  { tip.style.left = "0"; tip.style.right = "auto"; tip.style.transform = ""; }
        else if (rect.right > window.innerWidth * 2/3) { tip.style.right = "0"; tip.style.left = "auto"; tip.style.transform = ""; }
        else                                           { tip.style.left = "50%"; tip.style.right = "auto"; tip.style.transform = "translateX(-50%)"; }
      });
      gridEl.appendChild(el);
    });
  });

  gridWrap.appendChild(gridEl);
  body.appendChild(gridWrap);
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function _parseTargets(raw) {
  if (!raw) return [];
  return raw.split(/\n/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _fmtQty(val) {
  if (val === null || val === undefined) return "—";
  var n = parseFloat(val);
  return isNaN(n) ? String(val) : (n % 1 === 0 ? String(n) : n.toFixed(3).replace(/\.?0+$/, ""));
}

function _bedNum(s)  { var m = String(s).match(/Bed\s*(\d+)/i);  return m ? +m[1] : null; }
function _zoneNum(s) {
  if (typeof s === "number") return s;
  var m = String(s).match(/Zone\s*(\d+)/i);
  return m ? +m[1] : null;
}

function _iClass(cnt, max) {
  if (!cnt) return "hmv-i0";
  var r = cnt / max;
  if (r <= .2) return "hmv-i1"; if (r <= .4) return "hmv-i2";
  if (r <= .6) return "hmv-i3"; if (r <= .8) return "hmv-i4";
  return "hmv-i5";
}

function _esc(str) {
  return String(str || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function _escSel(str) {
  // Escape for use in CSS attribute selectors
  return String(str || "").replace(/'/g, "\\'");
}
