app_name = "upande_scp"
app_title = "Upande Scp"
app_publisher = "Upande"
app_description = "Scouting & Crop Protection Module"
app_email = "info@upande.com"
app_license = "mit"

# Apps
# ------------------

# required_apps = []

# Each item in the list will be shown as an app in the apps page
# add_to_apps_screen = [
# 	{
# 		"name": "upande_scp",
# 		"logo": "/assets/upande_scp/logo.png",
# 		"title": "Upande Scp",
# 		"route": "/upande_scp",
# 		"has_permission": "upande_scp.api.permission.has_app_permission"
# 	}
# ]

# Includes in <head>
# ------------------

# include js, css files in header of desk.html
# app_include_css = "/assets/upande_scp/css/upande_scp.css"
# Same-tab navigation for the /scp_app workspace-sidebar links (Frappe forces
# target="_blank" on URL sidebar items, which we override in scp_desk.js).
app_include_js = "/assets/upande_scp/js/scp_desk.js"

# include js, css files in header of web template
# web_include_css = "/assets/upande_scp/css/upande_scp.css"
# web_include_js = "/assets/upande_scp/js/upande_scp.js"

# include custom scss in every website theme (without file extension ".scss")
# website_theme_scss = "upande_scp/public/scss/website"

# include js, css files in header of web form
# webform_include_js = {"doctype": "public/js/doctype.js"}
# webform_include_css = {"doctype": "public/css/doctype.css"}

# include js in page
# page_js = {"page" : "public/js/file.js"}

# include js in doctype views
# Desk form scripts (formerly Client Script fixtures, now versioned code).
doctype_js = {
    "Work Order": "public/js/spray_plan_wo_form.js",
    "Item": "public/js/item.js",
    "Chemical": "public/js/chemical.js",
    "Foliar": "public/js/foliar.js",
    "Warehouse": "public/js/warehouse.js",
    "Pest": "public/js/pest.js",
    "BOM": "public/js/bom.js",
    "Bed And Zone Automation": "public/js/bed_and_zone_automation.js",
}
doctype_list_js = {"Stock Entry": "public/js/spray_plan_transfers.js"}
# doctype_tree_js = {"doctype" : "public/js/doctype_tree.js"}
# doctype_calendar_js = {"doctype" : "public/js/doctype_calendar.js"}

# Svg Icons
# ------------------
# include app icons in desk
# app_include_icons = "upande_scp/public/icons.svg"

# Home Pages
# ----------

# application home page (will override Website Settings)
# home_page = "login"

# website user home page (by Role)
# role_home_page = {
# 	"Role": "home_page"
# }

# Generators
# ----------

# automatically create page for each record of this doctype
# website_generators = ["Web Page"]

# Jinja
# ----------

# add methods and filters to jinja environment
# jinja = {
# 	"methods": "upande_scp.utils.jinja_methods",
# 	"filters": "upande_scp.utils.jinja_filters"
# }

# Installation
# ------------

# before_install = "upande_scp.install.before_install"
# after_install = "upande_scp.install.after_install"

# Run the canonical pest/disease colour seed on every migrate so a fresh
# install (or a newly added pest doc) gets sensible defaults without manual
# steps. The seed only fills empty colour fields, so operator-set overrides
# are preserved.
after_migrate = [
	"upande_scp.serverscripts.scouting.observation_colors.after_migrate",
	# Declare SCP's Stock Entry fields before the layout pass, so the enforcer
	# has something to place. Stock Entry is shared with three other installed
	# apps, so these must be rebuilt rather than assumed to exist.
	"upande_scp.serverscripts.store.stock_entry_fields.ensure_scp_stock_entry_fields",
	# The `custom_farm` links on BOM / Spray Team. Declared in code rather than
	# shipped as fixtures because fixture sync OVERWRITES, and a site may already
	# carry its own `custom_farm` on these shared doctypes — this creates only
	# where absent. Must precede the layout pass, same as the Stock Entry fields.
	"upande_scp.serverscripts.common.farm_fields.ensure_farm_fields",
	"upande_scp.serverscripts.common.scouting_tab_layout.enforce",
]

