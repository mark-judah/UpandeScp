// ==================== CONSTANTS ====================
const WATER_VOLUME_RATE = 1000;

document.addEventListener("DOMContentLoaded", () => {
    // ==================== STATE & CACHE ====================
    const state = {
        scoutingData: [],
        previousScoutingData: [],
        varietyRequirements: new Map(),
        dataMap: new Map(),
        dataMapPrevious: new Map(),
        showBothReports: false,
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
        susceptibilityData: [],
        kitWarehouse: "",
        selectedTargets: new Set(),
        selectedVarieties: new Set(),
        allTargetOptions: [],
        allVarieties: []
    };

    // ==================== DOM ELEMENTS ====================
    const els = {
        greenhouse: document.getElementById("greenhouse"),
        variety: document.getElementById("variety"),
        varietyDropdownWrapper: document.getElementById("variety-dropdown-wrapper"),
        varietySelectedDisplay: document.getElementById("variety-selected-display"),
        varietyDropdownMenu: document.getElementById("variety-dropdown-menu"),
        varietySearchInput: document.getElementById("variety-search-input"),
        varietyCheckboxesList: document.getElementById("variety-checkboxes-list"),
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
        scheduledApplicationTime: document.getElementById("scheduled-application-time"),
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
        stockTableWrapper: document.getElementById("stock-table-wrapper"),
        targetsContainer: document.getElementById("targets-container"),
        stagesContainer: document.getElementById("stages-container"),
        plantSectionContainer: document.getElementById("plant-section-container"),
        thresholdContainer: document.getElementById("threshold-container"),
        popupOverlay: document.getElementById("global-popup-overlay"),
        popup: document.getElementById("global-popup"),
        popupSearch: document.getElementById("global-popup-search"),
        popupContent: document.getElementById("global-popup-content"),
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
    const getLoaderMsg = () => document.querySelector('#map-loader p');

    const showLoader = (message = 'Loading data...') => {
        const loader = document.getElementById('map-loader');
        const msg = getLoaderMsg();
        if (msg) msg.textContent = message;
        loader.style.display = 'flex';
    };

    const hideLoader = () => {
        document.getElementById('map-loader').style.display = 'none';
        const msg = getLoaderMsg();
        if (msg) msg.textContent = 'Loading data...';
    };

    const setLoaderMessage = (message) => {
        const msg = getLoaderMsg();
        if (msg) msg.textContent = message;
    };

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
                inputElement.value = item;
                const row = inputElement.closest(".chemical-row, .bom-chemical-row");
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
                els.popupOverlay.classList.remove('active');
                els.popupSearch.value = '';
                if (row && row.classList.contains("chemical-row")) {
                    setTimeout(updateStockBalances, 100);
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
    const processScoutingData = (scoutingEntries, reportTag = "latest") => {
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
                        plant_section: plantSection,
                        reportTag
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

    const fetchAllTargets = async () => {
        try {
            const [pestsRes, diseasesRes] = await Promise.all([
                fetch('/api/resource/Pest?fields=["common_name"]&limit_page_length=0', {
                    headers: { 'X-Frappe-CSRF-Token': "{{csrf_token}}" }
                }),
                fetch('/api/resource/Plant Disease?fields=["common_name"]&limit_page_length=0', {
                    headers: { 'X-Frappe-CSRF-Token': "{{csrf_token}}" }
                })
            ]);

            const pestsData = await pestsRes.json();
            const diseasesData = await diseasesRes.json();

            const pests = (pestsData.data || [])
                .map(p => ({ name: p.common_name, type: 'Pest' }))
                .filter(p => p.name && p.name.trim());
                
            const diseases = (diseasesData.data || [])
                .map(d => ({ name: d.common_name, type: 'Disease' }))
                .filter(d => d.name && d.name.trim());

            state.allTargetOptions = [...pests, ...diseases]
                .sort((a, b) => a.name.localeCompare(b.name));
                
            console.log(`Loaded ${pests.length} pests and ${diseases.length} diseases`);
        } catch (error) {
            console.error("Error fetching targets:", error);
            showToast("Failed to load pests/diseases list", "error");
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
        
        // Reset variety selection
        state.selectedVarieties.clear();
        els.varietyCheckboxesList.innerHTML = "";
        updateVarietyDisplay();
        
        els.bom.innerHTML = '<option value="">Select BOM</option>';
        els.bomDetailsContainer.classList.add("tw-hidden");
        renderGrid(0, 0);
        showLoader();
        try {
            const response = await fetch('/api/method/upande_scp.serverscripts.get_scouting_report.getScoutingData', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Frappe-CSRF-Token': "{{csrf_token}}"
                },
                body: JSON.stringify({ greenhouse })
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const r = await response.json();
            const data = r.message || r.data;

            if (!data) {
                els.heatmapGridWrapper.classList.add("tw-hidden");
                document.getElementById('grid-placeholder').classList.remove("tw-hidden");
                return;
            }

            // ── Always process non-scouting data (varieties, BOMs, chemicals, etc.) ──
            if (data.varieties && data.varieties.length > 0) {
                populateVarieties(data.varieties);
            }
            if (data.spray_team_team) {
                populateTeams(data.spray_team_team);
                state.teamData = data.spray_team_team.map(v => v.name);
            }
            if (data.boms) {
                state.bomsData = data.boms;
                state.bomItems = data.bom_items || [];
                state.allChemicals = Array.isArray(data.all_chemicals)
                    ? data.all_chemicals
                        .filter(name => typeof name === 'string' && name.trim().length > 0)
                        .filter((name, idx, arr) => arr.indexOf(name) === idx)
                        .sort()
                    : [];
                populateBoms(state.bomsData);
            }
            state.bedData = data.bed_data || [];
            if (data.susceptibility) {
                state.susceptibilityData = data.susceptibility;
            }

            // ── Scouting-specific processing (only when entries exist) ──
            const hasScoutingData = data.scouting_entries && data.scouting_entries.length > 0;

            if (hasScoutingData) {
                els.heatmapGridWrapper.classList.remove("tw-hidden");
                els.heatmapGridWrapper.classList.add("is-visible-grid");
                state.scoutingData = data.scouting_entries;
                state.previousScoutingData = data.previous_scouting_entries || [];
                state.showBothReports = false;

                // ── Date display + toggle button ──
                const dateDisplay = document.getElementById('scouting-date-display');
                if (dateDisplay) {
                    const fmtDate = (s) => s ? new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null;
                    const latestFmt   = fmtDate(data.scouting_date);
                    const previousFmt = fmtDate(data.previous_scouting_date);

                    state.scoutingDate         = data.scouting_date;
                    state.previousScoutingDate = data.previous_scouting_date;

                    dateDisplay.innerHTML = '';
                    dateDisplay.classList.remove('tw-text-gray-500', 'tw-cursor-not-allowed', 'tw-bg-gray-100');
                    dateDisplay.style.display = 'flex';
                    dateDisplay.style.alignItems = 'center';
                    dateDisplay.style.gap = '10px';
                    dateDisplay.style.flexWrap = 'wrap';
                    dateDisplay.style.padding = '8px 12px';
                    dateDisplay.style.background = '#f9fafb';
                    dateDisplay.style.borderRadius = '8px';
                    dateDisplay.style.border = '1.5px solid #e5e7eb';

                    const dateLabel = document.createElement('span');
                    dateLabel.id = 'report-date-label';
                    dateLabel.style.fontSize = '0.8rem';
                    dateLabel.style.color = '#374151';
                    dateLabel.style.fontWeight = '500';
                    dateLabel.textContent = `Latest: ${latestFmt}`;
                    dateDisplay.appendChild(dateLabel);

                    if (previousFmt && state.previousScoutingData.length > 0) {
                        const toggleBtn = document.createElement('button');
                        toggleBtn.type = 'button';
                        toggleBtn.id = 'report-toggle-btn';
                        toggleBtn.className = 'report-toggle-btn';
                        toggleBtn.textContent = `+ Show ${previousFmt}`;
                        toggleBtn.addEventListener('click', () => {
                            state.showBothReports = !state.showBothReports;
                            const label = document.getElementById('report-date-label');
                            if (state.showBothReports) {
                                label.innerHTML = `<span class="report-dot report-dot-latest"></span>Latest: ${latestFmt} &nbsp;<span class="report-dot report-dot-previous"></span>Previous: ${previousFmt}`;
                                toggleBtn.textContent = `− Hide ${previousFmt}`;
                                toggleBtn.classList.add('report-toggle-btn-active');
                            } else {
                                label.textContent = `Latest: ${latestFmt}`;
                                toggleBtn.textContent = `+ Show ${previousFmt}`;
                                toggleBtn.classList.remove('report-toggle-btn-active');
                            }
                            rebuildDataMap();
                            updateGrid();
                        });
                        dateDisplay.appendChild(toggleBtn);
                    }
                }

                const discoveredTypes = new Set();
                state.scoutingData.forEach(entry => {
                    Object.keys(entry).forEach(key => {
                        if (key.endsWith('_scouting_entry') && Array.isArray(entry[key]) && entry[key].length > 0) {
                            discoveredTypes.add(key);
                        }
                    });
                });
                state.previousScoutingData.forEach(entry => {
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

                const { dataMap: dmLatest, observationsInGreenhouse, stagesInGreenhouse, sectionsInGreenhouse } =
                    processScoutingData(data.scouting_entries, "latest");
                state.dataMapLatest = dmLatest;

                const { dataMap: dmPrevious } =
                    processScoutingData(state.previousScoutingData, "previous");
                state.dataMapPrevious = dmPrevious;

                state.dataMap = dmLatest;

                renderObservationCheckboxes(observationsInGreenhouse);
                populateFinalTargets();
                renderStageCheckboxes([...stagesInGreenhouse]);
                renderPlantSectionCheckboxes([...sectionsInGreenhouse]);

                const allForDimensions = [...data.scouting_entries, ...state.previousScoutingData];
                const { maxBed, maxZone } = findMaxDimensions(allForDimensions);
                const bedNumbering = data.custom_bed_numbering || "Top to Bottom";
                const zoneNumbering = data.custom_zone_numbering || "Right to Left";
                renderGrid(maxBed, maxZone, bedNumbering, zoneNumbering);
                updateGrid();
                els.heatmapGridWrapper.classList.remove("tw-hidden");
            } else {
                // No scouting data — show placeholder for the heatmap, but form fields are already populated above
                state.scoutingData = [];
                state.previousScoutingData = [];
                state.dataMap = new Map();
                state.dataMapLatest = new Map();
                state.dataMapPrevious = new Map();

                els.heatmapGridWrapper.classList.add("tw-hidden");
                document.getElementById('grid-placeholder').classList.remove("tw-hidden");

                const dateDisplay = document.getElementById('scouting-date-display');
                if (dateDisplay) {
                    dateDisplay.innerHTML = '';
                    dateDisplay.textContent = 'No scouting reports found for this greenhouse.';
                    dateDisplay.classList.add('tw-text-gray-500');
                }
            }

            // ── Always render threshold checkboxes ──
            renderThresholdCheckboxes(els.variety.value);

        } catch (error) {
            els.heatmapGridWrapper.classList.add("tw-hidden");
            document.getElementById('grid-placeholder').classList.remove("tw-hidden");
            const dateDisplay = document.getElementById('scouting-date-display');
            if (dateDisplay) {
                dateDisplay.textContent = 'No scouting data found for this greenhouse.';
                dateDisplay.classList.add('tw-text-gray-500');
            }
        } finally {
            hideLoader();
        }
    };

    const rebuildDataMap = () => {
        if (!state.showBothReports) {
            state.dataMap = state.dataMapLatest;
            return;
        }
        const merged = new Map(state.dataMapLatest);
        state.dataMapPrevious.forEach((obs, key) => {
            if (merged.has(key)) {
                merged.set(key, [...merged.get(key), ...obs]);
            } else {
                merged.set(key, [...obs]);
            }
        });
        state.dataMap = merged;
    };

    // ==================== RENDERING FUNCTIONS ====================
    let _gridState = { maxBed: 0, maxZone: 0, bedNumbering: "Top to Bottom", zoneNumbering: "Right to Left" };

    const renderGrid = (numBeds, zonesPerBed, bedNumbering = "Top to Bottom", zoneNumbering = "Right to Left") => {
        _gridState = { maxBed: numBeds, maxZone: zonesPerBed, bedNumbering, zoneNumbering };
        els.mainGrid.innerHTML = "";
        els.xAxisLabels.innerHTML = "";
        els.yAxisLabels.innerHTML = "";
    };

    // ==================== HEATMAP CARD HELPERS ====================
    const getIntensityClass = (count, max) => {
        if (!count || count === 0) return 'hm-intensity-0';
        const r = count / max;
        if (r <= 0.2) return 'hm-intensity-1';
        if (r <= 0.4) return 'hm-intensity-2';
        if (r <= 0.6) return 'hm-intensity-3';
        if (r <= 0.8) return 'hm-intensity-4';
        return 'hm-intensity-5';
    };

    const buildObservationCard = (obsName, obsColor, matrix, maxCount, total, alertLevel) => {
        const { maxBed, maxZone, bedNumbering, zoneNumbering } = _gridState;

        const card = document.createElement('div');
        card.className = 'hm-card';

        const header = document.createElement('div');
        header.className = 'hm-card-header';

        const badgeHtml = alertLevel === 3
            ? `<span class="hm-threshold-badge hm-badge-high">High</span>`
            : alertLevel === 2
            ? `<span class="hm-threshold-badge hm-badge-moderate">Moderate</span>`
            : alertLevel === 1
            ? `<span class="hm-threshold-badge hm-badge-low">Low</span>`
            : '';

        header.innerHTML = `
            <span class="hm-card-title" style="color:${obsColor}">${obsName}</span>
            <span style="display:flex;align-items:center;gap:6px;">
                ${badgeHtml}
                <span class="hm-card-total">Total: ${total}</span>
            </span>
        `;
        card.appendChild(header);

        const buildGrid = (cellSize = 18) => {
            const gridWrap = document.createElement('div');
            gridWrap.className = 'hm-grid-wrap';

            const grid = document.createElement('div');
            grid.className = 'hm-grid';
            grid.style.gridTemplateColumns = `30px repeat(${maxZone}, 1fr)`;

            const zoneRange = zoneNumbering === "Right to Left"
                ? Array.from({ length: maxZone }, (_, i) => maxZone - i)
                : Array.from({ length: maxZone }, (_, i) => i + 1);

            const bedRange = bedNumbering === "Top to Bottom"
                ? Array.from({ length: maxBed }, (_, i) => maxBed - i)
                : Array.from({ length: maxBed }, (_, i) => i + 1);

            const corner = document.createElement('div');
            corner.className = 'hm-corner';
            corner.style.height = `${cellSize}px`;
            grid.appendChild(corner);

            zoneRange.forEach(z => {
                const lbl = document.createElement('div');
                lbl.className = 'hm-zone-lbl';
                lbl.textContent = z;
                lbl.style.height = `${cellSize}px`;
                grid.appendChild(lbl);
            });

            bedRange.forEach(bed => {
                const bedLbl = document.createElement('div');
                bedLbl.className = 'hm-bed-lbl';
                bedLbl.textContent = bed;
                bedLbl.style.height = `${cellSize}px`;
                grid.appendChild(bedLbl);

                zoneRange.forEach(zone => {
                    const obsData = (matrix[bed] && matrix[bed][zone]) ? matrix[bed][zone] : null;
                    const cnt      = obsData ? obsData.count : 0;
                    const zoneAlert = obsData ? (obsData.alertLevel || 0) : 0;

                    const cell = document.createElement('div');
                    cell.className = `hm-data-cell ${getIntensityClass(cnt, maxCount)}`;
                    cell.style.height = `${cellSize}px`;

                    if (cnt > 0) cell.style.backgroundColor = obsColor;

                    const isPrevious = obsData && obsData.reportTag === 'previous';
                    if (isPrevious && cnt > 0) {
                        cell.style.backgroundImage = `repeating-linear-gradient(
                            -45deg,
                            transparent,
                            transparent 3px,
                            rgba(0,0,0,0.25) 3px,
                            rgba(0,0,0,0.25) 4px
                        ), linear-gradient(${obsColor}, ${obsColor})`;
                        cell.style.backgroundBlendMode = 'multiply';
                    }

                    if (zoneAlert === 3) {
                        cell.style.outline = '2px solid #dc2626';
                        cell.style.outlineOffset = '-2px';
                        cell.style.zIndex = '5';
                    } else if (zoneAlert === 2) {
                        cell.style.outline = '2px solid #f59e0b';
                        cell.style.outlineOffset = '-2px';
                        cell.style.zIndex = '5';
                    } else if (zoneAlert === 1) {
                        cell.style.outline = '2px solid #10b981';
                        cell.style.outlineOffset = '-2px';
                        cell.style.zIndex = '5';
                    }

                    const thresholdLabel = zoneAlert === 3 ? 'High' : zoneAlert === 2 ? 'Moderate' : zoneAlert === 1 ? 'Low' : null;
                    const thresholdHtml  = thresholdLabel
                        ? `<span style="color:${zoneAlert === 3 ? '#f87171' : zoneAlert === 2 ? '#fbbf24' : '#34d399'}">⬤ ${thresholdLabel} requirement</span>`
                        : '';

                    const tip = document.createElement('div');
                    tip.className = 'hm-cell-tooltip';
                    const reportLabel = isPrevious ? ' <span style="color:#fbbf24">(prev)</span>' : '';
                    tip.innerHTML = obsData
                        ? `<strong>B${bed} Z${zone}</strong>${reportLabel} — ${obsName}: <strong>${cnt}</strong>${obsData.symbol ? ' ' + obsData.symbol : ''}${thresholdLabel ? '<br>' + thresholdHtml : ''}`
                        : `<strong>B${bed} Z${zone}</strong> — None`;
                    cell.appendChild(tip);

                    cell.addEventListener('mouseenter', () => {
                        const rect = cell.getBoundingClientRect();
                        tip.style.top    = '100%';
                        tip.style.bottom = 'auto';
                        tip.style.marginTop = '4px';
                        if (rect.left < window.innerWidth / 3) {
                            tip.style.left      = '0';
                            tip.style.right     = 'auto';
                            tip.style.transform = '';
                        } else if (rect.right > window.innerWidth * 2 / 3) {
                            tip.style.right     = '0';
                            tip.style.left      = 'auto';
                            tip.style.transform = '';
                        } else {
                            tip.style.left      = '50%';
                            tip.style.right     = 'auto';
                            tip.style.transform = 'translateX(-50%)';
                        }
                    });

                    grid.appendChild(cell);
                });
            });

            gridWrap.appendChild(grid);
            return gridWrap;
        };

        card.appendChild(buildGrid(18));

        const legend = document.createElement('div');
        legend.className = 'hm-legend';
        legend.innerHTML = `
            <span class="hm-legend-item"><span class="hm-legend-box hm-intensity-0"></span> None</span>
            <span class="hm-legend-item"><span class="hm-legend-box hm-intensity-2" style="background:${obsColor}"></span> Low</span>
            <span class="hm-legend-item"><span class="hm-legend-box hm-intensity-4" style="background:${obsColor}"></span> Med</span>
            <span class="hm-legend-item"><span class="hm-legend-box hm-intensity-5" style="background:${obsColor}"></span> High</span>
            ${state.showBothReports ? `<span class="hm-legend-item"><span class="hm-legend-box hm-legend-box-striped" style="background:${obsColor}"></span> Prev. report</span>` : ''}
            <span class="hm-legend-max">Max: ${maxCount}</span>
        `;
        card.appendChild(legend);

        card.style.cursor = 'pointer';
        card.addEventListener('click', () => {
            const overlay = document.createElement('div');
            overlay.className = 'hm-fullscreen-overlay';
            const modal = document.createElement('div');
            modal.className = 'hm-fullscreen-modal';
            const mHeader = document.createElement('div');
            mHeader.className = 'hm-fullscreen-header';
            mHeader.innerHTML = `
                <div style="display:flex;align-items:center;gap:10px;">
                    <span style="font-size:1.1rem;font-weight:700;color:${obsColor}">${obsName}</span>
                    ${badgeHtml}
                    <span style="font-size:0.8rem;color:#6b7280">Total: ${total} &nbsp;|&nbsp; Max per zone: ${maxCount}</span>
                </div>
                <button class="hm-fullscreen-close" title="Close (Esc)">×</button>
            `;
            modal.appendChild(mHeader);
            const mBody = document.createElement('div');
            mBody.className = 'hm-fullscreen-body';
            mBody.appendChild(buildGrid(28));
            modal.appendChild(mBody);
            const mLegend = document.createElement('div');
            mLegend.className = 'hm-legend';
            mLegend.style.padding = '12px 16px';
            mLegend.innerHTML = `
                <span class="hm-legend-item"><span class="hm-legend-box hm-intensity-0"></span> None</span>
                <span class="hm-legend-item"><span class="hm-legend-box hm-intensity-2" style="background:${obsColor}"></span> Low</span>
                <span class="hm-legend-item"><span class="hm-legend-box hm-intensity-4" style="background:${obsColor}"></span> Med</span>
                <span class="hm-legend-item"><span class="hm-legend-box hm-intensity-5" style="background:${obsColor}"></span> High</span>
                ${state.showBothReports ? `<span class="hm-legend-item"><span class="hm-legend-box hm-legend-box-striped" style="background:${obsColor}"></span> Prev. report</span>` : ''}
                ${alertLevel > 0 ? `
                <span class="hm-legend-item" style="margin-left:16px;">
                    <span style="display:inline-block;width:14px;height:10px;border:2px solid ${alertLevel===3?'#dc2626':alertLevel===2?'#f59e0b':'#10b981'};border-radius:2px;"></span>
                    &nbsp;${alertLevel===3?'High':alertLevel===2?'Moderate':'Low'} requirement zone
                </span>` : ''}
            `;
            modal.appendChild(mLegend);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);
            const close = () => overlay.remove();
            mHeader.querySelector('.hm-fullscreen-close').addEventListener('click', close);
            overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
            document.addEventListener('keydown', function onKey(e) {
                if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
            });
        });

        return card;
    };

    // ==================== UPDATE GRID ====================
    const updateGrid = () => {
        if (!els.greenhouse.value || state.scoutingData.length === 0) return;

        const { maxBed, maxZone } = _gridState;
        if (maxBed === 0 || maxZone === 0) return;

        const { activeObs, activeStages, activeSections, activeRequirements } = getActiveFilters();
        
        // Get selected varieties for threshold calculation
        const selectedVarieties = Array.from(state.selectedVarieties);
        const hasAllVarieties = selectedVarieties.includes('__all__');

        const TYPE_MAP = {
            'diseases_scouting_entry': 'disease',
            'pests_scouting_entry': 'pest',
            'weeds_scouting_entry': 'weed',
            'physiological_disorders_entry': 'physiological_disorder',
            'incidents_scouting_entry': 'incident'
        };

        const obsMatrices = {};
        const obsColors   = {};
        const obsSymbols  = {};
        const obsAlerts   = {};

        state.dataMap.forEach((observationsInZone, key) => {
            const [bed, zone] = key.split('-').map(Number);

            observationsInZone.forEach(obs => {
                const obsType = obs.type;
                const activeObsOfType = activeObs[obsType] || [];

                const isObservationActive = activeObsOfType.includes(obs.name);
                const isStageActive  = obs.stage === "N/A" || activeStages.includes(obs.stage);
                const isSectionActive = obs.plant_section === "N/A" || activeSections.includes(obs.plant_section);

                if (!isObservationActive || !isStageActive || !isSectionActive) return;

                const name = obs.name;

                if (!obsMatrices[name]) {
                    obsMatrices[name] = {};
                    obsColors[name]   = obs.color || '#6b7280';
                    obsAlerts[name]   = 0;
                }

                if (!obsMatrices[name][bed]) obsMatrices[name][bed] = {};

                const existing = obsMatrices[name][bed][zone];
                if (!existing) {
                    obsMatrices[name][bed][zone] = {
                        count: 0,
                        symbol: obs.symbol || '',
                        plant_section: obs.plant_section || 'N/A',
                        alertLevel: 0,
                        reportTag: obs.reportTag || 'latest'
                    };
                }
                if (obs.reportTag === 'latest') {
                    obsMatrices[name][bed][zone].reportTag = 'latest';
                }
                obsMatrices[name][bed][zone].count += (obs.count || 1);

                // Threshold — skip when "All Varieties" is selected or no varieties selected
                if (!hasAllVarieties && selectedVarieties.length > 0) {
                    const obsTypeClean = TYPE_MAP[obsType] || obsType.replace('_scouting_entry', '');
                    
                    // Check threshold for each selected variety
                    selectedVarieties.forEach(selectedVariety => {
                        const sus = state.susceptibilityData.find(s => s.observation === name && s.type === obsTypeClean);
                        if (sus && sus.requirement_by_variety[selectedVariety]) {
                            const level = sus.requirement_by_variety[selectedVariety];
                            if (level !== "unknown" && activeRequirements.includes(level)) {
                                const lvlNum = level === 'high' ? 3 : level === 'moderate' ? 2 : 1;
                                obsMatrices[name][bed][zone].alertLevel = Math.max(obsMatrices[name][bed][zone].alertLevel, lvlNum);
                                obsAlerts[name] = Math.max(obsAlerts[name], lvlNum);
                            }
                        }
                    });
                }
            });
        });

        els.mainGrid.innerHTML = "";

        const obsNames = Object.keys(obsMatrices);

        if (obsNames.length === 0) {
            els.mainGrid.innerHTML = `
                <div class="hm-empty">
                    <p>No observations match the current filters.</p>
                </div>`;
            return;
        }

        obsNames.sort().forEach(name => {
            const matrix = obsMatrices[name];
            const color  = obsColors[name];
            const alert  = obsAlerts[name];

            let maxCount = 0;
            let total    = 0;
            Object.values(matrix).forEach(bedRow => {
                Object.values(bedRow).forEach(cell => {
                    total    += cell.count;
                    maxCount  = Math.max(maxCount, cell.count);
                });
            });

            const card = buildObservationCard(name, color, matrix, maxCount, total, alert);
            els.mainGrid.appendChild(card);
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
            metadataList.forEach(o => { allObservationNames.add(o.name || o); });
            observationsOfType.forEach(name => { allObservationNames.add(name); });

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
        const selectedVarieties = Array.from(state.selectedVarieties);
        const hasAllVarieties = selectedVarieties.includes('__all__');
        const hasData = state.susceptibilityData.length > 0 && selectedVarieties.length > 0 && !hasAllVarieties;
        
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
        } else if (hasAllVarieties) {
            els.thresholdMessage.innerHTML = `<strong>Threshold filtering not available when "All Varieties" is selected.</strong>`;
            els.thresholdMessage.classList.remove("tw-hidden");
        } else if (selectedVarieties.length === 0) {
            els.thresholdMessage.innerHTML = `<strong>Please select at least one variety to enable threshold filtering.</strong>`;
            els.thresholdMessage.classList.remove("tw-hidden");
        } else {
            els.thresholdMessage.innerHTML = `<strong>No susceptibility data for selected varieties.</strong>`;
            els.thresholdMessage.classList.remove("tw-hidden");
        }
    };

    // Render a status message into the stock table wrapper
    const setStockMessage = (msg, colorClass = "tw-text-gray-500") => {
        els.stockTableWrapper.innerHTML =
            `<table class="stock-table"><tbody><tr><td colspan="10" class="tw-text-center tw-py-6 ${colorClass}">${msg}</td></tr></tbody></table>`;
    };

    // Build one table section (chemicals OR fertilizers) and return its HTML
    const buildStockSection = (balances, warehouses, itemLabel) => {
        const itemNames = Object.keys(balances).sort();
        if (itemNames.length === 0) return "";

        // Header row: item | warehouse columns... | source | total
        let thead = `<thead>
            <tr>
                <th rowspan="2">${itemLabel}</th>
                <th colspan="${warehouses.length}" class="tw-text-center">${itemLabel} Warehouses</th>
                <th rowspan="2" class="tw-text-center">Source</th>
                <th rowspan="2" class="tw-text-center">Total</th>
            </tr><tr>`;
        warehouses.forEach(wh => {
            thead += `<th class="tw-text-center">${wh.split(" ")[2]}</th>`;
        });
        thead += `</tr></thead>`;

        let tbody = "<tbody>";
        itemNames.forEach(itemName => {
            const itemBalances = balances[itemName];
            let totalStock = 0;
            state.sourceWarehouseCache[itemName] = state.sourceWarehouseCache[itemName] || { source_warehouse: null };
            const cachedWh = state.sourceWarehouseCache[itemName].source_warehouse;
            let whCells = "";
            let selectOpts = '<option value="">-- Select Source --</option>';
            warehouses.forEach(wh => {
                const qty = itemBalances[wh] || 0.0;
                totalStock += qty;
                const qtyFmt = qty.toFixed(2);
                const qtyClass = qty === 0.0 ? "stock-qty-zero" : "stock-qty-available";
                whCells += `<td class="tw-text-center ${qtyClass}">${qtyFmt}</td>`;
                if (qty > 0) {
                    const label = wh.split(" - ")[0];
                    const sel = cachedWh === wh ? " selected" : "";
                    selectOpts += `<option value="${wh}"${sel}>${label} (${qtyFmt})</option>`;
                }
            });
            const totalClass = totalStock === 0.0 ? "stock-total stock-total-insufficient" : "stock-total";
            // Escape item name for use in id attribute (spaces → underscores)
            const safeId = itemName.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, "");
            tbody += `<tr>
                <td>${itemName}</td>
                ${whCells}
                <td><select id="select-wh-${safeId}" class="form-select" data-item-code="${itemName}" onchange="handleWarehouseChange(this)">${selectOpts}</select></td>
                <td class="tw-text-center ${totalClass}">${totalStock.toFixed(2)}</td>
            </tr>`;
        });
        tbody += "</tbody>";

        return `<table class="stock-table">${thead}${tbody}</table>`;
    };

    const renderStockTable = (balances, allWarehouses) => {
        els.stockBalancesContainer.classList.remove("tw-hidden");
        const html = buildStockSection(balances, allWarehouses, "Chemical");
        els.stockTableWrapper.innerHTML = html ||
            `<table class="stock-table"><tbody><tr><td colspan="10" class="tw-text-center tw-py-6 tw-text-gray-500">No stock data available</td></tr></tbody></table>`;
    };

    const createBomChemicalRow = (itemName = "", rate = "", uom = "") => {
        const row = document.createElement("div");
        row.className = "bom-chemical-row";
        row.style.display = "grid";
        row.style.gridTemplateColumns = "2fr 1fr 1fr auto";
        row.style.gap = "12px";
        row.style.alignItems = "center";

        const nameInp = document.createElement("input");
        nameInp.type = "text";
        nameInp.className = "form-input bom-chemical-name-input";
        nameInp.value = itemName;
        nameInp.placeholder = "Chemical";
        nameInp.addEventListener("focus", async e => {
            if (!state.allChemicals.length) await fetchChemicals();
            showPopup(e.target, state.allChemicals);
        });

        const rateInp = document.createElement("input");
        rateInp.type = "number";
        rateInp.className = "form-input bom-chemical-rate-input";
        rateInp.value = rate;
        rateInp.min = "0";
        rateInp.step = "0.01";
        rateInp.placeholder = "Rate/1000 L";

        const uomInp = document.createElement("input");
        uomInp.type = "text";
        uomInp.className = "form-input bom-chemical-uom-input";
        uomInp.value = uom;
        uomInp.readOnly = true;
        uomInp.placeholder = "UOM";

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
        if (state.allChemicals.length === 0) { await fetchChemicals(); }
        updateStockBalances();
    };

    const closeBomModal = () => { els.bomModalOverlay.classList.remove('active'); };

    const getBomChemicals = () => {
        return Array.from(els.bomModalChemicalsList.querySelectorAll(".bom-chemical-row"))
            .map(row => {
                const name = row.querySelector(".bom-chemical-name-input")?.value.trim();
                const rate = parseFloat(row.querySelector(".bom-chemical-rate-input")?.value) || 0;
                const uom = row.querySelector(".bom-chemical-uom-input")?.value || "";
                if (!name || rate <= 0) return null;
                return { item_name: name, custom_application_rate: rate, uom };
            })
            .filter(Boolean);
    };

    const createBOM = async () => {
        const itemName = els.bomItemName.value.trim();
        const waterPh = parseFloat(els.bomWaterPh.value);
        const waterHardness = parseFloat(els.bomWaterHardness.value);
        const chemicals = getBomChemicals();
        if (!itemName) { showToast("Please enter a BOM name", "error"); return; }
        if (!waterPh || waterPh <= 0) { showToast("Please enter a valid water pH", "error"); return; }
        if (!waterHardness || waterHardness <= 0) { showToast("Please enter a valid water hardness", "error"); return; }
        if (chemicals.length === 0) { showToast("Please add at least one chemical", "error"); return; }
        const invalidChemicals = chemicals.filter(c => !c.custom_application_rate || c.custom_application_rate <= 0);
        if (invalidChemicals.length > 0) { showToast("All chemicals must have a valid rate", "error"); return; }

        const bomData = { item: itemName, custom_water_ph: waterPh, custom_water_hardness: waterHardness, items: chemicals };
        showLoader();
        try {
            const response = await fetch('/api/method/upande_scp.serverscripts.create_bom.createBOM', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Frappe-CSRF-Token': "{{csrf_token}}" },
                body: JSON.stringify(bomData)
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const r = await response.json();
            const result = r.message || r.data;
            if (result && result.status === "success") {
                showToast(`BOM "${result.bom_name}" created successfully!`, "success");
                closeBomModal();
                if (els.greenhouse.value) { await fetchScoutingData(els.greenhouse.value); }
                els.bom.value = result.bom_name;
                populateBomDetails(result.bom_name);
            } else {
                showToast(`Error creating BOM: ${result?.message || "Unknown error"}`, "error");
            }
        } catch (error) {
            console.error("BOM Creation Error:", error);
            showToast("An error occurred while creating the BOM. Please try again.", "error");
        } finally { hideLoader(); }
    };

    els.createNewBomBtn.addEventListener("click", openBomModal);
    els.closeBomModalBtn.addEventListener("click", closeBomModal);
    els.cancelBomBtn.addEventListener("click", closeBomModal);
    els.saveBomBtn.addEventListener("click", createBOM);
    els.addBomChemicalBtn.addEventListener("click", () => { els.bomModalChemicalsList.appendChild(createBomChemicalRow()); });
    els.bomModalOverlay.addEventListener("click", (e) => { if (e.target === els.bomModalOverlay) closeBomModal(); });

    els.kit.addEventListener("change", (e) => {
        const selectedOption = e.target.options[e.target.selectedIndex];
        state.kitWarehouse = selectedOption?.dataset.warehouse || "";
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
        const uniqueItems = [...new Set(chemicals.map(c => c.chemical).filter(name => name && name.trim()))];
        if (uniqueItems.length === 0) {
            setStockMessage("No items to check", "tw-text-red-500");
            return;
        }
        setStockMessage("Fetching stock balances...");
        showLoader();
        try {
            const response = await fetch('/api/method/upande_scp.serverscripts.get_bom_stock_balances.getBomStockBalances', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Frappe-CSRF-Token': "{{csrf_token}}" },
                body: JSON.stringify({ data: JSON.stringify({ chemicals: uniqueItems }) })
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const r = await response.json();
            const data = r.message || r.data;
            if (data) {
                const stockData = data.stock_balances;
                if (data.item_uom_map) { state.chemicalUomCache = { ...state.chemicalUomCache, ...data.item_uom_map }; refreshRowUoms(); }
                if (stockData && Object.keys(stockData).length > 0) {
                    const firstItem = Object.keys(stockData)[0];
                    const allWarehouses = Object.keys(stockData[firstItem]);
                    renderStockTable(stockData, allWarehouses);
                } else { setStockMessage("No stock data found"); }
            } else { setStockMessage("No stock data found"); }
        } catch (error) {
            setStockMessage("Error fetching stock balances", "tw-text-red-500");
        } finally { hideLoader(); }
    };

    // ==================== POPULATE VARIETIES (with multi-select checkboxes) ====================
    const populateVarieties = (varieties) => {
        state.allVarieties = varieties;

        // Hidden select for backward compatibility
        els.variety.innerHTML = '<option value="">Select variety</option>';
        
        // Clear checkboxes list
        els.varietyCheckboxesList.innerHTML = "";
        
        varieties.forEach((v) => {
            // Add to hidden select
            const option = document.createElement("option");
            option.value = v.name;
            option.textContent = v.name;
            els.variety.appendChild(option);
            
            // Add checkbox item
            const label = document.createElement("label");
            label.className = "variety-checkbox-item";
            label.innerHTML = `
                <input type="checkbox" value="${v.name}" class="variety-checkbox" style="margin-right: 8px;">
                <span>${v.name}</span>
            `;
            els.varietyCheckboxesList.appendChild(label);
        });
        
        // Setup event listeners for checkboxes
        setupVarietyCheckboxes();

        // Multi-select for scope "Specific Variety"
        els.varietyMultiSelect.innerHTML = "";
        varieties.forEach((v) => {
            const option = document.createElement("option");
            option.value = v.name;
            option.textContent = v.name;
            els.varietyMultiSelect.appendChild(option);
        });

        // Add "Select All / Deselect All" toggle button
        renderVarietySelectAllToggle();
    };

    const setupVarietyCheckboxes = () => {
        const allCheckbox = els.varietyDropdownMenu.querySelector('input[value="__all__"]');
        const varietyCheckboxes = els.varietyCheckboxesList.querySelectorAll('.variety-checkbox');
        
        // Handle "All Varieties" checkbox
        if (allCheckbox) {
            allCheckbox.addEventListener('change', (e) => {
                const isChecked = e.target.checked;
                varietyCheckboxes.forEach(cb => cb.checked = isChecked);
                
                if (isChecked) {
                    state.selectedVarieties = new Set(['__all__']);
                } else {
                    state.selectedVarieties.clear();
                }
                updateVarietyDisplay();
            });
        }
        
        // Handle individual variety checkboxes
        varietyCheckboxes.forEach(cb => {
            cb.addEventListener('change', () => {
                if (cb.checked) {
                    state.selectedVarieties.add(cb.value);
                    // Uncheck "All Varieties" if an individual is selected
                    if (allCheckbox) allCheckbox.checked = false;
                    state.selectedVarieties.delete('__all__');
                } else {
                    state.selectedVarieties.delete(cb.value);
                }
                updateVarietyDisplay();
            });
        });
        
        // Search functionality
        if (els.varietySearchInput) {
            els.varietySearchInput.addEventListener('input', (e) => {
                const searchTerm = e.target.value.toLowerCase();
                varietyCheckboxes.forEach(cb => {
                    const label = cb.closest('.variety-checkbox-item');
                    const text = label.textContent.toLowerCase();
                    label.style.display = text.includes(searchTerm) ? 'flex' : 'none';
                });
            });
        }
    };

    const updateVarietyDisplay = () => {
        const selectedArray = Array.from(state.selectedVarieties);
        
        if (selectedArray.length === 0) {
            els.varietySelectedDisplay.innerHTML = '<span class="tw-text-gray-500">Select varieties...</span>';
            els.variety.value = "";
        } else if (selectedArray.includes('__all__')) {
            els.varietySelectedDisplay.innerHTML = '<span class="variety-pill">All Varieties</span>';
            els.variety.value = "__all__";
        } else {
            const pillsHtml = selectedArray.map(v => 
                `<span class="variety-pill">${v}<button type="button" class="variety-pill-remove" data-variety="${v}">×</button></span>`
            ).join('');
            els.varietySelectedDisplay.innerHTML = pillsHtml;
            
            // Set first selected variety in hidden select for threshold logic
            els.variety.value = selectedArray[0];
            
            // Add remove handlers
            els.varietySelectedDisplay.querySelectorAll('.variety-pill-remove').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const variety = btn.dataset.variety;
                    state.selectedVarieties.delete(variety);
                    const checkbox = els.varietyCheckboxesList.querySelector(`input[value="${variety}"]`);
                    if (checkbox) checkbox.checked = false;
                    updateVarietyDisplay();
                });
            });
        }
        
        // Trigger threshold and grid updates
        renderThresholdCheckboxes(els.variety.value);
        updateGrid();
    };

    // Toggle dropdown on click
    if (els.varietySelectedDisplay) {
        els.varietySelectedDisplay.addEventListener('click', () => {
            const isVisible = els.varietyDropdownMenu.style.display === 'block';
            els.varietyDropdownMenu.style.display = isVisible ? 'none' : 'block';
        });
    }

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (els.varietyDropdownWrapper && !els.varietyDropdownWrapper.contains(e.target)) {
            if (els.varietyDropdownMenu) {
                els.varietyDropdownMenu.style.display = 'none';
            }
        }
    });

    // ==================== "Select All / Deselect All" toggle for multi-select ====================
    const renderVarietySelectAllToggle = () => {
        const existingToggle = document.getElementById('variety-select-all-toggle');
        if (existingToggle) existingToggle.remove();

        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.id = 'variety-select-all-toggle';
        toggleBtn.className = 'farm-btn';
        toggleBtn.style.marginTop = '6px';
        toggleBtn.style.fontSize = '0.75rem';
        toggleBtn.style.padding = '4px 10px';
        toggleBtn.textContent = 'Select All Varieties';

        let allSelected = false;

        toggleBtn.addEventListener('click', () => {
            allSelected = !allSelected;
            const options = els.varietyMultiSelect.options;
            for (let i = 0; i < options.length; i++) {
                options[i].selected = allSelected;
            }
            toggleBtn.textContent = allSelected ? 'Deselect All Varieties' : 'Select All Varieties';
            els.varietyMultiSelect.dispatchEvent(new Event('change'));
        });

        els.varietyMultiSelect.parentNode.insertBefore(toggleBtn, els.varietyMultiSelect.nextSibling);
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
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "tw-chemical-name-input form-input";
        nameInput.value = itemName;
        nameInput.placeholder = "Chemical";
        nameInput.readOnly = !!itemName;
        nameInput.addEventListener("focus", e => showPopup(e.target, state.allChemicals));
        nameInput.addEventListener("input", () => { clearTimeout(nameInput._debounce); nameInput._debounce = setTimeout(updateStockBalances, 500); });
        const rateInput = document.createElement("input");
        rateInput.type = "number";
        rateInput.className = "tw-chemical-qty-input form-input";
        rateInput.value = rate;
        rateInput.min = "0";
        rateInput.step = "0.01";
        rateInput.placeholder = "Rate/1000 L";
        rateInput.addEventListener("input", updateStockBalances);
        const uomInput = document.createElement("input");
        uomInput.type = "text";
        uomInput.className = "tw-chemical-uom-input form-input";
        uomInput.value = uom;
        uomInput.readOnly = true;
        uomInput.placeholder = "UoM";
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
        const scoutingTargets = new Set();
        state.scoutingData.forEach(entry => {
            state.activeObservationTypes.forEach(obsType => {
                (entry[obsType] || []).forEach(obs => { if (obs.name) scoutingTargets.add(obs.name); });
            });
        });
        scoutingTargets.forEach(name => {
            if (!state.allTargetOptions.find(t => t.name === name)) {
                state.allTargetOptions.push({ name, type: 'Scouting' });
            }
        });
        state.allTargetOptions.sort((a, b) => a.name.localeCompare(b.name));
    };

    // ==================== TARGET AUTOCOMPLETE + PILLS ====================
    const targetInput = document.getElementById("target-autocomplete-input");
    const targetDropdown = document.getElementById("target-autocomplete-dropdown");
    const targetPillsContainer = document.getElementById("target-pills-container");

    const renderTargetPills = () => {
        targetPillsContainer.innerHTML = "";
        state.selectedTargets.forEach(target => {
            const pill = document.createElement("span");
            pill.className = "target-pill";
            pill.innerHTML = `${target} <button type="button" class="target-pill-remove" data-target="${target}">×</button>`;
            targetPillsContainer.appendChild(pill);
        });
        targetPillsContainer.querySelectorAll(".target-pill-remove").forEach(btn => {
            btn.addEventListener("click", () => { state.selectedTargets.delete(btn.dataset.target); renderTargetPills(); });
        });
    };

    const showTargetDropdown = (filter = "") => {
        const filterUpper = filter.toUpperCase();
        const matches = state.allTargetOptions.filter(t =>
            !state.selectedTargets.has(t.name) && t.name.toUpperCase().includes(filterUpper)
        );
        if (matches.length === 0 && filter.trim()) {
            targetDropdown.innerHTML = `<div class="target-dropdown-item target-dropdown-custom" data-value="${filter.trim()}">+ Add "${filter.trim()}"</div>`;
        } else if (matches.length === 0) {
            targetDropdown.innerHTML = `<div class="target-dropdown-empty">Type to search pests & diseases...</div>`;
        } else {
            targetDropdown.innerHTML = matches.slice(0, 20).map(t =>
                `<div class="target-dropdown-item" data-value="${t.name}">
                    <span>${t.name}</span>
                    <span class="target-type-badge target-type-${t.type.toLowerCase()}">${t.type}</span>
                </div>`
            ).join("");
            if (filter.trim() && !matches.find(m => m.name.toUpperCase() === filterUpper)) {
                targetDropdown.innerHTML += `<div class="target-dropdown-item target-dropdown-custom" data-value="${filter.trim()}">+ Add "${filter.trim()}"</div>`;
            }
        }
        targetDropdown.classList.add("active");
        targetDropdown.querySelectorAll(".target-dropdown-item").forEach(item => {
            item.addEventListener("click", () => {
                state.selectedTargets.add(item.dataset.value);
                renderTargetPills();
                targetInput.value = "";
                targetDropdown.classList.remove("active");
                targetInput.focus();
            });
        });
    };

    targetInput.addEventListener("focus", async () => {
        if (state.allTargetOptions.length === 0) await fetchAllTargets();
        showTargetDropdown(targetInput.value);
    });
    targetInput.addEventListener("input", () => { showTargetDropdown(targetInput.value); });
    targetInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            const val = targetInput.value.trim();
            if (val) { state.selectedTargets.add(val); renderTargetPills(); targetInput.value = ""; targetDropdown.classList.remove("active"); }
        }
        if (e.key === "Escape") { targetDropdown.classList.remove("active"); }
    });
    document.addEventListener("click", (e) => {
        if (!e.target.closest("#target-autocomplete-wrapper")) { targetDropdown.classList.remove("active"); }
    });

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
        } else { els.bomDetailsContainer.classList.add("tw-hidden"); }
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
            const nameInput = row.querySelector(isBomRow ? ".bom-chemical-name-input" : ".tw-chemical-name-input");
            const uomInput = row.querySelector(isBomRow ? ".bom-chemical-uom-input" : ".tw-chemical-uom-input");
            if (nameInput && uomInput) {
                const name = nameInput.value.trim();
                if (name && state.chemicalUomCache[name]) { uomInput.value = state.chemicalUomCache[name]; }
            }
        });
    };

    window.handleWarehouseChange = function (element) {
        const itemCode = element.getAttribute("data-item-code");
        const warehouse = element.value;
        if (state.sourceWarehouseCache[itemCode]) { state.sourceWarehouseCache[itemCode].source_warehouse = warehouse || null; }
    };

    // ==================== EVENT LISTENERS ====================
    els.greenhouse.addEventListener("change", async (e) => {
        if (e.target.value) {
            els.sprayType.value = "";
            els.kit.value = "";
            state.kitWarehouse = "";
            state.selectedTargets = new Set();
            state.selectedVarieties = new Set();
            state.showBothReports = false;
            state.dataMapLatest = new Map();
            state.dataMapPrevious = new Map();
            els.scope.value = "";
            els.bom.value = "";
            els.waterPh.value = "";
            els.waterHardness.value = "";
            els.waterVolume.value = "";
            els.areaToSpray.value = "";
            if (els.scheduledApplicationTime) els.scheduledApplicationTime.value = "";
            els.bomDetailsContainer.classList.add("tw-hidden");
            els.bomChemicalsList.innerHTML = "";
            els.stockBalancesContainer.classList.add("tw-hidden");
            els.stockTableWrapper.innerHTML = "";
            
            // Fetch scouting data and all targets in parallel
            await Promise.all([
                fetchScoutingData(e.target.value),
                fetchAllTargets()
            ]);
        }
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

        // Update the "Select All" toggle button label
        const toggleBtn = document.getElementById('variety-select-all-toggle');
        if (toggleBtn) {
            const allSelected = selectedOptions.length === els.varietyMultiSelect.options.length;
            toggleBtn.textContent = allSelected ? 'Deselect All Varieties' : 'Select All Varieties';
        }

        els.selectedVarietiesDisplay.innerHTML = selectedVarietyNames.length > 0
            ? `<p class="tw-font-semibold">Selected (${selectedVarietyNames.length}):</p> ${selectedVarietyNames.join(", ")}`
            : '<p class="tw-text-gray-500">Selected varieties will appear here...</p>';
        calculateAreaToSpray();
    });

    els.bedNumbers.addEventListener("input", calculateAreaToSpray);

    els.bom.addEventListener("change", (e) => { populateBomDetails(e.target.value); updateStockBalances(); });

    els.addChemicalBtn.addEventListener("click", () => { const newRow = createChemicalRow(); els.bomChemicalsList.appendChild(newRow); updateStockBalances(); });

    els.targetsContainer.addEventListener("change", updateGrid);
    els.stagesContainer.addEventListener("change", updateGrid);
    els.plantSectionContainer.addEventListener("change", updateGrid);
    els.thresholdContainer.addEventListener("change", updateGrid);

    els.popupOverlay.addEventListener("click", (e) => {
        if (e.target.id === "global-popup-overlay") { els.popupOverlay.classList.remove("active"); }
    });

    // ==================== FORM SUBMISSION ====================
    document.getElementById("spray-plan-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const greenhouse = els.greenhouse.value;
        const sprayType = els.sprayType.value;
        const kit = els.kit.value;
        const scope = els.scope.value;
        const bom = els.bom.value;
        const waterPh = els.waterPh.value;
        const waterHardness = els.waterHardness.value;
        const waterVolume = els.waterVolume.value;
        const areaToSpray = els.areaToSpray.value;
        const sprayTeam = els.sprayTeam.value;
        const scheduledApplicationTime = els.scheduledApplicationTime.value || null;
        const selectedTargets = Array.from(state.selectedTargets);

        if (selectedTargets.length === 0) { showToast("Please select at least one target.", "error"); return; }

        const targets = selectedTargets;
        const { activeStages, activeSections } = getActiveFilters();
        const chemicals = getFinalChemicals();

        if (!greenhouse || targets.length === 0 || !sprayType || !kit || !scope || !bom) {
            showToast("Please fill out all required fields.", "error"); return;
        }
        if (chemicals.length === 0) { showToast("Please add at least one chemical.", "error"); return; }
        for (const chemical of chemicals) {
            const sourceWarehouse = state.sourceWarehouseCache[chemical.chemical]?.source_warehouse;
            if (!chemical.chemical || !chemical.uom || chemical.application_rate <= 0 || !sourceWarehouse) {
                showToast("All chemical rows must have valid item name, quantity, UoM, and source warehouse.", "error"); return;
            }
        }
        if (!waterPh || !waterHardness) { showToast("Please provide values for water pH and water hardness.", "error"); return; }

        let custom_scope_value = "";
        if (scope === "Specific Variety") {
            const selectedVarieties = Array.from(els.varietyMultiSelect.selectedOptions).map(opt => opt.value);
            custom_scope_value = selectedVarieties.join(",");
        } else if (scope === "Specific Bed(s)") {
            custom_scope_value = els.bedNumbers.value;
        }

        const chemicalsWithWarehouse = chemicals.map(chem => ({
            ...chem,
            source_warehouse: state.sourceWarehouseCache[chem.chemical]?.source_warehouse || ""
        }));

        // Get selected varieties for the form submission
        const selectedVarietiesArray = Array.from(state.selectedVarieties);
        const varietyToSend = selectedVarietiesArray.includes('__all__') ? '' : selectedVarietiesArray.join(',');

        const formData = {
            custom_type: "Application Floor Plan",
            custom_greenhouse: greenhouse,
            custom_variety: varietyToSend,
            custom_targets: targets,
            custom_spray_type: sprayType,
            custom_kit: kit,
            custom_kit_warehouse: state.kitWarehouse,
            custom_scope: scope,
            custom_scope_details: custom_scope_value,
            production_item: bom,
            qty: 1,
            custom_water_ph: parseFloat(waterPh) || 0,
            custom_water_hardness: parseFloat(waterHardness) || 0,
            chemicals: chemicalsWithWarehouse,
            custom_water_volume: parseFloat(waterVolume) || 0,
            custom_area: parseFloat(areaToSpray) || 0,
            custom_spray_team: sprayTeam,
            custom_scheduled_application_time: scheduledApplicationTime
        };

        showLoader('Validating spray plan...');

        try {
            const fullPayload = { payload: { raw_data: formData } };
            const response = await fetch('/api/method/upande_scp.serverscripts.validate_frac_irac_guidelines.validateGuidelines', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Frappe-CSRF-Token': "{{csrf_token}}" },
                body: JSON.stringify(fullPayload)
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const r = await response.json();
            const validationResult = r.message;

            if (validationResult?.valid === true) {
                hideLoader();
                showWarehouseConfirmationModal(chemicalsWithWarehouse, greenhouse, () => {
                    showLoader('Creating spray plan...');
                    createWorkOrder(formData);
                });
                return;
            }
            if (validationResult?.valid === false) { hideLoader(); showValidationDialog(validationResult.errors, formData); return; }
            showToast("Unexpected response structure from validation server.", "error");
            hideLoader();
        } catch (error) {
            showToast("An error occurred during validation. Please try again.", "error");
            console.error("Validation API Error:", error);
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
              <p class="validation-warning-title">Warning: Do you want to bypass these guidelines and create the Work Order anyway?</p>
              <p class="validation-warning-text">Bypassing may lead to reduced effectiveness and increased resistance.</p>
            </div>
          </div>
          <div class="validation-dialog-footer">
            <button class="validation-btn validation-btn-cancel" onclick="this.closest('.validation-dialog-overlay').remove(); showToast('Work Order creation cancelled', 'info');">Cancel</button>
            <button class="validation-btn validation-btn-bypass" id="bypass-validation-btn">Bypass and Create</button>
          </div>
        </div>`;

        const style = document.createElement('style');
        style.textContent = `
        .validation-dialog-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 9999; }
        .validation-dialog { background: white; border-radius: 8px; max-width: 800px; width: 90%; max-height: 90vh; display: flex; flex-direction: column; box-shadow: 0 10px 25px rgba(0,0,0,0.3); }
        .validation-dialog-header { padding: 20px; border-bottom: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center; }
        .validation-dialog-header h3 { margin: 0; font-size: 20px; color: #1f2937; }
        .validation-dialog-close { background: none; border: none; font-size: 28px; color: #6b7280; cursor: pointer; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; }
        .validation-dialog-close:hover { color: #1f2937; }
        .validation-dialog-body { padding: 20px; overflow-y: auto; flex: 1; }
        .validation-dialog-body ul { list-style-type: none; padding: 0; margin: 0 0 20px 0; border: 1px solid #ffcdd2; background-color: #ffebee; border-radius: 4px; }
        .validation-dialog-body li { padding: 10px 15px; color: #c62828; font-size: 14px; border-bottom: 1px dashed #ffcdd2; }
        .validation-dialog-body li:last-child { border-bottom: none; }
        .validation-warning-box { margin-top: 20px; padding: 15px; background-color: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; }
        .validation-warning-title { margin: 0; color: #856404; font-weight: bold; }
        .validation-warning-text { margin: 10px 0 0 0; color: #856404; font-size: 0.9em; }
        .validation-dialog-footer { padding: 20px; border-top: 1px solid #e5e7eb; display: flex; justify-content: flex-end; gap: 10px; }
        .validation-btn { padding: 10px 20px; border-radius: 6px; border: none; font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s; }
        .validation-btn-cancel { background: #f3f4f6; color: #374151; }
        .validation-btn-cancel:hover { background: #e5e7eb; }
        .validation-btn-bypass { background: #1f2937; color: white; }
        .validation-btn-bypass:hover { background: #111827; }`;
        document.head.appendChild(style);
        document.body.appendChild(dialogOverlay);

        document.getElementById('bypass-validation-btn').addEventListener('click', () => {
            dialogOverlay.remove();
            showToast('Creating Work Order (Guidelines Bypassed)', 'warning');
            showWarehouseConfirmationModal(formData.chemicals, formData.custom_greenhouse, () => {
                showLoader('Creating spray plan...');
                createWorkOrder(formData);
            });
        });
    };

    // ==================== WAREHOUSE CONFIRMATION MODAL ====================
    // Shows a summary of item → source warehouse mappings so the user can
    // verify everything is correct before the work order is created.
    const showWarehouseConfirmationModal = (chemicals, greenhouse, onConfirm) => {
        const allMapped = chemicals.every(c => c.source_warehouse);
        const rows = chemicals.map(c => {
            const color = c.source_warehouse ? "#059669" : "#dc2626";
            const label = c.source_warehouse || "<em>Not selected</em>";
            return `<tr>
                <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${c.chemical}</td>
                <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:${color};">${label}</td>
            </tr>`;
        }).join("");

        const overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999;";
        overlay.innerHTML = `
            <div style="background:white;border-radius:8px;max-width:600px;width:90%;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 10px 25px rgba(0,0,0,0.3);">
                <div style="padding:20px;border-bottom:1px solid #e5e7eb;display:flex;justify-content:space-between;align-items:center;">
                    <h3 style="margin:0;font-size:18px;color:#1f2937;">Confirm Warehouse Mapping</h3>
                    <button id="wh-modal-close" style="background:none;border:none;font-size:24px;color:#6b7280;cursor:pointer;">×</button>
                </div>
                <div style="padding:20px;overflow-y:auto;flex:1;">
                    <p style="margin:0 0 4px 0;font-size:14px;color:#6b7280;">Target Greenhouse</p>
                    <p style="margin:0 0 16px 0;font-weight:600;color:#1f2937;">${greenhouse}</p>
                    <p style="margin:0 0 8px 0;font-size:14px;color:#6b7280;">Verify each item will be drawn from the correct warehouse before creating the work order.</p>
                    <table style="width:100%;border-collapse:collapse;font-size:14px;">
                        <thead>
                            <tr style="background:#f9fafb;">
                                <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e5e7eb;">Item</th>
                                <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e5e7eb;">Source Warehouse</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                    ${!allMapped ? '<p style="margin:16px 0 0 0;color:#dc2626;font-weight:500;">Some items have no source warehouse selected. Go back and select warehouses before proceeding.</p>' : ""}
                </div>
                <div style="padding:20px;border-top:1px solid #e5e7eb;display:flex;justify-content:flex-end;gap:10px;">
                    <button id="wh-modal-cancel" style="padding:10px 20px;border-radius:6px;border:none;background:#f3f4f6;color:#374151;font-size:14px;cursor:pointer;">Cancel</button>
                    <button id="wh-modal-confirm" style="padding:10px 20px;border-radius:6px;border:none;background:#059669;color:white;font-size:14px;font-weight:500;cursor:pointer;">Confirm & Create Work Order</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        const confirmBtn = document.getElementById("wh-modal-confirm");
        if (!allMapped) { confirmBtn.disabled = true; confirmBtn.style.opacity = "0.5"; confirmBtn.style.cursor = "not-allowed"; }

        document.getElementById("wh-modal-close").onclick = () => overlay.remove();
        document.getElementById("wh-modal-cancel").onclick = () => overlay.remove();
        confirmBtn.onclick = () => { if (!allMapped) return; overlay.remove(); onConfirm(); };
    };

    const createWorkOrder = async (data) => {
        setLoaderMessage('Creating spray plan...');
        try {
            const fullPayload = { payload: { raw_data: data } };
            const response = await fetch('/api/method/upande_scp.serverscripts.create_application_work_order.createApplicationWorkOrder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Frappe-CSRF-Token': "{{csrf_token}}" },
                body: JSON.stringify(fullPayload)
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const r = await response.json();
            if (r.message && r.message.status === "success") {
                setLoaderMessage('Work Order created! Redirecting...');
                showToast(`Work Order ${r.message.work_order_name} created successfully!`, "success");
                setTimeout(() => { window.location.href = `/application_work_order?name=${encodeURIComponent(r.message.work_order_name)}`; }, 1500);
            } else {
                showToast(`Error creating Work Order: ${r.message?.message || "Unknown error"}`, "error");
                hideLoader();
            }
        } catch (error) {
            showToast("An unexpected error occurred during creation. Please try again.", "error");
            hideLoader();
        }
    };

    renderThresholdCheckboxes(null);
});