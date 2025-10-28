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
# app_include_js = "/assets/upande_scp/js/upande_scp.js"

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
# doctype_js = {"doctype" : "public/js/doctype.js"}
# doctype_list_js = {"doctype" : "public/js/doctype_list.js"}
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

# Scheduled Tasks
# ---------------

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
website_route_rules = [
    {"from_route": "/scouts-map", "to_route": "/scouts_map"},
    {"from_route": "/observations-map", "to_route": "/observations_map"},
    {"from_route": "/variety-map", "to_route": "/variety_map"},
]

fixtures = [
    {
        "doctype": "Custom Field",
        "filters": [
            [
                "name", "in", [
                        # Warehouse fields
                        "Warehouse-custom_zone_numbering",
                        "Warehouse-custom_bed_numbering",
                        "Warehouse-custom_raw_geojson",
                        "Warehouse-custom_location",
                        # Item fields
                        "Item-custom_ghs",
                        "Item-custom_irac",
                        "Item-custom_frac",
                        "Item-custom_type",
                        "Item-custom_ghs_description",
                        "Item-custom_irac_moa",
                        "Item-custom_frac_moa",
                        "Item-custom_active_ingredients",
                        "Item-custom_toxicity",
                        "Item-custom_reentry_interval_hrs",
                        "Item-custom_targets",
                        "Item-custom_section_break_vuei1",
                        "Item-custom_chemical_intervention_threshhold",
                        # BOM fields
                        "BOM-custom_water_hardness",
                        "BOM-custom_water_ph",
                        "BOM-custom_item_group",
                        # BOM Item fields
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
                        # Work Order Item fields
                        "Work Order Item-custom_updated_required_qty"
                ]
            ]
        ]
    },
    {
        "doctype": "Web Page",
        "filters": [
            ["name", "in", [
                "new-spray-plan"
            ]]
        ]
    },
    {
        "dt": "Client Script",
        "filters": [
            [
                "name",
                "in",
                [
                    "Bed And Zone Automation Tool",
                    "Work Order Toggle Fields",
                    "BOM Toggle Fields",
                    "Items Toggle Fields",
                    "Greenhouse Map",
                    "Pests Legend Color Toggle",
                    "Refresh Greenhouse Rentry Time"
                ]
            ]
        ]
    },
    {
        "dt": "Server Script",
        "filters": [
            [
                "name",
                "in",
                [
                    "Get Pests Data",
                    "Get Plant Diseases Data",
                    "Zone Atomation Tool",
                    "Get BOM Stock Balances",
                    "Get Greenhouse Reentry Status",
                    "Create Scouting Entry",
                    "Pre-Validate Frac/Irac Guidelines",
                    'Store Updated WO Required Qty',
                    "Restore Updated WO Required Qty",
                    "Create Chemical Plan Work Order",
                    "Get Scouting Analysis",
                    "Get Scouting Data",
                    "Fetch Greenhouse Beds",
                    "Fetch Scheduled Applications"
                ]
            ]
        ]
    },
    {
        "dt": "Print Format",
        "filters": [
            [
                "name",
                "in",
                [
                    "Spray Plan"
                ]
            ]
        ]
    },
    {
        "doctype": "Insights Workbook",
        "filters": [
            ["title", "=", "Scouting & Crop Protection"]
        ]
    },
    {
        "doctype": "Insights Query v3",
        "filters": [
                ["title", "in", [
                   "Physiological Disorder Trends",
                    "Total Greenhouses",
                    "Application Floor Plan Schedule",
                    "Application Floor Plans Status",
                    "Total Greenhouses Scouted",
                    "Bed Coverage",
                    "Daily Chemical Cost",
                    "Monthly Chemical Usage",
                    "Daily Chemical Usage",
                    "Weed Trends",
                    "Predator Trends By Stage",
                    "Pest Trends By Stage",
                    "Disease Trends By Stage",
                    "Scout Movement",
                    "Scout Performance",
                    "Greenhouse Coverage Percentage",
                    "Minutes Per Bed",
                    "Incident Observations",
                    "Physiological Observations",
                    "Predator Observations",
                    "Weeds Observations",
                    "Disease Observations",
                    "Pest Observations"
                ]]
            ]
    },
    {
        "doctype": "Insights Chart v3",
        "filters": [
                ["title", "in", [
                    "Physiological Disorder Trends",
                    "Weed Trends",
                    "Predator Trends By Stage",
                    "Pest Trends By Stage",
                    "Disease Trends By Stage",
                    "Application Schedule",
                    "Application Floor Plan Tiles",
                    "Total Greenhouses Scouted",
                    "Bed Coverage",
                    "Total Greenhouses",
                    "Daily Chemical Cost",
                    "Monthly Chemical Usage",
                    "Daily Chemical Usage",
                    "Scout Movement (Total Zones Covered Every 5 minutes)",
                    "Scout Performance",
                    "Greenhouse Coverage Percentage(Beds)",
                    "Minutes Per Bed",
                    "Incident Observations Per greenhouse",
                    "Physiological Observations Per Greenhouse",
                    "Predator Observations Per Greenhouse",
                    "Weed Observations Per Greenhouse",
                    "Disease Observations Per Greenhouse",
                    "Pest Observations Per Greenhouse"
                ]]
            ]
    },
    {
        "doctype": "Insights Dashboard v3",
        "filters": [
                ["title", "in", [
                   "Scouting Observation Trends",
                   "Chemicals Dashboard",
                   "Scouting Efficiency Dashboard"
                ]]
            ]
    }
]