before_uninstall = [
	"upande_scp.serverscripts.store.stock_entry_fields.remove_scp_stock_entry_fields",
]

# Uninstallation
# ------------

# before_uninstall = "upande_scp.uninstall.before_uninstall"
# after_uninstall = "upande_scp.uninstall.after_uninstall"

# Integration Setup
# ------------------
# To set up dependencies/integrations with other apps
# Name of the app being installed is passed as an argument

# before_app_install = "upande_scp.utils.before_app_install"
# after_app_install = "upande_scp.utils.after_app_install"

# Integration Cleanup
# -------------------
# To clean up dependencies/integrations with other apps
# Name of the app being uninstalled is passed as an argument

# before_app_uninstall = "upande_scp.utils.before_app_uninstall"
# after_app_uninstall = "upande_scp.utils.after_app_uninstall"

# Desk Notifications
# ------------------
# See frappe.core.notifications.get_notification_config

# notification_config = "upande_scp.notifications.get_notification_config"

# Permissions
# -----------
# Permissions evaluated in scripted ways

# Row-level visibility for chemical loans: a planner may only ever load requests
# their farms raised or were asked for. Enforced here, not in the UI — filtering
# client-side would leave the rows readable over the REST API.
permission_query_conditions = {
    "Chemical Transfer Request": (
        "upande_scp.serverscripts.spray_plan_creator.loaning_v2.permission_query"
    ),
}

# permission_query_conditions = {
# 	"Event": "frappe.desk.doctype.event.event.get_permission_query_conditions",
# }
#
# has_permission = {
# 	"Event": "frappe.desk.doctype.event.event.has_permission",
# }

# DocType Class
# ---------------
# Override standard doctype classes

# override_doctype_class = {
# 	"ToDo": "custom_app.overrides.CustomToDo"
# }
override_doctype_class = {
	"Stock Entry": "upande_scp.serverscripts.store.spray_stock_entry.SprayStockEntry",
}

# Link an Item to its Chemical / Foliar sidecar on the Item dashboard.
override_doctype_dashboards = {
	"Item": "upande_scp.serverscripts.common.crop_protection.item_dashboard",
}

# Document Events
# ---------------
# Hook on document methods and events

# doc_events = {
# 	"*": {
# 		"on_update": "method",
# 		"on_cancel": "method",
# 		"on_trash": "method"
# 	}
# }

