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
    "Spray Product": "public/js/spray_product.js",
    "Warehouse": "public/js/warehouse.js",
    "Pest": "public/js/pest.js",
    "BOM": "public/js/bom.js",
    "Field Unit Automation": "public/js/field_unit_automation.js",
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
	# Every other SCP custom field on a shared doctype (Work Order, BOM, Farm,
	# Warehouse, Item, Notification Log). These used to ship as a Custom Field
	# fixture; a fixture only restores what some site last exported, which is how
	# `Work Order.workflow_state` and `Farm.spray_plan_approvers` came to be
	# missing on a fresh install. Declared in code so every site converges.
	"upande_scp.serverscripts.common.custom_fields.ensure_scp_custom_fields",
	# The four spray-flow Stock Entry Types. A patch creates these too, but a
	# fresh install marks every patch as done without running it, so the seed
	# never happened on a new site — and approve_and_forward cannot create its
	# transfer without them. See that function's docstring.
	"upande_scp.serverscripts.store.spray_stock_types.ensure_spray_stock_entry_types",
	# The tank-mix Item Group and UOM. These were hardcoded strings ("Chemical
	# Mix", "Tank Mix (1000L)") and are now settings, so the records the settings
	# point at have to exist. See common/tank_mix.py.
	"upande_scp.serverscripts.common.tank_mix.ensure_tank_mix_conventions",
	# The `custom_farm` links on BOM / Spray Team. Declared in code rather than
	# shipped as fixtures because fixture sync OVERWRITES, and a site may already
	# carry its own `custom_farm` on these shared doctypes — this creates only
	# where absent. Must precede the layout pass, same as the Stock Entry fields.
	"upande_scp.serverscripts.common.farm_fields.ensure_farm_fields",
	"upande_scp.serverscripts.common.scouting_tab_layout.enforce",
	# `Bed.unit_type` belongs to upande_core and ships with Bed + Row only. Coffee
	# units are Bands, so SCP appends that option itself rather than editing another
	# app's doctype. Append-only, so a site's own options survive.
	"upande_scp.serverscripts.geo.field_unit_types.after_migrate",
]

before_uninstall = [
	"upande_scp.serverscripts.store.stock_entry_fields.remove_scp_stock_entry_fields",
	"upande_scp.serverscripts.common.custom_fields.remove_scp_custom_fields",
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
        # Follow the Item's group in and out of the configured chemical/foliar
        # sets. Only `after_insert` was hooked, so an Item moved INTO a
        # configured group later got no Spray Product, and one moved OUT kept a
        # live record that still showed up in every picker.
        "on_update": "upande_scp.serverscripts.common.crop_protection.on_item_update",
    },
    "Orchard Tree": _SCP_CACHE_EVENTS,
    # These four were declared in cache_utils' invalidation map but never
    # hooked, so their entries were dead code and the cache never flushed for
    # them. Map Settings was the visible one: setting a farm's coordinates left
    # `get_map_settings` serving the old (0, 0) for a TTL_LONG window, so the
    # maps still opened on open ocean long after the data was fixed.
    "Map Settings": _SCP_CACHE_EVENTS,
    "Farm Map Coordinate": _SCP_CACHE_EVENTS,
    "Cost Center": _SCP_CACHE_EVENTS,
    "Disease Filter": _SCP_CACHE_EVENTS,
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

# Crop access gate.
#
# A user sees the crops grown on farms belonging to their Employee's company, and to
# every company beneath it in the tree. `crop_scope` resolves that chain; these two
# hooks apply it to everything generic — list views, link dropdowns, standard reports,
# REST, and the workspace's crop tiles, which need no change of their own because the
# SCP Navigation block reads `Crop Scouted` through a permission-checked
# `frappe.db.get_list`.
#
# Hooks cannot reach `frappe.get_all` or raw SQL, which is most of this app's read
# path, so SCP's own endpoints opt in by calling `crop_scope` directly. See
# docs/superpowers/specs/2026-08-28-crop-access-gate-design.md.
_SCOPE = "upande_scp.serverscripts.common.crop_scope"

permission_query_conditions = {
	"Crop Scouted": f"{_SCOPE}.crop_query_condition",
	"Scouting Entry": f"{_SCOPE}.scouting_entry_query_condition",
	# Only Application Floor Plans are scoped — see `work_order_query_condition`.
	"Work Order": f"{_SCOPE}.work_order_query_condition",
}

has_permission = {
	"Crop Scouted": f"{_SCOPE}.crop_has_permission",
	"Scouting Entry": f"{_SCOPE}.scouting_entry_has_permission",
	"Work Order": f"{_SCOPE}.work_order_has_permission",
}

# Bare-path aliases for the handset.
#
# The Upande-Scout app posts to short paths like `/api/method/start_work_order`, which
# Frappe only resolves via an API-type Server Script. Those scripts were dropped on
# 2026-07-17 (`57e09ce`) after an audit that found "no in-repo caller" — true of this
# repository, and false of the app, which is where the callers live. Every handset lost
# its spray list and its bed lookups.
#
# `frappe.handler.execute_cmd` consults this map before the Server Script map and before
# `get_attr`, so aliasing here fixes the binaries already in the field without a rebuild,
# and keeps the implementations as versioned, greppable, testable code.
#
# Anything added here MUST stay: a build in the field can outlive several releases, and
# these paths are its only way in.
override_whitelisted_methods = {
	"fetchScheduledApplications": (
		"upande_scp.serverscripts.mobile.scheduled_applications.fetchScheduledApplications"
	),
	"fetchGreenhouseBeds": (
		"upande_scp.serverscripts.mobile.greenhouse_beds.fetchGreenhouseBeds"
	),
	"start_work_order": (
		"upande_scp.serverscripts.mobile.start_work_order.start_work_order"
	),
	"update_work_order_dates": (
		"upande_scp.serverscripts.mobile.start_work_order.update_work_order_dates"
	),
	"update_work_order_team": (
		"upande_scp.serverscripts.spray_plan_creator.spray_session.update_work_order_team"
	),
}
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
    # NOTE: Custom Fields are no longer shipped as fixtures. Every SCP custom
    # field on a shared doctype is declared in code and rebuilt on
    # after_migrate:
    #   * serverscripts/common/custom_fields.py    — Work Order, BOM, Farm,
    #     Warehouse, Item, Notification Log (+ their child tables)
    #   * serverscripts/store/stock_entry_fields.py — Stock Entry
    #   * serverscripts/common/farm_fields.py       — custom_farm on BOM /
    #     Spray Team (create-only, never overwrites a site's own)
    # A fixture only restores what some site last exported, so a field that was
    # never exported is absent on every fresh install — which is how
    # `Work Order.workflow_state` and `Farm.spray_plan_approvers` went missing
    # on staging. Declaring them converges every site.
    # NOTE: Client Scripts are no longer shipped as fixtures. Desk form scripts
    # now live in code under public/js/ wired via doctype_js above. The legacy
    # "Spray Plan Approval v7" list-view approval UI was dropped (the React
    # Approvals page replaces it).
    # NOTE: Server Scripts are no longer shipped as fixtures. The only live one
    # ("Zone Atomation Tool" / createBedsAndZones) was moved into code at
    # upande_scp.upande_scp.doctype.field_unit_automation.field_unit_automation.run; the
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
