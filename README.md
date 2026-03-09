### Upande Scp

Scouting & Crop Protection Module

### System Overview

- Purpose: orchestrates scouting-derived spray planning and execution across greenhouses
- Stack: Frappe/ERPNext app with web pages, server-side APIs, DocTypes, Client Scripts, and fixtures
- Core flow: capture scouting → analyze observations → plan chemicals/BOM → validate FRAC/IRAC → create Work Order → transfer materials → track scheduled applications and execution

### Routing & Pages

- Web routes: configured in [hooks.py](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/hooks.py#L242-L253)
  - /scouts_map, /observations_map, /scouting_heatmaps, /variety_map, /new_application_floor_plan, /traps_map
- Application Floor Plan
  - Markup: [new_application_floor_plan.html](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/www/new_application_floor_plan.html)
  - Logic: [new_application_floor_plan.js](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/www/new_application_floor_plan.js)
  - Context/API: [new_application_floor_plan.py](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/www/new_application_floor_plan.py)
- Scouting Heatmaps: [scouting_heatmaps.html](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/www/scouting_heatmaps.html)

### Data Model (Key DocTypes)

- Scouting Entry + child tables (pests/diseases/predators/weeds/incidents/disorders)
- Pests: [pest.json](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/upande_scp/doctype/pest/pest.json)
  - Stages: Pests Stages, Severity: Scouting Severity Scale
- Plant Disease: stages in Disease Stages; legend color
- Predator, Weed, Incident, Physiological Disorder
- Bed And Zone Automation: [bed_and_zone_automation.json](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/upande_scp/doctype/bed_and_zone_automation/bed_and_zone_automation.json)
- Chemical Targets linking pests/diseases: [chemical_targets.json](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/upande_scp/doctype/chemical_targets/chemical_targets.json)
- Spray Team + details: [spray_team_details.json](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/upande_scp/doctype/spray_team_details/spray_team_details.json)
- ERPNext Work Order custom fields (fixtures):
  - custom_type, custom_greenhouse, custom_variety, custom_targets, custom_spray_type, custom_kit
  - custom_scope, custom_scope_details, custom_water_ph, custom_water_hardness, custom_water_volume, custom_area
  - custom_spray_team, custom_reentry_time, custom_scheduled_application_time, custom_reentry_period_hrs
  - Work Order Item: custom_updated_required_qty
  - See [hooks.py fixtures](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/hooks.py#L256-L318)

### Core Frontend → Backend APIs

- Greenhouses by date
  - JS call: /api/method/upande_scp.www.new_application_floor_plan.get_scouted_greenhouses_by_date
  - Handler: [new_application_floor_plan.py:get_scouted_greenhouses_by_date](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/www/new_application_floor_plan.py#L16-L49)
- Scouting report for planning
  - JS call: /api/method/upande_scp.serverscripts.get_scouting_report.getScoutingData
  - Handler: [get_scouting_report.py:getScoutingData](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/serverscripts/get_scouting_report.py#L5-L348)
  - Returns: processed entries, observation metadata, varieties, susceptibility per observation/variety, BOMs, BOM items, bed/zone numbering, chemical list, bed data, spray teams
- BOM stock balances for chemicals
  - JS call: /api/method/upande_scp.serverscripts.get_bom_stock_balances.getBomStockBalances
  - Handler: [get_bom_stock_balances.py](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/serverscripts/get_bom_stock_balances.py)
  - Provides item_uom_map and stock balances across configured chemical store warehouses
- FRAC/IRAC guideline validation before work order
  - JS call: /api/method/upande_scp.serverscripts.validate_frac_irac_guidelines.validateGuidelines
  - Handler: [validate_frac_irac_guidelines.py:validateGuidelines](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/serverscripts/validate_frac_irac_guidelines.py#L391-L443)
  - Key validations:
    - Alternate MoA rotation: [validate_alternate_moa](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/serverscripts/validate_frac_irac_guidelines.py#L74-L159)
    - Max sprays within break period: [validate_max_sprays](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/serverscripts/validate_frac_irac_guidelines.py#L184-L299)
    - Known resistance with chosen targets: [validate_known_resistance](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/serverscripts/validate_frac_irac_guidelines.py#L302-L387)
- Create Application Work Order
  - JS call: /api/method/upande_scp.serverscripts.create_application_work_order.createApplicationWorkOrder
  - Handler: [create_application_work_order.py:createApplicationWorkOrder](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/serverscripts/create_application_work_order.py#L5-L214)
  - Steps:
    - Parse payload, validate greenhouse/BOM/area/water volume/chemicals
    - Optionally create dynamic BOM if chemicals or rates differ: [should_create_dynamic_bom](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/serverscripts/create_application_work_order.py#L215-L238) and [create_dynamic_bom](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/serverscripts/create_application_work_order.py#L239-L295)
    - Build temporary Stock Entry (Material Transfer for Manufacture) to derive valuation rates
    - Build Work Order with required_items (per 1000L rates, source warehouses, valuation)
    - Format spray team string: [format_spray_team](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/serverscripts/create_application_work_order.py#L301-L315)
- Scheduled Applications listing (tracking)
  - JS call: /api/method/Fetch Scheduled Applications (server script fixture)
  - Fixture body: [server_script.json:Fetch Scheduled Applications](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/fixtures/server_script.json#L109-L135)
  - Returns submitted Work Orders of type “Application Floor Plan” with required items

### Frontend Flow (Application Floor Plan)

- Inputs and filters
  - Greenhouse, variety, targets per observation type, stages, plant sections
  - Spray type, kit, scope (full greenhouse, specific variety, specific beds), BOM
  - Spray team, water pH/hardness, water volume, computed area
  - See form section: [new_application_floor_plan.html](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/www/new_application_floor_plan.html#L64-L123)
- Scouting data rendering
  - Fetch data and render heatmap grid, observation checkboxes, stage/section filters
  - Processing: [processScoutingData](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/www/new_application_floor_plan.js#L381-L442)
  - Grid update based on active filters: [updateGrid](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/www/new_application_floor_plan.js#L641-L706)
- Area and water volume computation
  - Bed- or variety-based proportional area; fallback to grid dimensions
  - Calculates area fraction of total beds and scales water volume by constant rate
  - Implementation: [calculateAreaToSpray](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/www/new_application_floor_plan.js#L1315-L1368)
- BOM and chemicals
  - Populate BOM details; merge BOM items and custom rows; track UoMs; choose source warehouses
  - Aggregate final chemicals: [getFinalChemicals](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/www/new_application_floor_plan.js#L1370-L1379)
  - Stock balances: [updateStockBalances](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/www/new_application_floor_plan.js#L1107-L1133)
- Validation and submission
  - Construct formData payload including targets, scope details, BOM, water parameters, chemicals, team, area/volume
  - FRAC/IRAC validation; optional bypass via modal dialog
  - Work Order creation and redirect: [createWorkOrder](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/www/new_application_floor_plan.js#L1702-L1733)

### Scouting & Heatmaps APIs

- Scouting report (planning): [get_scouting_report.py:getScoutingData](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/serverscripts/get_scouting_report.py#L5-L348)
  - Builds observation entries with stage/severity colors and legend mapping
  - Computes susceptibility per observation across varieties using Chemical Requirements thresholds
- Observations dataset (mobile/app): [mobile/get_observations_details.py:getObservationsDetails](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/serverscripts/mobile/get_observations_details.py#L3-L238)
  - Returns per-stage fields for pests/diseases/predators with reading types and plant sections
- Scouting heatmap dataset: [get_heatmap_data.py](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/serverscripts/get_heatmap_data.py)
  - Provides detailed per-entry observations and type metadata for heatmap UI
- Scouting observations summary: [get_scouting_observations.py:getScoutingObservations](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/serverscripts/get_scouting_observations.py#L1-L232)

### Work Orders & Material Handling

- Work Order creation: [create_application_work_order.py](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/serverscripts/create_application_work_order.py)
  - Required items derived per 1000L from application rates with valuation from temporary Stock Entry
  - Sets WIP/FG warehouses, custom fields, description, and team string
- Start Work Order (mobile/API):
  - [mobile/start_work_order.py:start_work_order](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/serverscripts/mobile/start_work_order.py)
  - Marks status “In Process”, sets actual_start_date, creates draft Stock Entry (Material Transfer for Manufacture)
- Client scripts for visibility:
  - Work Order toggle fields: [client_script.json](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/fixtures/client_script.json#L65-L79)
  - Ensures relevant custom fields show for Application Floor Plan type
- Print format: “Spray Plan” fixture in [hooks.py](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/hooks.py#L319-L341)

### BOM & Chemical Management

- Create BOM API: [create_bom.py:createBOM](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/serverscripts/create_bom.py#L4-L133)
  - Supports duplicate detection by comparing water parameters and item rates
- List chemicals + UoMs: [create_bom.py:getAllChemicals](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/serverscripts/create_bom.py#L198-L222)
- Fetch chemical UoM: [create_bom.py:getChemicalUom](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/serverscripts/create_bom.py#L224-L244)
- Stock balances API:
  - Fixture: [server_script.json:Get BOM Stock Balances](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/fixtures/server_script.json#L70-L77)
  - Implementation: [get_bom_stock_balances.py](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/serverscripts/get_bom_stock_balances.py#L51-L74)

### Bed/Zone Automation

- DocType: Bed And Zone Automation stores greenhouse sectors and zones geojson
- “Zone Automation Tool” server script runs on Before Submit of this DocType
  - Fixture entry: [server_script.json:Zone Atomation Tool](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/fixtures/server_script.json#L24-L36)
- Fetch greenhouse beds API:
  - Fixture: [server_script.json:Fetch Greenhouse Beds](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/fixtures/server_script.json#L117-L135)

### Scheduled Applications & Reentry

- Fetch Scheduled Applications:
  - [server_script.json:Fetch Scheduled Applications](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/fixtures/server_script.json#L109-L135)
- Greenhouse Reentry Status:
  - Listed in fixtures in [hooks.py](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/hooks.py#L300-L318) and used to surface reentry info alongside Work Orders

### How Components Communicate

- Frontend (new_application_floor_plan.js)
  - Initializes UI, fetches greenhouses and scouting data, renders heatmaps and filters
  - Computes area/water volume based on scope selections
  - Aggregates chemicals from BOM and custom rows, fetches stock balances and attaches source warehouses
  - Validates payload via FRAC/IRAC endpoint; handles bypass dialog
  - Creates Work Order via backend and redirects to ERPNext Work Order page
- Backend
  - Scouting report composes stage/severity colorization and susceptibility per variety
  - Validation engine inspects historical and current plan against FRAC/IRAC guidelines
  - Work Order builder makes a temporary Stock Entry for valuation, then persists the Work Order with item requirements and custom fields
  - Scheduled applications API aggregates submitted Work Orders and attaches required items for tracking

### Installation

### Installation

You can install this app using the [bench](https://github.com/frappe/bench) CLI:

```bash
cd $PATH_TO_YOUR_BENCH
bench get-app $URL_OF_THIS_REPO --branch develop
bench install-app upande_scp
### Development

- Pre-commit hooks ensure consistent formatting and linting
- Client/Server Scripts and fixtures are declared in [hooks.py](file:///home/sudouser/code/frappe/v16/apps/upande_scp/upande_scp/hooks.py)
- API endpoints are declared as whitelisted functions under serverscripts/ and www/ modules

```

### Contributing

This app uses `pre-commit` for code formatting and linting. Please [install pre-commit](https://pre-commit.com/#installation) and enable it for this repository:
cd apps/upande_scp
pre-commit install

```

Pre-commit is configured to use the following tools for checking and formatting your code:

- ruff
- eslint
- prettier
- pyupgrade

### License

mit
```