# Invalidate cached dashboard/map payloads when underlying master data changes.
_SCP_CACHE_INVALIDATOR = "upande_scp.serverscripts.common.cache_utils.invalidate_on_change"
_SCP_REALTIME_DIRTY = "upande_scp.serverscripts.common.cache_utils.publish_scouting_dirty"
_SCP_CACHE_EVENTS = {
    "on_update": _SCP_CACHE_INVALIDATOR,
    "on_trash": _SCP_CACHE_INVALIDATOR,
}
# Scouting docs also push a "dirty" realtime nudge so live clients can advance
# their delta watermark without polling. on_update covers create + edit; the
# dedicated on_trash entry below ensures deletes still fire even though the
# parent on_update may not.
_SCP_SCOUTING_EVENTS = {
    "on_update": [_SCP_CACHE_INVALIDATOR, _SCP_REALTIME_DIRTY],
    "on_trash": [_SCP_CACHE_INVALIDATOR, _SCP_REALTIME_DIRTY],
    "after_insert": _SCP_REALTIME_DIRTY,
}
doc_events = {
    "Employee": _SCP_CACHE_EVENTS,
    "Pest": _SCP_CACHE_EVENTS,
    "Plant Disease": _SCP_CACHE_EVENTS,
    "Predator": _SCP_CACHE_EVENTS,
    "Weed": _SCP_CACHE_EVENTS,
    "Incident": _SCP_CACHE_EVENTS,
    "Physiological Disorder": _SCP_CACHE_EVENTS,
    "Pests Stages": _SCP_CACHE_EVENTS,
    "Pest Filter": _SCP_CACHE_EVENTS,
    "Disease Stages": _SCP_CACHE_EVENTS,
    "Predator Stages": _SCP_CACHE_EVENTS,
    "Zone": _SCP_CACHE_EVENTS,
    "Bed": _SCP_CACHE_EVENTS,
    "Trap": _SCP_CACHE_EVENTS,
    "Warehouse": _SCP_CACHE_EVENTS,
    "Farm": {
        **_SCP_CACHE_EVENTS,
        "validate": [
            "upande_scp.upande_scp.doctype.farm_spray_plan_creator.farm_spray_plan_creator.validate_farm_spray_plan_creators",
            "upande_scp.upande_scp.doctype.farm_spray_plan_approver.farm_spray_plan_approver.validate_farm_spray_plan_approvers",
        ],
    },
    "Spray Equipment Details": _SCP_CACHE_EVENTS,
    "Item": {
        **_SCP_CACHE_EVENTS,
        "after_insert": "upande_scp.serverscripts.common.crop_protection.on_item_after_insert",
    },
    "Orchard Tree": _SCP_CACHE_EVENTS,
    "Crop Scouted": _SCP_CACHE_EVENTS,
    "Tank And Valve": _SCP_CACHE_EVENTS,
    "Scouting and Crop Protection Settings": _SCP_CACHE_EVENTS,
    "Spray Plan Allowed Farm": _SCP_CACHE_EVENTS,
    "Spray Plan Exclude Keyword": _SCP_CACHE_EVENTS,
    # Scouting payload cache invalidation + realtime "dirty" nudge.
    # Child-table edits don't always touch the parent's `modified`, so each
    # is hooked individually — the invalidator bumps the cache version stamp,
    # and publish_scouting_dirty nudges live clients to re-sync the affected
    # month (see docs/data_caching.md L4 section).
    "Scouting Entry": _SCP_SCOUTING_EVENTS,
    "Pests Scouting Entry": _SCP_SCOUTING_EVENTS,
    "Diseases Scouting Entry": _SCP_SCOUTING_EVENTS,
    "Trap Scouting Entry": _SCP_SCOUTING_EVENTS,
    # Stamp Application Floor Plan Work Orders with their lifecycle state when
    # related Stock Entries are submitted (e.g. Material Transfer for
    # Manufacture -> "Chemical Issued"). Material Issue is fired later from
    # end_spray_session, not from this hook.
    "Stock Entry": {
        "before_validate": [
            # Safety net: force any AFP Manufacture (desk, API, console, mobile)
            # to consume what was transferred into the CSU, not the template BOM.
            "upande_scp.serverscripts.spray_plan_creator.stock_entry_state.before_validate",
        ],
        "on_submit": [
            "upande_scp.serverscripts.spray_plan_creator.stock_entry_state.on_submit",
            # Capture chemical-store baselines when stock is received in.
            "upande_scp.serverscripts.spray_plan_creator.loaning.capture_baseline_on_receipt",
        ],
    },
    # Purchase Receipts into a farm chemical store also refresh the baseline.
    "Purchase Receipt": {
        "on_submit": "upande_scp.serverscripts.spray_plan_creator.loaning.capture_baseline_on_receipt",
    },
}

# Scheduled Tasks
# ---------------


scheduler_events = {
    "cron": {
        # Daily Scouting & Crop Protection Summary — 17:00 EAT (14:00 UTC)
        "0 14 * * *": [
            "upande_scp.serverscripts.reports.send_daily_scouting_report.send_daily_scouting_report"
        ],
        # Weekly Trap Scouting Report — Mondays 08:00 EAT (05:00 UTC)
        "0 5 * * 1": [
            "upande_scp.serverscripts.reports.send_weekly_trap_report.send_weekly_trap_report"
        ],
        # KEPHIS FCM Weekly Excel — Tuesdays 08:00
        "0 8 * * 2": [
            "upande_scp.serverscripts.reports.send_fcm_weekly_excel_report.send_fcm_weekly_excel_report"
        ],
    },
    "daily": [
        "upande_scp.serverscripts.scouting.scouting_prewarm.daily_prewarm",
        # Cancel AFP spray plans left unapproved for more than 3 days.
        "upande_scp.serverscripts.spray_plan_creator.maintenance.auto_cancel_dormant_plans",
    ],
    "hourly": [
        # Keep the current + previous ISO week of scouting payload warm in Redis
        # all day (per-week cache TTL is 1h; writes bust the active week).
        "upande_scp.serverscripts.scouting.scouting_prewarm.hourly_prewarm",
        # Expire chemical loan requests that sat unanswered past their timeout.
        "upande_scp.serverscripts.spray_plan_creator.loaning.expire_dormant_requests",
        # Daily Chemical Planning Progress Update — sends at the GM-configured
        # EAT hour (self-gated; once per day).
        "upande_scp.serverscripts.reports.send_chemical_progress_email.send_chemical_progress_email",
    ],
}

