// ==================== CONSTANTS ====================
const WATER_VOLUME_RATE = 1000;

document.addEventListener("DOMContentLoaded", () => {
    // ==================== STATE & CACHE ====================
    const state = {
        scoutingData: [],
        varietyRequirements: new Map(),
        dataMap: new Map(),
        bomsData: [],
        bomItems: [],
        allChemicals: [],
        bedData: [],
        teamData: [],
        observationMetadata: {},
        allObservationNames: {},
        activeObservationTypes: [],
        sourceWarehouseCache: {},
        chemicalUomCache: {},
        susceptibilityData: []
    };

    // ==================== DOM ELEMENTS ====================
    const els = {
        greenhouse: document.getElementById("greenhouse"),
        variety: document.getElementById("variety"),
        sprayType: document.getElementById("spray-type"),
        finalTargets: document.getElementById("final-targets"),
        kit: document.getElementById("kit"),
        scope: document.getElementById("scope"),
        bom: document.getElementById("bom"),
        areaToSpray: document.getElementById("area_to_spray"),
        bedNumbers: document.getElementById("bed-numbers"),
        waterPh: document.getElementById("custom_water_ph"),
        waterHardness: document.getElementById("custom_water_hardness"),
        waterVolume: document.getElementById("custom_water_volume"),
        sprayTeam: document.getElementById("spray-team-select"),
        varietyMultiSelect: document.getElementById("variety-multiselect"),
        selectedVarietiesDisplay: document.getElementById("selected-varieties-display"),
        bomChemicalsList: document.getElementById("bom-chemicals-list"),
        addChemicalBtn: document.getElementById("add-chemical-btn"),
        mainGrid: document.getElementById("main-grid"),
        xAxisLabels: document.getElementById("x-axis-labels"),
        yAxisLabels: document.getElementById("y-axis-labels"),
        heatmapGridWrapper: document.getElementById("heatmap-grid-wrapper"),
        thresholdMessage: document.getElementById("threshold-message"),
        bedNumbersContainer: document.getElementById("bed-numbers-container"),
        varietySelectionContainer: document.getElementById("variety-selection-container"),
        bomDetailsContainer: document.getElementById("bom-details-container"),
        stockBalancesContainer: document.getElementById("stock-balances-container"),
        stockBalanceTableBody: document.getElementById("stock-balance-table-body"),
        warehouseGroupHeader: document.getElementById("warehouse-group-header"),
        warehouseHeadersRow: document.getElementById("warehouse-headers-row"),
        targetsContainer: document.getElementById("targets-container"),
        stagesContainer: document.getElementById("stages-container"),
        plantSectionContainer: document.getElementById("plant-section-container"),
        thresholdContainer: document.getElementById("threshold-container"),
        popupOverlay: document.getElementById("global-popup-overlay"),
        popup: document.getElementById("global-popup"),
        popupSearch: document.getElementById("global-popup-search"),
        popupContent: document.getElementById("global-popup-content"),
        // BOM Modal elements
        bomModalOverlay: document.getElementById("bom-modal-overlay"),
        bomModal: document.getElementById("bom-modal"),
        createNewBomBtn: document.getElementById("create-new-bom-btn"),
        closeBomModalBtn: document.getElementById("close-bom-modal"),
        cancelBomBtn: document.getElementById("cancel-bom-btn"),
        saveBomBtn: document.getElementById("save-bom-btn"),
        bomItemName: document.getElementById("bom-item-name"),
        bomWaterPh: document.getElementById("bom-water-ph"),
        bomWaterHardness: document.getElementById("bom-water-hardness"),
        bomModalChemicalsList: document.getElementById("bom-modal-chemicals-list"),
        addBomChemicalBtn: document.getElementById("add-bom-chemical-btn")
    };

    // ==================== UTILITY FUNCTIONS ====================
    const showLoader = () => document.getElementById('map-loader').style.display = 'flex';
    const hideLoader = () => document.getElementById('map-loader').style.display = 'none';

    // ==================== TOAST NOTIFICATION SYSTEM ====================
    const showToast = (message, type = 'info') => {
        const toastContainer = document.getElementById('toast-container') || createToastContainer();
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;

        const icon = {
            success: 'Check',
            error: 'Error',
            warning: 'Warning',
            info: 'Info'
        }[type] || 'Info';

        toast.innerHTML = `
        <span class="toast-icon">${icon}</span>
        <span class="toast-message">${message}</span>
        <button class="toast-close" onclick="this.parentElement.remove()">×</button>
      `;

        toastContainer.appendChild(toast);

        setTimeout(() => toast.classList.add('toast-show'), 10);
        setTimeout(() => {
            toast.classList.remove('toast-show');
            setTimeout(() => toast.remove(), 300);
        }, 5000);
    };

    const createToastContainer = () => {
        const container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        document.body.appendChild(container);

        const style = document.createElement('style');
        style.textContent = `
        .toast-container {
          position: fixed;
          top: 20px;
          right: 20px;
          z-index: 10000;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .toast {
          min-width: 300px;
          padding: 16px;
          border-radius: 8px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.15);
          display: flex;
          align-items: center;
          gap: 12px;
          opacity: 0;
          transform: translateX(400px);
          transition: all 0.3s ease;
          background: white;
          border-left: 4px solid;
        }
        .toast-show {
          opacity: 1;
          transform: translateX(0);
        }
        .toast-success {
          border-left-color: #10b981;
          background: #f0fdf4;
        }
        .toast-error {
          border-left-color: #ef4444;
          background: #fef2f2;
        }
        .toast-warning {
          border-left-color: #f59e0b;
          background: #fffbeb;
        }
        .toast-info {
          border-left-color: #3b82f6;
          background: #eff6ff;
        }
        .toast-icon {
          font-size: 20px;
          font-weight: bold;
          flex-shrink: 0;
        }
        .toast-success .toast-icon { color: #10b981; }
        .toast-error .toast-icon { color: #ef4444; }
        .toast-warning .toast-icon { color: #f59e0b; }
        .toast-info .toast-icon { color: #3b82f6; }
        .toast-message {
          flex: 1;
          font-size: 14px;
          color: #1f2937;
        }
        .toast-close {
          background: none;
          border: none;
          font-size: 24px;
          color: #6b7280;
          cursor: pointer;
          padding: 0;
          width: 24px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .toast-close:hover {
          color: #1f2937;
        }
      `;
        document.head.appendChild(style);

        return container;
    };

    const parseBedNumber = (bedString) => {
        const match = bedString.match(/Bed (\d+)/);
        return match ? parseInt(match[1]) : null;
    };

    const getZoneNumber = (zoneData) => {
        if (typeof zoneData === "number") return zoneData;
        if (typeof zoneData === "string") {
            const match = zoneData.match(/Zone (\d+)/);
            if (match) return parseInt(match[1]);
        }
        return null;
    };

    const findMaxDimensions = (data) => {
        let maxBed = 0, maxZone = 0;
        data.forEach((entry) => {
            const bedNum = parseBedNumber(entry.bed);
            const zoneNum = getZoneNumber(entry.zone);
            if (bedNum > maxBed) maxBed = bedNum;
            if (zoneNum > maxZone) maxZone = zoneNum;
        });
        return { maxBed, maxZone };
    };

    // ==================== POPUP FUNCTIONS ====================
    const showPopup = (inputElement, dataCache) => {
        els.popup.dataset.targetInputId = inputElement.id || (inputElement.id = `input-${Date.now()}`);
        const inputRect = inputElement.getBoundingClientRect();
        const popupHeight = 300;
        let topPosition = inputRect.bottom + 5;
        if (window.innerHeight - inputRect.bottom < popupHeight && inputRect.top > popupHeight) {
            topPosition = inputRect.top - popupHeight - 5;
        }
        els.popup.style.top = `${topPosition}px`;
        els.popup.style.left = `${inputRect.left}px`;
        els.popupContent.innerHTML = '';

        dataCache.forEach((item) => {
            const option = document.createElement("a");
            option.href = "#";
            option.textContent = item;
            option.className = "popup-item";

            option.addEventListener("click", (e) => {
                e.preventDefault();

                // 1. Fill input
                inputElement.value = item;

                // 2. Find row (main form OR BOM modal)
                const row = inputElement.closest(".chemical-row, .bom-chemical-row");

                // 3. Fill UOM
                if (row) {
                    const uomSelector = row.classList.contains("bom-chemical-row")
                        ? ".bom-chemical-uom-input"
                        : ".tw-chemical-uom-input";
                    const uomInput = row.querySelector(uomSelector);
                    if (uomInput) {
                        let uom = state.chemicalUomCache[item];
                        if (!uom) {
                            fetchChemicalUom(item).then(cached => {
                                state.chemicalUomCache[item] = cached;
                                uomInput.value = cached || "";
                            });
                        } else {
                            uomInput.value = uom;
                        }
                    }
                }

                // 4. Close popup
                els.popupOverlay.classList.remove('active');
                els.popupSearch.value = '';

                // 5. UPDATE STOCK BALANCES — ONLY FOR MAIN FORM
                if (row && row.classList.contains("chemical-row")) {
                    setTimeout(updateStockBalances, 100); // Wait for UOM fetch
                }
            });

            els.popupContent.appendChild(option);
        });

        els.popupSearch.value = inputElement.value;
        els.popupSearch.oninput = filterPopup;
        els.popupOverlay.classList.add('active');
        filterPopup();
        els.popupSearch.focus();
    };

    const filterPopup = () => {
        const filterText = els.popupSearch.value.toUpperCase();
        Array.from(els.popupContent.children).forEach(option => {
            option.style.display = option.textContent.toUpperCase().includes(filterText) ? 'block' : 'none';
        });
    };

    // ==================== DATA PROCESSING ====================
    const processScoutingData = (scoutingEntries) => {
        const dataMap = new Map();
        const observationsInGreenhouse = {};
        const stagesInGreenhouse = new Set();
        const sectionsInGreenhouse = new Set();

        const allPossibleTypes = state.activeObservationTypes.filter(t =>
            t.endsWith('_scouting_entry') || t.endsWith('_entry')
        );
        allPossibleTypes.forEach(t => observationsInGreenhouse[t] = new Set());

        stagesInGreenhouse.add("N/A");
        sectionsInGreenhouse.add("N/A");

        scoutingEntries.forEach((entry) => {
            const bedNum = parseBedNumber(entry.bed);
            const zoneNum = getZoneNumber(entry.zone);
            if (!bedNum || !zoneNum) return;

            const key = `${bedNum}-${zoneNum}`;
            if (!dataMap.has(key)) dataMap.set(key, []);
            const observations = dataMap.get(key);

            allPossibleTypes.forEach(obsType => {
                const obsArray = entry[obsType] || [];

                obsArray.forEach((obs) => {
                    observationsInGreenhouse[obsType].add(obs.name);

                    const stage = obs.stage || "N/A";
                    const plantSection = obs.plant_section || "N/A";

                    stagesInGreenhouse.add(stage);
                    sectionsInGreenhouse.add(plantSection);

                    observations.push({
                        type: obsType,
                        name: obs.name,
                        count: obs.count || 1,
                        stage: stage,
                        symbol: obs.symbol || "",
                        color: obs.color || "#cccccc",
                        plant_section: plantSection
                    });
                });
            });
        });

        dataMap.forEach((observations, key) => {
            dataMap.set(key, observations.sort((a, b) => a.name.localeCompare(b.name)));
        });
        return { dataMap, observationsInGreenhouse, stagesInGreenhouse, sectionsInGreenhouse };
    };

    // ==================== DATA FETCHING FUNCTIONS ====================
    const fetchChemicals = async () => {
        showLoader();
        try {
            const response = await fetch('/api/method/upande_scp.serverscripts.create_bom.getAllChemicals', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Frappe-CSRF-Token': "{{csrf_token}}"
                }
            });

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const r = await response.json();
            const data = r.message || r.data;

            if (data && Array.isArray(data.chemicals)) {
                state.allChemicals = data.chemicals
                    .filter(name => typeof name === 'string' && name.trim().length > 0)
                    .filter((name, idx, arr) => arr.indexOf(name) === idx)
                    .sort();

                // Also cache UOMs if provided
                if (data.item_uom_map) {
                    state.chemicalUomCache = { ...state.chemicalUomCache, ...data.item_uom_map };
                    refreshRowUoms();
                }
            }
        } catch (error) {
            console.error("Error fetching chemicals:", error);
            showToast("Failed to load chemicals list", "error");
        } finally {
            hideLoader();
        }
    };

    const fetchChemicalUom = async (chemicalName) => {
        try {
            const response = await fetch('/api/method/upande_scp.serverscripts.create_bom.getChemicalUom', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Frappe-CSRF-Token': "{{csrf_token}}"
                },
                body: JSON.stringify({ chemical: chemicalName })
            });

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const r = await response.json();
            const data = r.message || r.data;

            if (data && data.uom) {
                // Cache it for future use
                state.chemicalUomCache[chemicalName] = data.uom;
                return data.uom;
            }

            return "";
        } catch (error) {
            console.error(`Error fetching UOM for ${chemicalName}:`, error);
            return "";
        }
    };

    const fetchScoutingData = async (greenhouse) => {
        els.heatmapGridWrapper.classList.add("tw-hidden");
        document.getElementById('grid-placeholder').classList.add("tw-hidden");
        els.targetsContainer.innerHTML = '';
        els.stagesContainer.innerHTML = "";
        els.plantSectionContainer.innerHTML = "";
        els.variety.innerHTML = '<option value="">Select variety</option>';
        els.bom.innerHTML = '<option value="">Select BOM</option>';
        els.bomDetailsContainer.classList.add("tw-hidden");
        renderGrid(0, 0);
        showLoader();
        try {
            const dateValue = document.getElementById('scouting-date').value || new Date().toISOString().slice(0, 10);
            const response = await fetch('/api/method/upande_scp.serverscripts.get_scouting_report.getScoutingData', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Frappe-CSRF-Token': "{{csrf_token}}"
                },
                body: JSON.stringify({ greenhouse, date: dateValue })
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const r = await response.json();
            const data = r.message || r.data;
            if (data && data.scouting_entries && data.scouting_entries.length > 0) {
                els.heatmapGridWrapper.classList.remove("tw-hidden");
                els.heatmapGridWrapper.classList.add("is-visible-grid");
                state.scoutingData = data.scouting_entries;
                const discoveredTypes = new Set();
                state.scoutingData.forEach(entry => {
                    Object.keys(entry).forEach(key => {
                        if (key.endsWith('_scouting_entry') && Array.isArray(entry[key]) && entry[key].length > 0) {
                            discoveredTypes.add(key);
                        }
                    });
                });
                if (data.observation_metadata) {
                    state.observationMetadata = data.observation_metadata;
                    state.allObservationNames = data.observation_metadata.all_observation_names || {};
                    const metadataTypes = data.observation_metadata.active_observation_types || [];
                    state.activeObservationTypes = [...new Set([...metadataTypes, ...discoveredTypes])];
                } else {
                    state.observationMetadata = { type_labels: {}, active_observation_types: [], all_observation_names: {} };
                    state.allObservationNames = {};
                    state.activeObservationTypes = Array.from(discoveredTypes);
                }
                const { dataMap, observationsInGreenhouse, stagesInGreenhouse, sectionsInGreenhouse } = processScoutingData(data.scouting_entries);
                state.dataMap = dataMap;
                renderObservationCheckboxes(observationsInGreenhouse);
                populateFinalTargets();
                renderStageCheckboxes([...stagesInGreenhouse]);
                renderPlantSectionCheckboxes([...sectionsInGreenhouse]);
                if (data.varieties) populateVarieties(data.varieties);
                if (data.susceptibility) {
                    state.susceptibilityData = data.susceptibility;
                }
                if (data.spray_team_team) {
                    populateTeams(data.spray_team_team);
                    state.teamData = data.spray_team_team.map(v => v.name);
                }
                const { maxBed, maxZone } = findMaxDimensions(state.scoutingData);
                const bedNumbering = data.custom_bed_numbering || "Top to Bottom";
                const zoneNumbering = data.custom_zone_numbering || "Right to Left";
                renderGrid(maxBed, maxZone, bedNumbering, zoneNumbering);
                updateGrid();
                els.heatmapGridWrapper.classList.remove("tw-hidden");
                if (data.boms) {
                    state.bomsData = data.boms;
                    state.bomItems = data.bom_items;
                    state.allChemicals = Array.isArray(data.all_chemicals)
                        ? data.all_chemicals
                            .filter(name => typeof name === 'string' && name.trim().length > 0)
                            .filter((name, idx, arr) => arr.indexOf(name) === idx)
                            .sort()
                        : [];
                    populateBoms(state.bomsData);
                }
                renderThresholdCheckboxes(els.variety.value);
                state.bedData = data.bed_data || [];
            } else {
                els.heatmapGridWrapper.classList.add("tw-hidden");
                document.getElementById('grid-placeholder').classList.remove("tw-hidden");
            }
        } catch (error) {
            els.heatmapGridWrapper.classList.add("tw-hidden");
            document.getElementById('grid-placeholder').classList.remove("tw-hidden");
        } finally {
            hideLoader();
        }
    };

    // ==================== RENDERING FUNCTIONS ====================
    const renderGrid = (numBeds, zonesPerBed, bedNumbering, zoneNumbering) => {
        els.mainGrid.innerHTML = "";
        els.xAxisLabels.innerHTML = "";
        els.yAxisLabels.innerHTML = "";
        document.documentElement.style.setProperty("--num-beds", numBeds);
        document.documentElement.style.setProperty("--zones-per-bed", zonesPerBed);
        const zoneRange = zoneNumbering === "Right to Left"
            ? Array.from({ length: zonesPerBed }, (_, i) => zonesPerBed - i)
            : Array.from({ length: zonesPerBed }, (_, i) => i + 1);
        zoneRange.forEach((i) => {
            const label = document.createElement("div");
            label.textContent = `Z${i}`;
            els.xAxisLabels.appendChild(label);
        });
        const bedRange = bedNumbering === "Top to Bottom"
            ? Array.from({ length: numBeds }, (_, i) => numBeds - i)
            : Array.from({ length: numBeds }, (_, i) => i + 1);
        bedRange.forEach((i) => {
            const label = document.createElement("div");
            label.textContent = `B${i}`;
            els.yAxisLabels.appendChild(label);
        });
        for (let bed = numBeds; bed >= 1; bed--) {
            for (let zone = zonesPerBed; zone >= 1; zone--) {
                const cell = document.createElement("div");
                cell.classList.add("tw-grid-cell");
                cell.dataset.bed = bed;
                cell.dataset.zone = zone;
                const tooltip = document.createElement("div");
                tooltip.classList.add("tw-tooltip");
                tooltip.innerHTML = `<strong>Bed ${bed}, Zone ${zone}</strong><br>No observations reported.`;
                cell.appendChild(tooltip);
                els.mainGrid.appendChild(cell);
            }
        }
        els.mainGrid.addEventListener('scroll', () => {
            els.yAxisLabels.scrollTop = els.mainGrid.scrollTop;
        });
    };

    const updateGrid = () => {
        if (!els.greenhouse.value || state.scoutingData.length === 0) return;

        const { activeObs, activeStages, activeSections, activeRequirements } = getActiveFilters();
        const selectedVariety = els.variety.value;

        const TYPE_MAP = {
            'diseases_scouting_entry': 'disease',
            'pests_scouting_entry': 'pest',
            'weeds_scouting_entry': 'weed',
            'physiological_disorders_entry': 'physiological_disorder',
            'incidents_scouting_entry': 'incident'
        };

        document.querySelectorAll(".tw-grid-cell").forEach((cell) => {
            const bed = cell.dataset.bed;
            const zone = cell.dataset.zone;
            const key = `${bed}-${zone}`;
            const observationsInZone = state.dataMap.get(key) || [];
            const tooltip = cell.querySelector(".tw-tooltip");

            cell.innerHTML = "";
            cell.appendChild(tooltip);
            cell.classList.remove("tw-threshold-high", "tw-threshold-moderate", "tw-threshold-low");
            cell.style.backgroundColor = "";

            const filteredObs = observationsInZone.filter((obs) => {
                const obsType = obs.type;
                const activeObsOfType = activeObs[obsType] || [];

                const isObservationActive = activeObsOfType.includes(obs.name);
                const isStageActive = obs.stage === "N/A" || activeStages.includes(obs.stage);
                const isSectionActive = obs.plant_section === "N/A" || activeSections.includes(obs.plant_section);

                return isObservationActive && isStageActive && isSectionActive;
            });

            let highestAlertLevel = 0;
            let tooltipContent = `<strong>Bed ${bed}, Zone ${zone}</strong><br><br>`;

            if (filteredObs.length > 0) {
                filteredObs.forEach((obs) => {
                    const indicator = document.createElement("div");
                    indicator.classList.add("observation-indicator");
                    indicator.style.backgroundColor = obs.color;
                    indicator.title = obs.name;
                    cell.appendChild(indicator);

                    const obsTypeClean = TYPE_MAP[obs.type] || obs.type.replace('_scouting_entry', '');
                    const sus = state.susceptibilityData.find(s =>
                        s.observation === obs.name && s.type === obsTypeClean
                    );

                    let reqLevel = null;
                    if (selectedVariety && sus && sus.requirement_by_variety[selectedVariety]) {
                        const level = sus.requirement_by_variety[selectedVariety];
                        reqLevel = (level === "unknown") ? null : level;
                    }

                    if (sus && reqLevel && activeRequirements.includes(reqLevel)) {
                        if (reqLevel === "high") highestAlertLevel = Math.max(highestAlertLevel, 3);
                        else if (reqLevel === "moderate") highestAlertLevel = Math.max(highestAlertLevel, 2);
                        else if (reqLevel === "low") highestAlertLevel = Math.max(highestAlertLevel, 1);
                    }

                    tooltipContent += `• <strong>${obs.name}</strong>: ${obs.count || 1} ${obs.symbol || ""}<br>`;
                    tooltipContent += ` <span style="color: #9ca3af;">Section: ${obs.plant_section || "N/A"}</span><br>`;
                });

                if (highestAlertLevel === 3) cell.classList.add("tw-threshold-high");
                else if (highestAlertLevel === 2) cell.classList.add("tw-threshold-moderate");
                else if (highestAlertLevel === 1) cell.classList.add("tw-threshold-low");

            } else if (observationsInZone.length > 0) {
                cell.style.backgroundColor = "#f8f9fa";
                tooltipContent += `<span style="color: #9ca3af;">Observations present but not in active filters</span><br><br>`;
                observationsInZone.forEach((obs) => {
                    tooltipContent += `• <strong>${obs.name}</strong>: ${obs.count || 1}<br>`;
                    tooltipContent += ` <span style="color: #9ca3af;">${obs.plant_section || "N/A"}</span><br>`;
                });
            } else {
                cell.style.backgroundColor = "#f8f9fa";
                tooltipContent += `<span style="color: #9ca3af;">No observations reported</span>`;
            }

            tooltip.innerHTML = tooltipContent;

            cell.addEventListener('mouseenter', () => {
                const cellRect = cell.getBoundingClientRect();
                const tooltipEl = cell.querySelector('.tw-tooltip');

                if (cellRect.top > window.innerHeight / 2) {
                    tooltipEl.style.bottom = '100%';
                    tooltipEl.style.top = 'auto';
                    tooltipEl.style.marginBottom = '8px';
                } else {
                    tooltipEl.style.top = '100%';
                    tooltipEl.style.bottom = 'auto';
                    tooltipEl.style.marginTop = '8px';
                }

                if (cellRect.left < window.innerWidth / 3) {
                    tooltipEl.style.left = '0';
                    tooltipEl.style.transform = 'translateX(0)';
                } else if (cellRect.right > (window.innerWidth * 2 / 3)) {
                    tooltipEl.style.right = '0';
                    tooltipEl.style.transform = 'translateX(0)';
                } else {
                    tooltipEl.style.left = '50%';
                    tooltipEl.style.transform = 'translateX(-50%)';
                }
            });
        });
    };

    const renderObservationCheckboxes = (observationsInGreenhouse) => {
        els.targetsContainer.innerHTML = '';

        state.activeObservationTypes.forEach(obsType => {
            const typeLabel = state.observationMetadata.type_labels?.[obsType]
                || obsType.replace('_scouting_entry', '').replace('_entry', '').replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

            const observationsOfType = observationsInGreenhouse[obsType] || new Set();
            const metadataList = state.allObservationNames[obsType] || [];

            const section = document.createElement('div');
            section.className = 'observation-section';

            const header = document.createElement('div');
            header.className = 'observation-title';
            header.textContent = typeLabel;
            section.appendChild(header);

            const filterGroup = document.createElement('div');
            filterGroup.className = 'filter-group';

            const allObservationNames = new Set();

            metadataList.forEach(o => {
                const name = o.name || o;
                allObservationNames.add(name);
            });

            observationsOfType.forEach(name => {
                allObservationNames.add(name);
            });

            const namesToShow = Array.from(allObservationNames).sort();

            if (namesToShow.length === 0) {
                const placeholder = document.createElement('div');
                placeholder.className = 'tw-text-sm tw-text-gray-500 tw-italic';
                placeholder.textContent = 'No observations available';
                filterGroup.appendChild(placeholder);
            } else {
                namesToShow.forEach(obsName => {
                    const pill = document.createElement('label');
                    pill.className = 'filter-pill';

                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    checkbox.id = `obs-${obsType}-${obsName}`;
                    checkbox.value = obsName;
                    checkbox.dataset.obsType = obsType;

                    const isInData = observationsOfType.has(obsName);
                    checkbox.checked = isInData;
                    checkbox.disabled = false;

                    const label = document.createElement('span');
                    label.textContent = obsName;

                    pill.appendChild(checkbox);
                    pill.appendChild(label);
                    filterGroup.appendChild(pill);
                });
            }

            section.appendChild(filterGroup);
            els.targetsContainer.appendChild(section);
        });
    };

    const renderStageCheckboxes = (stagesInGreenhouse) => {
        els.stagesContainer.innerHTML = "";
        stagesInGreenhouse.forEach((stage) => {
            const pill = document.createElement("label");
            pill.className = "filter-pill";
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.id = `stage-${stage}`;
            checkbox.value = stage;
            checkbox.checked = true;
            const label = document.createElement("span");
            label.textContent = stage;
            pill.appendChild(checkbox);
            pill.appendChild(label);
            els.stagesContainer.appendChild(pill);
        });
    };

    const renderPlantSectionCheckboxes = (sectionsInGreenhouse) => {
        const sections = ['Base', 'Stem', 'Middle', 'Top', 'Buds'];
        els.plantSectionContainer.innerHTML = "";
        sections.forEach((section) => {
            const pill = document.createElement("label");
            pill.className = "filter-pill";
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.id = `section-${section}`;
            checkbox.value = section;
            checkbox.checked = sectionsInGreenhouse.includes(section);
            checkbox.disabled = !sectionsInGreenhouse.includes(section);
            const label = document.createElement("span");
            label.textContent = section;
            pill.appendChild(checkbox);
            pill.appendChild(label);
            els.plantSectionContainer.appendChild(pill);
        });
    };

    const renderThresholdCheckboxes = (varietyName) => {
        const thresholds = ['low', 'moderate', 'high'];
        const hasData = state.susceptibilityData.length > 0 && varietyName;
        els.thresholdContainer.innerHTML = "";
        thresholds.forEach((threshold) => {
            const pill = document.createElement("label");
            pill.className = "filter-pill";
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.id = `threshold-${threshold}`;
            checkbox.value = threshold;
            checkbox.checked = hasData;
            checkbox.disabled = !hasData;
            const label = document.createElement("span");
            label.textContent = threshold.charAt(0).toUpperCase() + threshold.slice(1);
            pill.appendChild(checkbox);
            pill.appendChild(label);
            els.thresholdContainer.appendChild(pill);
        });
        if (hasData) {
            els.thresholdMessage.classList.add("tw-hidden");
        } else {
            els.thresholdMessage.innerHTML = `<strong>No susceptibility data for this variety.</strong>`;
            els.thresholdMessage.classList.remove("tw-hidden");
        }
    };

    const renderStockTable = (balances, allWarehouses) => {
        els.stockBalancesContainer.classList.remove("tw-hidden");
        els.warehouseGroupHeader.setAttribute("colspan", allWarehouses.length);
        let headerHtml = "";
        allWarehouses.forEach(wh => {
            headerHtml += `<th class="tw-text-center">${wh.split(" ")[2]}</th>`;
        });
        els.warehouseHeadersRow.innerHTML = headerHtml;
        let bodyHtml = "";
        const sortedItems = Object.keys(balances).sort();
        sortedItems.forEach(itemName => {
            const itemBalances = balances[itemName];
            let totalStock = 0;
            state.sourceWarehouseCache[itemName] = state.sourceWarehouseCache[itemName] || { source_warehouse: null };
            let warehouseBalanceHtml = "";
            let selectOptionsHtml = '<option value="">-- Select Source --</option>';
            allWarehouses.forEach(wh => {
                const qty = itemBalances[wh] || 0.0;
                totalStock += qty;
                const qtyFormatted = qty.toFixed(2);
                const qtyClass = qty === 0.0 ? "stock-qty-zero" : "stock-qty-available";
                warehouseBalanceHtml += `<td class="tw-text-center ${qtyClass}">${qtyFormatted}</td>`;
                if (qty > 0) {
                    const shortWhName = wh.split(" - ")[0];
                    selectOptionsHtml += `<option value="${wh}">${shortWhName} (${qtyFormatted})</option>`;
                }
            });
            const totalClass = totalStock === 0.0 ? "stock-total stock-total-insufficient" : "stock-total";
            bodyHtml += `<tr>`;
            bodyHtml += `<td>${itemName}</td>`;
            bodyHtml += warehouseBalanceHtml;
            bodyHtml += `<td><select id="select-wh-${itemName}" class="form-select" data-item-code="${itemName}" onchange="handleWarehouseChange(this)">${selectOptionsHtml}</select></td>`;
            bodyHtml += `<td class="tw-text-center ${totalClass}">${totalStock.toFixed(2)}</td>`;
            bodyHtml += "</tr>";
        });
        els.stockBalanceTableBody.innerHTML = bodyHtml || `<tr><td colspan="10" class="tw-text-center tw-py-6 tw-text-gray-500">No stock data available</td></tr>`;
    };

    const createBomChemicalRow = (itemName = "", rate = "", uom = "") => {
        const row = document.createElement("div");
        row.className = "bom-chemical-row";
        row.style.display = "grid";
        row.style.gridTemplateColumns = "2fr 1fr 1fr auto";   // ← 4 columns only
        row.style.gap = "12px";
        row.style.alignItems = "center";

        // 1. Chemical Name
        const nameInp = document.createElement("input");
        nameInp.type = "text";
        nameInp.className = "form-input bom-chemical-name-input";
        nameInp.value = itemName;
        nameInp.placeholder = "Chemical";
        nameInp.addEventListener("focus", async e => {
            if (!state.allChemicals.length) await fetchChemicals();
            showPopup(e.target, state.allChemicals);
        });

        // 2. Application Rate (per 1000 L)
        const rateInp = document.createElement("input");
        rateInp.type = "number";
        rateInp.className = "form-input bom-chemical-rate-input";
        rateInp.value = rate;
        rateInp.min = "0";
        rateInp.step = "0.01";
        rateInp.placeholder = "Rate/1000 L";

        // 3. UOM (read-only)
        const uomInp = document.createElement("input");
        uomInp.type = "text";
        uomInp.className = "form-input bom-chemical-uom-input";
        uomInp.value = uom;
        uomInp.readOnly = true;
        uomInp.placeholder = "UOM";

        // 4. Remove button
        const del = document.createElement("button");
        del.type = "button";
        del.className = "btn-remove";
        del.innerHTML = "×";
        del.onclick = () => { row.remove(); updateStockBalances(); };

        row.append(nameInp, rateInp, uomInp, del);
        return row;
    };

    const openBomModal = async () => {
        els.bomModalOverlay.classList.add('active');
        els.bomItemName.value = '';
        els.bomWaterPh.value = '';
        els.bomWaterHardness.value = '';
        els.bomModalChemicalsList.innerHTML = '';
        els.bomModalChemicalsList.appendChild(createBomChemicalRow());

        // Fetch chemicals if not already loaded
        if (state.allChemicals.length === 0) {
            await fetchChemicals();
        }

        updateStockBalances();
    };

    const closeBomModal = () => {
        els.bomModalOverlay.classList.remove('active');
    };

    const getBomChemicals = () => {
        return Array.from(els.bomModalChemicalsList.querySelectorAll(".bom-chemical-row"))
            .map(row => {
                const name = row.querySelector(".bom-chemical-name-input")?.value.trim();
                const rate = parseFloat(row.querySelector(".bom-chemical-rate-input")?.value) || 0;
                const uom = row.querySelector(".bom-chemical-uom-input")?.value || "";
                if (!name || rate <= 0) return null;
                return {
                    item_name: name,
                    custom_application_rate: rate,   // ← per 1000 L
                    uom
                };
            })
            .filter(Boolean);
    };

    const createBOM = async () => {
        const itemName = els.bomItemName.value.trim();
        const waterPh = parseFloat(els.bomWaterPh.value);
        const waterHardness = parseFloat(els.bomWaterHardness.value);
        const chemicals = getBomChemicals();

        if (!itemName) {
            showToast("Please enter a BOM name", "error");
            return;
        }
        if (!waterPh || waterPh <= 0) {
            showToast("Please enter a valid water pH", "error");
            return;
        }
        if (!waterHardness || waterHardness <= 0) {
            showToast("Please enter a valid water hardness", "error");
            return;
        }
        if (chemicals.length === 0) {
            showToast("Please add at least one chemical", "error");
            return;
        }

        const invalidChemicals = chemicals.filter(c => !c.custom_application_rate || c.custom_application_rate <= 0);
        if (invalidChemicals.length > 0) {
            showToast("All chemicals must have a valid rate", "error");
            return;
        }

        const bomData = {
            item: itemName,
            custom_water_ph: waterPh,
            custom_water_hardness: waterHardness,
            items: chemicals
        };

        showLoader();
        try {
            const response = await fetch('/api/method/upande_scp.serverscripts.create_bom.createBOM', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Frappe-CSRF-Token': "{{csrf_token}}"
                },
                body: JSON.stringify({ data: JSON.stringify(bomData) })
            });

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const r = await response.json();
            const result = r.message || r.data;

            if (result && result.status === "success") {
                showToast(`BOM "${result.bom_name}" created successfully!`, "success");
                closeBomModal();

                if (els.greenhouse.value) {
                    await fetchScoutingData(els.greenhouse.value);
                }

                els.bom.value = result.bom_name;
                populateBomDetails(result.bom_name);
            } else {
                showToast(`Error creating BOM: ${result?.message || "Unknown error"}`, "error");
            }
        } catch (error) {
            console.error("BOM Creation Error:", error);
            showToast("An error occurred while creating the BOM. Please try again.", "error");
        } finally {
            hideLoader();
        }
    };

    els.createNewBomBtn.addEventListener("click", openBomModal);
    els.closeBomModalBtn.addEventListener("click", closeBomModal);
    els.cancelBomBtn.addEventListener("click", closeBomModal);
    els.saveBomBtn.addEventListener("click", createBOM);

    els.addBomChemicalBtn.addEventListener("click", () => {
        els.bomModalChemicalsList.appendChild(createBomChemicalRow());
    });

    els.bomModalOverlay.addEventListener("click", (e) => {
        if (e.target === els.bomModalOverlay) {
            closeBomModal();
        }
    });

    const getActiveFilters = () => {
        const activeObs = {};
        state.activeObservationTypes.forEach(obsType => {
            const checked = els.targetsContainer.querySelectorAll(`input[data-obs-type="${obsType}"]:checked`);
            activeObs[obsType] = Array.from(checked).map(cb => cb.value);
        });
        const activeStages = Array.from(els.stagesContainer.querySelectorAll('input:checked')).map(cb => cb.value);
        const activeSections = Array.from(els.plantSectionContainer.querySelectorAll('input:checked')).map(cb => cb.value);
        const activeRequirements = Array.from(els.thresholdContainer.querySelectorAll('input:checked')).map(cb => cb.value);
        return { activeObs, activeStages, activeSections, activeRequirements };
    };

    const updateStockBalances = async () => {
        const chemicals = getFinalChemicals();
        const uniqueChemicals = [...new Set(chemicals.map(c => c.chemical).filter(name => name && name.trim()))];
        if (uniqueChemicals.length === 0) {
            els.stockBalanceTableBody.innerHTML = '<tr><td colspan="10" class="tw-text-center tw-py-6 tw-text-red-500">No chemicals to check</td></tr>';
            return;
        }
        els.stockBalanceTableBody.innerHTML = '<tr><td colspan="10" class="tw-text-center tw-py-6 tw-text-gray-500">Fetching stock balances...</td></tr>';
        showLoader();
        try {
            const response = await fetch('/api/method/upande_scp.serverscripts.get_bom_stock_balances.getBomStockBalances', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Frappe-CSRF-Token': "{{csrf_token}}"
                },
                body: JSON.stringify({ data: JSON.stringify({ chemicals: uniqueChemicals }) })
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const r = await response.json();
            const data = r.message || r.data;
            if (data) {
                const stockData = data.stock_balances;
                if (data.item_uom_map) {
                    state.chemicalUomCache = { ...state.chemicalUomCache, ...data.item_uom_map };
                    refreshRowUoms();
                }
                if (stockData) {
                    const firstItem = Object.keys(stockData)[0];
                    const allWarehouses = firstItem ? Object.keys(stockData[firstItem]) : [];
                    renderStockTable(stockData, allWarehouses);
                } else {
                    els.stockBalanceTableBody.innerHTML = '<tr><td colspan="10" class="tw-text-center tw-py-6 tw-text-gray-500">No stock data found</td></tr>';
                }
            } else {
                els.stockBalanceTableBody.innerHTML = '<tr><td colspan="10" class="tw-text-center tw-py-6 tw-text-gray-500">No stock data found</td></tr>';
            }
        } catch (error) {
            els.stockBalanceTableBody.innerHTML = '<tr><td colspan="10" class="tw-text-center tw-py-6 tw-text-red-500">Error fetching stock balances</td></tr>';
        } finally {
            hideLoader();
        }
    };


    const populateVarieties = (varieties) => {
        els.variety.innerHTML = '<option value="">Select variety</option>';
        els.varietyMultiSelect.innerHTML = "";
        varieties.forEach((v) => {
            const option = document.createElement("option");
            option.value = v.name;
            option.textContent = v.name;
            els.variety.appendChild(option);
            const multiOption = option.cloneNode(true);
            els.varietyMultiSelect.appendChild(multiOption);
        });
    };

    const populateTeams = (teams) => {
        els.sprayTeam.innerHTML = "";
        teams.forEach((team) => {
            const option = document.createElement("option");
            option.value = team.name;
            option.textContent = team.name;
            els.sprayTeam.appendChild(option);
        });
    };

    const populateBoms = (boms) => {
        els.bom.innerHTML = '<option value="">Select BOM</option>';
        boms.forEach((b) => {
            const option = document.createElement("option");
            option.value = b.name;
            option.textContent = b.name;
            els.bom.appendChild(option);
        });
    };

    const createChemicalRow = (itemName = "", rate = "", uom = "") => {
        const row = document.createElement("div");
        row.className = "chemical-row";
        row.style.display = "grid";
        row.style.gridTemplateColumns = "2fr 1fr 1fr auto";
        row.style.gap = "12px";
        row.style.alignItems = "center";

        // 1. Chemical Name
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "tw-chemical-name-input form-input";
        nameInput.value = itemName;
        nameInput.placeholder = "Chemical";
        nameInput.readOnly = !!itemName;
        nameInput.addEventListener("focus", e => showPopup(e.target, state.allChemicals));
        nameInput.addEventListener("input", () => {
            clearTimeout(nameInput._debounce);
            nameInput._debounce = setTimeout(updateStockBalances, 500);
        });

        // 2. Rate (per 1000 L)
        const rateInput = document.createElement("input");
        rateInput.type = "number";
        rateInput.className = "tw-chemical-qty-input form-input";
        rateInput.value = rate;
        rateInput.min = "0";
        rateInput.step = "0.01";
        rateInput.placeholder = "Rate/1000 L";
        rateInput.addEventListener("input", updateStockBalances);

        // 3. UOM
        const uomInput = document.createElement("input");
        uomInput.type = "text";
        uomInput.className = "tw-chemical-uom-input form-input";
        uomInput.value = uom;
        uomInput.readOnly = true;
        uomInput.placeholder = "UoM";

        // 4. Remove
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "btn-remove";
        removeBtn.innerHTML = "×";
        removeBtn.onclick = () => { row.remove(); updateStockBalances(); };

        row.append(nameInput, rateInput, uomInput, removeBtn);
        return row;
    };

    const getActiveFilterTargets = () => {
        const active = [];
        state.activeObservationTypes.forEach(obsType => {
            const checked = els.targetsContainer.querySelectorAll(`input[data-obs-type="${obsType}"]:checked`);
            checked.forEach(cb => active.push(cb.value));
        });
        return active;
    };

    const populateFinalTargets = () => {
        const select = els.finalTargets;
        select.innerHTML = "";

        // Get ALL unique targets from scouting data
        const allTargets = new Set();
        state.scoutingData.forEach(entry => {
            state.activeObservationTypes.forEach(obsType => {
                const obsArray = entry[obsType] || [];
                obsArray.forEach(obs => {
                    if (obs.name) allTargets.add(obs.name);
                });
            });
        });

        // Sort and populate
        Array.from(allTargets).sort().forEach(target => {
            const opt = document.createElement("option");
            opt.value = target;
            opt.textContent = target;
            select.appendChild(opt);
        });

        // Optional: Pre-select active filters
        const activeTargets = getActiveFilterTargets();
        Array.from(select.options).forEach(opt => {
            if (activeTargets.includes(opt.value)) {
                opt.selected = true;
            }
        });
    };

    const populateBomDetails = (bomName) => {
        const selectedBom = state.bomsData.find(b => b.name === bomName);
        els.bomChemicalsList.innerHTML = "";
        if (selectedBom) {
            els.bomDetailsContainer.classList.remove("tw-hidden");
            els.waterPh.value = selectedBom.custom_water_ph || "";
            els.waterHardness.value = selectedBom.custom_water_hardness || "";
            const chemicals = state.bomItems.filter(i => i.parent === bomName);
            chemicals.forEach(item => {
                const rate = parseFloat(item.qty) || 0;
                const row = createChemicalRow(item.item_name, rate, item.uom);
                els.bomChemicalsList.appendChild(row);
            });
            updateStockBalances();
        } else {
            els.bomDetailsContainer.classList.add("tw-hidden");
        }
    };

    const calculateAreaToSpray = () => {
        const scope = els.scope.value;
        let totalAreaSqMeters = 0;
        if (scope === "Full Greenhouse") {
            totalAreaSqMeters = state.bedData.reduce((sum, d) => sum + (d.bed__area || 0), 0);
        } else if (scope === "Specific Variety") {
            const selectedVarietyNames = Array.from(els.varietyMultiSelect.selectedOptions).map(opt => opt.value);
            if (selectedVarietyNames.length > 0) {
                const accountedVarieties = new Set();
                state.bedData.forEach((d) => {
                    if (selectedVarietyNames.includes(d.variety) && !accountedVarieties.has(d.variety) && d.total_variety_area > 0) {
                        totalAreaSqMeters += d.total_variety_area;
                        accountedVarieties.add(d.variety);
                    }
                });
            }
        } else if (scope === "Specific Bed(s)") {
            const bedString = els.bedNumbers.value.trim();
            if (bedString) {
                const targetBeds = new Set();
                const segments = bedString.split(",").map(s => s.trim()).filter(s => s.length > 0);
                segments.forEach((segment) => {
                    const rangeMatch = segment.match(/^(\d+)\s*-\s*(\d+)$/);
                    if (rangeMatch) {
                        const start = parseInt(rangeMatch[1]);
                        const end = parseInt(rangeMatch[2]);
                        for (let i = start; i <= end; i++) targetBeds.add(String(i));
                    } else {
                        const singleBed = segment.match(/^(\d+)$/);
                        if (singleBed) targetBeds.add(singleBed[1]);
                    }
                });
                state.bedData.forEach((d) => {
                    if (targetBeds.has(d.bed)) totalAreaSqMeters += d.bed__area || 0;
                });
            }
        }
        const totalAreaHectares = totalAreaSqMeters > 0 ? totalAreaSqMeters / 10000 : 0;
        els.areaToSpray.value = totalAreaHectares > 0 ? totalAreaHectares.toFixed(4) : 0;
        const waterVolume = totalAreaHectares * WATER_VOLUME_RATE;
        els.waterVolume.value = waterVolume > 0 ? waterVolume.toFixed(2) : 0;
    };

    const getFinalChemicals = () => {
        const rows = [...els.bomChemicalsList.querySelectorAll(".chemical-row"),
        ...els.bomModalChemicalsList.querySelectorAll(".bom-chemical-row")];
        return rows.map(row => {
            const name = row.querySelector(".tw-chemical-name-input, .bom-chemical-name-input")?.value.trim() || "";
            const rate = parseFloat(row.querySelector(".tw-chemical-qty-input, .bom-chemical-rate-input")?.value) || 0;
            const uom = row.querySelector(".tw-chemical-uom-input, .bom-chemical-uom-input")?.value || "";
            return { chemical: name, application_rate: rate, uom };
        }).filter(c => c.chemical && c.application_rate > 0);
    };

    const refreshRowUoms = () => {
        document.querySelectorAll(".chemical-row, .bom-chemical-row").forEach(row => {
            const isBomRow = row.classList.contains("bom-chemical-row");
            const nameInput = row.querySelector(
                isBomRow ? ".bom-chemical-name-input" : ".tw-chemical-name-input"
            );
            const uomInput = row.querySelector(
                isBomRow ? ".bom-chemical-uom-input" : ".tw-chemical-uom-input"
            );
            if (nameInput && uomInput) {
                const name = nameInput.value.trim();
                if (name && state.chemicalUomCache[name]) {
                    uomInput.value = state.chemicalUomCache[name];
                }
            }
        });
    };

    window.handleWarehouseChange = function (element) {
        const itemCode = element.getAttribute("data-item-code");
        const warehouse = element.value;
        if (state.sourceWarehouseCache[itemCode]) {
            state.sourceWarehouseCache[itemCode].source_warehouse = warehouse || null;
        }
    };

    // ==================== EVENT LISTENERS ====================
    els.greenhouse.addEventListener("change", (e) => {
        if (e.target.value) {
            els.variety.value = "";
            els.sprayType.value = "";
            els.kit.value = "";
            els.scope.value = "";
            els.bom.value = "";
            els.waterPh.value = "";
            els.waterHardness.value = "";
            els.waterVolume.value = "";
            els.areaToSpray.value = "";
            els.bomDetailsContainer.classList.add("tw-hidden");
            els.bomChemicalsList.innerHTML = "";
            els.stockBalancesContainer.classList.add("tw-hidden");
            els.stockBalanceTableBody.innerHTML = '<tr><td colspan="10" class="tw-text-center tw-py-4 tw-text-gray-500">Loading...</td></tr>';
            els.warehouseHeadersRow.innerHTML = "";
        }
        fetchScoutingData(e.target.value);
    });

    els.variety.addEventListener("change", () => {
        renderThresholdCheckboxes(els.variety.value);
        updateGrid();
    });

    els.scope.addEventListener("change", (e) => {
        els.bedNumbersContainer.classList.add("tw-hidden");
        els.varietySelectionContainer.classList.add("tw-hidden");
        els.bedNumbers.value = "";
        els.varietyMultiSelect.selectedIndex = -1;
        els.selectedVarietiesDisplay.innerHTML = '<p class="tw-text-gray-500">Selected varieties will appear here...</p>';
        if (e.target.value === "Specific Bed(s)") {
            els.bedNumbersContainer.classList.remove("tw-hidden");
        } else if (e.target.value === "Specific Variety") {
            els.varietySelectionContainer.classList.remove("tw-hidden");
        }
        calculateAreaToSpray();
    });

    els.varietyMultiSelect.addEventListener("change", () => {
        const selectedOptions = Array.from(els.varietyMultiSelect.selectedOptions);
        const selectedVarietyNames = selectedOptions.map(opt => opt.textContent);
        els.selectedVarietiesDisplay.innerHTML = selectedVarietyNames.length > 0
            ? `<p class="tw-font-semibold">Selected:</p> ${selectedVarietyNames.join(", ")}`
            : '<p class="tw-text-gray-500">Selected varieties will appear here...</p>';
        calculateAreaToSpray();
    });

    els.bedNumbers.addEventListener("input", calculateAreaToSpray);

    els.bom.addEventListener("change", (e) => {
        populateBomDetails(e.target.value);
        updateStockBalances();
    });

    els.addChemicalBtn.addEventListener("click", () => {
        const newRow = createChemicalRow();
        els.bomChemicalsList.appendChild(newRow);
        updateStockBalances();
    });

    els.targetsContainer.addEventListener("change", updateGrid);
    els.stagesContainer.addEventListener("change", updateGrid);
    els.plantSectionContainer.addEventListener("change", updateGrid);
    els.thresholdContainer.addEventListener("change", updateGrid);

    els.popupOverlay.addEventListener("click", (e) => {
        if (e.target.id === "global-popup-overlay") {
            els.popupOverlay.classList.remove("active");
        }
    });

    document.getElementById("spray-plan-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const greenhouse = els.greenhouse.value;
        const variety = els.variety.value;
        const sprayType = els.sprayType.value;
        const kit = els.kit.value;
        const scope = els.scope.value;
        const bom = els.bom.value;
        const waterPh = els.waterPh.value;
        const waterHardness = els.waterHardness.value;
        const waterVolume = els.waterVolume.value;
        const areaToSpray = els.areaToSpray.value;
        const sprayTeam = els.sprayTeam.value;
        const selectedTargets = Array.from(els.finalTargets.selectedOptions).map(opt => opt.value);

        if (selectedTargets.length === 0) {
            showToast("Please select at least one target.", "error");
            return;
        }

        const targets = selectedTargets;
        const { activeStages, activeSections } = getActiveFilters();
        const chemicals = getFinalChemicals();

        if (!greenhouse || targets.length === 0 || activeStages.length === 0 || activeSections.length === 0 || !sprayType || !kit || !scope || !bom) {
            showToast("Please fill out all required fields.", "error");
            return;
        }

        if (chemicals.length === 0) {
            showToast("Please add at least one chemical.", "error");
            return;
        }

        for (const chemical of chemicals) {
            const sourceWarehouse = state.sourceWarehouseCache[chemical.chemical]?.source_warehouse;
            if (!chemical.chemical || !chemical.uom || chemical.application_rate <= 0 || !sourceWarehouse) {
                showToast("All chemical rows must have valid item name, quantity, UoM, and source warehouse.", "error");
                return;
            }
        }

        if (!waterPh || !waterHardness) {
            showToast("Please provide values for water pH and water hardness.", "error");
            return;
        }

        let custom_scope_value = "";
        if (scope === "Specific Variety") {
            const selectedVarieties = Array.from(els.varietyMultiSelect.selectedOptions).map(opt => opt.value);
            custom_scope_value = selectedVarieties.join(",");
        } else if (scope === "Specific Bed(s)") {
            custom_scope_value = els.bedNumbers.value;
        }

        // Build chemicals array with source warehouse
        const chemicalsWithWarehouse = chemicals.map(chem => ({
            ...chem,
            source_warehouse: state.sourceWarehouseCache[chem.chemical]?.source_warehouse || ""
        }));

        const formData = {
            custom_type: "Application Floor Plan",
            custom_greenhouse: greenhouse,
            custom_variety: variety,
            custom_targets: targets,
            custom_spray_type: sprayType,
            custom_kit: kit,
            custom_scope: scope,
            custom_scope_details: custom_scope_value,
            production_item: bom,
            qty: 1,
            custom_water_ph: parseFloat(waterPh) || 0,
            custom_water_hardness: parseFloat(waterHardness) || 0,
            chemicals: chemicalsWithWarehouse,
            custom_water_volume: parseFloat(waterVolume) || 0,
            custom_area: parseFloat(areaToSpray) || 0,
            custom_spray_team: sprayTeam
        };

        showLoader();
        try {
            const fullPayload = {
                payload: {
                    raw_data: formData
                }
            };
            const response = await fetch('/api/method/upande_scp.serverscripts.validate_frac_irac_guidelines.validateGuidelines', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Frappe-CSRF-Token': "{{csrf_token}}"
                },
                body: JSON.stringify(fullPayload)
            });

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const r = await response.json();
            const validationResult = r.message;

            if (validationResult?.valid === true) {
                hideLoader();
                createWorkOrder(formData);
                return;
            }

            if (validationResult?.valid === false) {
                hideLoader();
                showValidationDialog(validationResult.errors, formData);
                return;
            }

            showToast("Unexpected response structure from validation server.", "error");
        } catch (error) {
            showToast("An error occurred during validation. Please try again.", "error");
            console.error("Validation API Error:", error);
        } finally {
            hideLoader();
        }
    });

    const showValidationDialog = (errors, formData) => {
        const errorHtml = errors.length > 0
            ? `<ul>${errors.map(err => `<li>${err}</li>`).join('')}</ul>`
            : '<div>No specific validation details provided.</div>';

        const dialogOverlay = document.createElement('div');
        dialogOverlay.className = 'validation-dialog-overlay';
        dialogOverlay.innerHTML = `
        <div class="validation-dialog">
          <div class="validation-dialog-header">
            <h3>FRAC/IRAC Validation Warning</h3>
            <button class="validation-dialog-close" onclick="this.closest('.validation-dialog-overlay').remove()">×</button>
          </div>
          <div class="validation-dialog-body">
            ${errorHtml}
            <div class="validation-warning-box">
              <p class="validation-warning-title">
                Warning: Do you want to bypass these guidelines and create the Work Order anyway?
              </p>
              <p class="validation-warning-text">
                Bypassing may lead to reduced effectiveness and increased resistance.
              </p>
            </div>
          </div>
          <div class="validation-dialog-footer">
            <button class="validation-btn validation-btn-cancel" onclick="this.closest('.validation-dialog-overlay').remove(); showToast('Work Order creation cancelled', 'info');">Cancel</button>
            <button class="validation-btn validation-btn-bypass" id="bypass-validation-btn">Bypass and Create</button>
          </div>
        </div>
      `;

        const style = document.createElement('style');
        style.textContent = `
        .validation-dialog-overlay {
          position: fixed;
          top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(0,0,0,0.5);
          display: flex; align-items: center; justify-content: center;
          z-index: 9999;
        }
        .validation-dialog {
          background: white; border-radius: 8px;
          max-width: 800px; width: 90%; max-height: 90vh;
          display: flex; flex-direction: column;
          box-shadow: 0 10px 25px rgba(0,0,0,0.3);
        }
        .validation-dialog-header {
          padding: 20px; border-bottom: 1px solid #e5e7eb;
          display: flex; justify-content: space-between; align-items: center;
        }
        .validation-dialog-header h3 { margin: 0; font-size: 20px; color: #1f2937; }
        .validation-dialog-close {
          background: none; border: none; font-size: 28px; color: #6b7280;
          cursor: pointer; width: 32px; height: 32px;
          display: flex; align-items: center; justify-content: center;
        }
        .validation-dialog-close:hover { color: #1f2937; }
        .validation-dialog-body { padding: 20px; overflow-y: auto; flex: 1; }
        .validation-dialog-body ul {
          list-style-type: none; padding: 0; margin: 0 0 20px 0;
          border: 1px solid #ffcdd2; background-color: #ffebee; border-radius: 4px;
        }
        .validation-dialog-body li {
          padding: 10px 15px; color: #c62828; font-size: 14px;
          border-bottom: 1px dashed #ffcdd2;
        }
        .validation-dialog-body li:last-child { border-bottom: none; }
        .validation-warning-box {
          margin-top: 20px; padding: 15px;
          background-color: #fff3cd; border: 1px solid #ffc107; border-radius: 4px;
        }
        .validation-warning-title { margin: 0; color: #856404; font-weight: bold; }
        .validation-warning-text { margin: 10px 0 0 0; color: #856404; font-size: 0.9em; }
        .validation-dialog-footer {
          padding: 20px; border-top: 1px solid #e5e7eb;
          display: flex; justify-content: flex-end; gap: 10px;
        }
        .validation-btn {
          padding: 10px 20px; border-radius: 6px; border: none;
          font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s;
        }
        .validation-btn-cancel { background: #f3f4f6; color: #374151; }
        .validation-btn-cancel:hover { background: #e5e7eb; }
        .validation-btn-bypass { background: #1f2937; color: white; }
        .validation-btn-bypass:hover { background: #111827; }
      `;
        document.head.appendChild(style);
        document.body.appendChild(dialogOverlay);

        document.getElementById('bypass-validation-btn').addEventListener('click', () => {
            dialogOverlay.remove();
            showToast('Creating Work Order (Guidelines Bypassed)', 'warning');
            createWorkOrder(formData);
        });
    };

    const createWorkOrder = async (data) => {
        showLoader();
        try {
            const fullPayload = { payload: { raw_data: data } };
            const response = await fetch('/api/method/upande_scp.serverscripts.create_application_work_order.createApplicationWorkOrder', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Frappe-CSRF-Token': "{{csrf_token}}"
                },
                body: JSON.stringify(fullPayload)
            });

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const r = await response.json();

            if (r.message && r.message.status === "success") {
                const redirectPath = `/app/work-order/${r.message.work_order_name}`;
                showToast(`Work Order ${r.message.work_order_name} created successfully!`, "success");
                setTimeout(() => {
                    window.location.href = redirectPath;
                }, 1500);
            } else {
                showToast(`Error creating Work Order: ${r.message?.message || "Unknown error"}`, "error");
            }
        } catch (error) {
            showToast("An unexpected error occurred during creation. Please try again.", "error");
        } finally {
            hideLoader();
        }
    };

    renderThresholdCheckboxes(null);
});