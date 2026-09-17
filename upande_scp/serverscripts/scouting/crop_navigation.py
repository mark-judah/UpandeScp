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


# Per-view mark and tint for the desk tiles. Kept here rather than in the
# block's HTML for the same reason the link sets are: a view that gains a tile
# on a second crop should not need its icon pasted twice.
#
# The first seven are the ones the block has always drawn, colours unchanged, so
# the tiles a roses user knows look exactly as they did. The rest are new
# because those views had no desk tile before — every crop's links went to
# roses.
#
# Inner SVG markup only: the block supplies the <svg> wrapper, so viewBox,
# stroke and width cannot drift between one tile and the next.
VIEW_ICONS = {
	"dashboard": (
		'<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/>'
		'<rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>',
		"rgba(59,130,246,.13)", "#3b82f6",
	),
	"scouting-map": (
		'<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
		"rgba(34,197,94,.13)", "#16a34a",
	),
	"spraying": (
		'<path d="M12 2s6 7 6 12a6 6 0 0 1-12 0c0-5 6-12 6-12z"/>',
		"rgba(6,182,212,.13)", "#0891b2",
	),
	"application-plan": (
		'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>'
		'<polyline points="14 2 14 8 20 8"/><line x1="9" y1="14" x2="15" y2="14"/>'
		'<line x1="9" y1="18" x2="13" y2="18"/>',
		"rgba(139,92,246,.13)", "#7c53e0",
	),
	"approvals": (
		'<path d="M9 11l3 3L22 4"/>'
		'<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
		"rgba(245,158,11,.13)", "#d97706",
	),
	"chemical-dashboard": (
		'<line x1="6" y1="20" x2="6" y2="12"/><line x1="12" y1="20" x2="12" y2="4"/>'
		'<line x1="18" y1="20" x2="18" y2="9"/>',
		"rgba(16,185,129,.13)", "#059669",
	),
	"settings": (
		'<circle cx="12" cy="12" r="3"/>'
		'<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06'
		'a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09'
		'A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83'
		'l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09'
		'A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83'
		'l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09'
		'a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83'
		'l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09'
		'a1.65 1.65 0 0 0-1.51 1z"/>',
		"rgba(100,116,139,.13)", "#64748b",
	),
	"trends": (
		'<polyline points="3 17 9 11 13 15 21 7"/><polyline points="14 7 21 7 21 14"/>',
		"rgba(139,92,246,.13)", "#7c53e0",
	),
	"observations": (
		'<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
		"rgba(6,182,212,.13)", "#0891b2",
	),
	"traps": (
		'<circle cx="12" cy="12" r="9"/><line x1="12" y1="2" x2="12" y2="6"/>'
		'<line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/>'
		'<line x1="18" y1="12" x2="22" y2="12"/>',
		"rgba(245,158,11,.13)", "#d97706",
	),
	"heatmaps": (
		'<path d="M9 2h6a1 1 0 0 1 1 1v1H8V3a1 1 0 0 1 1-1z"/>'
		'<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>'
		'<line x1="8" y1="11" x2="16" y2="11"/><line x1="8" y1="16" x2="13" y2="16"/>',
		"rgba(219,39,119,.13)", "#db2777",
	),
	"reports": (
		'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>'
		'<polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/>'
		'<line x1="8" y1="17" x2="14" y2="17"/>',
		"rgba(15,118,110,.13)", "#0f766e",
	),
}

# A view with no mark of its own still gets a tile, drawn with a neutral dot
# rather than being dropped or borrowing another view's colour.
FALLBACK_ICON = ('<circle cx="12" cy="12" r="8"/>', "rgba(100,116,139,.13)", "#64748b")


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
					_tile(slug, view, tile_label, sub)
					for (view, tile_label, sub) in tiles
				],
			}
		)
	return out


def _tile(crop_slug: str, view: str, label: str, sub: str) -> dict:
	icon, tint, colour = VIEW_ICONS.get(view, FALLBACK_ICON)
	return {
		"view": view,
		"label": label,
		"sub": sub,
		"href": f"/scp_app#/{crop_slug}/{view}",
		"icon": icon,
		"tint": tint,
		"colour": colour,
	}