# scheduler_events = {
# 	"all": [
# 		"upande_scp.tasks.all"
# 	],
# 	"daily": [
# 		"upande_scp.tasks.daily"
# 	],
# 	"hourly": [
# 		"upande_scp.tasks.hourly"
# 	],
# 	"weekly": [
# 		"upande_scp.tasks.weekly"
# 	],
# 	"monthly": [
# 		"upande_scp.tasks.monthly"
# 	],
# }

# Testing
# -------

# before_tests = "upande_scp.install.before_tests"

# Overriding Methods
# ------------------------------
#
# override_whitelisted_methods = {
# 	"frappe.desk.doctype.event.event.get_events": "upande_scp.event.get_events"
# }
#
# each overriding function accepts a `data` argument;
# generated from the base implementation of the doctype dashboard,
# along with any modifications made in other Frappe apps
# override_doctype_dashboards = {
# 	"Task": "upande_scp.task.get_dashboard_data"
# }

# exempt linked doctypes from being automatically cancelled
#
# auto_cancel_exempted_doctypes = ["Auto Repeat"]

# Ignore links to specified DocTypes when deleting documents
# -----------------------------------------------------------

# ignore_links_on_delete = ["Communication", "ToDo"]

# Request Events
# ----------------
# before_request = ["upande_scp.utils.before_request"]
# after_request = ["upande_scp.utils.after_request"]

# TEMP: diagnose mobile 403s on the spray-session/start path.
# Disabled: the upande_scp.diagnostics module was never committed (local-only),
# so these references 500 every request on any environment that lacks it. Restore
# the module first, then re-enable.
# before_request = ["upande_scp.diagnostics.request_log.before_request"]
# after_request = ["upande_scp.diagnostics.request_log.after_request"]

# Job Events
# ----------
# before_job = ["upande_scp.utils.before_job"]
# after_job = ["upande_scp.utils.after_job"]

# User Data Protection
# --------------------

# user_data_fields = [
# 	{
# 		"doctype": "{doctype_1}",
# 		"filter_by": "{filter_by}",
# 		"redact_fields": ["{field_1}", "{field_2}"],
# 		"partial": 1,
# 	},
# 	{
# 		"doctype": "{doctype_2}",
# 		"filter_by": "{filter_by}",
# 		"partial": 1,
# 	},
# 	{
# 		"doctype": "{doctype_3}",
# 		"strict": False,
# 	},
# 	{
# 		"doctype": "{doctype_4}"
# 	}
# ]

# Authentication and authorization
# --------------------------------

# auth_hooks = [
# 	"upande_scp.auth.validate"
# ]

# Automatically update python controller files with type annotations for this app.
# export_python_type_annotations = True

# default_log_clearing_doctypes = {
# 	"Logging DocType Name": 30  # days to retain logs
# }
# Clean-URL rewrites for the legacy desk www pages (rose_scouting,
# avocado_scouts_map, observations_map, new_application_floor_plan, etc.)
# were removed once the React app (/scp_app) became the sole UI. Kept as an
# empty list so the hook stays declared.
website_route_rules = []

