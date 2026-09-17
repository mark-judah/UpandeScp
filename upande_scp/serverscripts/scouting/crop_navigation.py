"""What each crop's desk section links to.

The workspace block used to carry seven tiles, every one of them pointing at
`/scp_app#/rose/...`. Somebody arriving to look at avocado was handed the roses
Application Plan — a page avocado does not have — and the crop tiles underneath
only reached each crop's dashboard, so there was no way to the Jobsheet from the
desk at all.

The crops do not have the same pages, and that is the point: roses plan bed by
bed through an Application Plan and an approval queue; avocado prescribes a
block from the Jobsheet; coffee, for now, is scouting and a weekly sheet. So the
desk shows each crop its own links.

This is the desk's copy of what `AppSidebar.navForCrop` does in the React app,
and the duplication is deliberate rather than accidental: the sidebar carries
icons, role gating and keep-alive routing that the desk has no use for, and the
desk needs a short launcher rather than the full tree. Keeping the *link sets*
here in one place at least means a new crop, or a page moving, is one edit and
not a hunt through embedded HTML.

`views` are the SPA's own route names — the hash is `#/<crop-slug>/<view>` — so
a link cannot drift from the router without the route itself being renamed.
"""

import frappe

# Per crop, the tiles the desk offers. Order is the order they read in.
# (view, label, subtitle)
CROP_TILES = {
	"Rose": [
		("dashboard", "Dashboards", "Overview & KPIs"),
		("scouting-map", "Scouting", "Today's scout movement"),
		("spraying", "Spraying", "Sprayer GPS tracks"),
		("application-plan", "Application Plan", "Create spray plans"),
		("approvals", "Approvals", "Review & approve plans"),
		("chemical-dashboard", "Chemical Dashboard", "Stock across the stores"),
		("reports", "Reports", "KEPHIS FCM & weekly"),
		("settings", "Settings", "Chemicals, farms, processes"),
	],
	"Avocado": [
		("dashboard", "Dashboards", "Overview & KPIs"),
		("trends", "Trends", "Pressure over time"),
		("scouting-map", "Scouting Map", "Orchard tree map"),
		("observations", "Observations", "What was found, where"),
		("traps", "Traps", "Trap catches"),
		("heatmaps", "Jobsheet", "Prescribe a block"),
		("reports", "Reports", "Weekly block sheet"),
		("settings", "Settings", "Thresholds & spray plan"),
	],
	"Coffee": [
		("dashboard", "Dashboards", "Overview & KPIs"),
		("scouting-map", "Scouting Map", "Where scouts walked"),
		("reports", "Reports", "Weekly block sheet"),
		("settings", "Settings", "Thresholds & spray plan"),
	],
}

# A crop nobody has configured still gets a working section rather than nothing:
# the generic scouting pages every crop has, which is what `DEFAULT_CROP_NAV`
# gives the sidebar for the same reason.
DEFAULT_TILES = [
	("dashboard", "Dashboards", "Overview & KPIs"),
	("trends", "Trends", "Pressure over time"),
	("scouting-map", "Scouting Map", "Where scouts walked"),
	("observations", "Observations", "What was found, where"),
	("traps", "Traps", "Trap catches"),
]

# Mark and accent per crop, so the desk, the app and the report emails agree on
# what colour a crop is. A crop with no mark falls back to a generic one rather
# than borrowing another crop's identity.
CROP_MARKS = {
	"rose": ("rose.png", "#a33a5b"),
	"avocado": ("avocado.png", "#5f7d33"),
	"coffee": ("coffee.png", "#6f4a2f"),
	"vegetables": ("vegetables.png", "#b4531f"),
}


def _slug(label: str) -> str:
	return (label or "").strip().lower().replace(" ", "-")


@frappe.whitelist()
def get_crop_navigation() -> list:
	"""One entry per scouted crop: its mark, its accent and its own links.

	Read by the "SCP Navigation" workspace block. Every scouted crop appears,
	including one this module has never heard of — it gets the default tiles and
	a generic mark, which is a working section rather than an absence.
	"""
	crops = frappe.get_all(
		"Crop Scouted", fields=["name", "crop_name"], order_by="crop_name asc"
	)
	out = []
	for row in crops:
		label = (row.get("crop_name") or row.get("name") or "").strip()
		if not label:
			continue
		slug = _slug(label)
		# Try the crop as named, then its singular — a farm that calls the crop
		# "Roses" should still get the rose tiles and the rose mark.
		tiles = (
			CROP_TILES.get(label)
			or CROP_TILES.get(label.rstrip("s"))
			or DEFAULT_TILES
		)
		mark = CROP_MARKS.get(slug) or CROP_MARKS.get(slug.rstrip("s"))
		out.append(
			{
				"crop": label,
				"slug": slug,
				"icon": mark[0] if mark else "",
				"accent": mark[1] if mark else "",
				"tiles": [
					{
						"view": view,
						"label": tile_label,
						"sub": sub,
						"href": f"/scp_app#/{slug}/{view}",
					}
					for (view, tile_label, sub) in tiles
				],
			}
		)
	return out