fixtures = [
    # NOTE: reference data no longer shipped as fixtures — populate per site:
    #   * Stage catalog        -> patch seed_stage_catalog.py (+ docs/reference-data-seeding.md)
    #   * Crop Scouted         -> docs/reference-data-seeding.md
    # Trap Report Settings was removed entirely (feature retired).
    # Desk workspace custom blocks (SCP Dashboard / Scout Map / Navigation).
    {"doctype": "Custom HTML Block"},
    {
        "doctype": "Custom Field",
        "filters": [
            [
                "name", "in", [
                        # Notification Log — our category taxonomy. Notification
                        # Log.type is a fixed Frappe enum, so the SCP category
                        # needs its own field for the notifications page to filter on.
                        "Notification Log-scp_category",
                        # Warehouse fields
                        "Warehouse-custom_zone_numbering",
                        "Warehouse-custom_bed_numbering",
                        "Warehouse-custom_raw_geojson",
                        "Warehouse-custom_location",
                        "Warehouse-custom_area_ha",
                        "Warehouse-custom_cost_center",
                        # Item fields (chemical metadata moved to Chemical/Foliar;
                        # only the per-variety intervention threshold remains)
                        "Item-custom_chemical_intervention_threshhold",
                        "Item-custom_scouting_and_crop_protection_tab",
                        # BOM fields
                        "BOM-custom_water_hardness",
                        "BOM-custom_water_ph",
                        "BOM-custom_item_group",
                        # `custom_work_order` is the 1:1 backlink to the plan and is
                        # written with frappe.db.set_value (raw SQL, no meta check),
                        # so a site missing it 1054s on draft materialisation.
                        "BOM-custom_work_order",
                        # NOTE: `BOM-custom_farm` and `Spray Team-custom_farm` are
                        # NOT fixtures. Fixture sync overwrites, and these sit on
                        # doctypes where a site may already have its own farm
                        # field; `common/farm_fields.py` creates them only where
                        # absent, on after_migrate. One mechanism only.
                        # BOM Item fields
                        "BOM Item-custom_application_rate",
                        "BOM Item-custom_application_rateper_ha_",
                        # Work Order fields
                        "Work Order-custom_spray_team",
                        "Work Order-custom_reentry_time",
                        "Work Order-custom_scheduled_application_time",
                        "Work Order-custom_reentry_period_hrs",
                        "Work Order-custom_scope_details",
                        "Work Order-custom_water_hardness",
                        "Work Order-custom_water_ph",
                        "Work Order-custom_water_volume",
                        "Work Order-custom_area",
                        "Work Order-custom_type",
                        "Work Order-custom_scope",
                        "Work Order-custom_kit",
                        "Work Order-custom_spray_type",
                        "Work Order-custom_targets",
                        "Work Order-custom_variety",
                        "Work Order-custom_greenhouse",
                        "Work Order-custom_application_floor_plan",
                        # Spray-session flow: the scan child table and the SAL
                        # backlink. Both are read/written in spray_session.py.
                        "Work Order-custom_chemical_scans",
                        "Work Order-custom_spray_application_logsheet",
                        # Work Order Item fields
                        "Work Order Item-custom_updated_required_qty",
                        # Farm fields
                        "Farm-spray_plan_creators",
                        "Farm-custom_chemical_store",
                        "Farm-custom_fertilizer_store",
                        "Farm-store_keepers",
                        # Work Order spray-plan fields
                        "Work Order-custom_classification",
                        "Work Order-custom_preventive_reason",
                        "Work Order-custom_cost_center",
                        "Work Order-custom_rate_overridden",
                        "Work Order-custom_weather_snapshot",
                        "Work Order-custom_spray_plan_team_members",
                        # NOTE: Stock Entry / Stock Entry Detail fields are NOT
                        # fixtures. They are declared in
                        # serverscripts/store/stock_entry_fields.py and rebuilt
                        # on after_migrate, so a reset-to-defaults or a fresh
                        # site converges without needing a re-export. One
                        # mechanism only — see that module's docstring.
                ]
            ]
        ]
    },
    # NOTE: Client Scripts are no longer shipped as fixtures. Desk form scripts
    # now live in code under public/js/ wired via doctype_js above. The legacy
    # "Spray Plan Approval v7" list-view approval UI was dropped (the React
    # Approvals page replaces it).
    # NOTE: Server Scripts are no longer shipped as fixtures. The only live one
    # ("Zone Atomation Tool" / createBedsAndZones) was moved into code at
    # upande_scp.serverscripts.geo.bed_zone_automation.create_beds_and_zones; the
    # rest were dead (their callers were the removed www pages).
    # NOTE: the "Spray Plan" Print Format is no longer a fixture — it's a
    # standard app print format in code at
    # upande_scp/upande_scp/print_format/spray_plan/spray_plan.json.
    {
        # Workflow State master data — the Frappe Workflow itself was deleted
        # (see delete_application_floor_plan_workflow patch), but the
        # workflow_state Custom Field on Work Order still holds these values,
        # set/read by the spray-plan code. These records back that field.
        "doctype": "Workflow State",
        "filters": [["name", "in", [
            "Pending Submission", "Awaiting Approval", "Approved",
            "Chemical Issued", "Tank Mix Manufactured", "Spraying In Progress", "Completed"
        ]]]
    },
    # Role definitions owned by this app. Mobile chemical/spray-application
    # flow runs as Spray Supervisor.
    {
        "doctype": "Role",
        "filters": [["name", "in", [
            "SCP General Manager", "SCP Spray Supervisor", "SCP Spray Plan Creator",
            "SCP Spray Plan Approver", "SCP Scout", "SCP Chemical Store Keeper",
            "SCP Scouting User"
        ]]]
    }
    # NOTE: We deliberately do NOT export permissions (Custom DocPerm) from
    # this app. Role permissions are managed per-site, not shipped as fixtures.
    # {
    #     "doctype": "Insights Workbook",
    #     "filters": [
    #         ["title", "=", "Scouting & Crop Protection"]
    #     ]
    # },
    # {
    #     "doctype": "Insights Query v3",
    #     "filters": [
    #             ["title", "in", [
    #                "Physiological Disorder Trends",
    #                 "Total Greenhouses",
    #                 "Application Floor Plan Schedule",
    #                 "Application Floor Plans Status",
    #                 "Total Greenhouses Scouted",
    #                 "Bed Coverage",
    #                 "Daily Chemical Cost",
    #                 "Monthly Chemical Usage",
    #                 "Daily Chemical Usage",
    #                 "Weed Trends",
    #                 "Predator Trends By Stage",
    #                 "Pest Trends By Stage",
    #                 "Disease Trends By Stage",
    #                 "Scout Movement",
    #                 "Scout Performance",
    #                 "Greenhouse Coverage Percentage",
    #                 "Minutes Per Bed",
    #                 "Incident Observations",
    #                 "Physiological Observations",
    #                 "Predator Observations",
    #                 "Weeds Observations",
    #                 "Disease Observations",
    #                 "Pest Observations"
    #             ]]
    #         ]
    # },
    # {
    #     "doctype": "Insights Chart v3",
    #     "filters": [
    #             ["title", "in", [
    #                 "Physiological Disorder Trends",
    #                 "Weed Trends",
    #                 "Predator Trends By Stage",
    #                 "Pest Trends By Stage",
    #                 "Disease Trends By Stage",
    #                 "Application Schedule",
    #                 "Application Floor Plan Tiles",
    #                 "Total Greenhouses Scouted",
    #                 "Bed Coverage",
    #                 "Total Greenhouses",
    #                 "Daily Chemical Cost",
    #                 "Monthly Chemical Usage",
    #                 "Daily Chemical Usage",
    #                 "Scout Movement (Total Zones Covered Every 5 minutes)",
    #                 "Scout Performance",
    #                 "Greenhouse Coverage Percentage(Beds)",
    #                 "Minutes Per Bed",
    #                 "Incident Observations Per greenhouse",
    #                 "Physiological Observations Per Greenhouse",
    #                 "Predator Observations Per Greenhouse",
    #                 "Weed Observations Per Greenhouse",
    #                 "Disease Observations Per Greenhouse",
    #                 "Pest Observations Per Greenhouse"
    #             ]]
    #         ]
    # },
    # {
    #     "doctype": "Insights Dashboard v3",
    #     "filters": [
    #             ["title", "in", [
    #                "Scouting Observation Trends",
    #                "Chemicals Dashboard",
    #                "Scouting Efficiency Dashboard"
    #             ]]
    #         ]
    # }
]
