// Copyright (c) 2026, Upande and contributors
// For license information, please see license.txt

// Preview the stage's icon_key from the shared SCP icon sprite
// (upande_scp/public/icons/scp-icons.svg, loaded by app_include_icons).
// The sprite is generated from upande_scp/shared/icons; the stage category's
// keys are the only valid icon_keys. Unknown keys fall back to the circle,
// exactly as the maps and the Scout app do.

const SCP_DEFAULT_STAGE_KEY = "circle";

function scp_stage_keys() {
	return Array.from(document.querySelectorAll('symbol[id^="icon-scp-stage-"]')).map((s) =>
		s.id.replace("icon-scp-stage-", "")
	);
}

function scp_stage_icon(key) {
	return frappe.utils.icon(`scp-stage-${key}`, "lg", "", "color: var(--text-color);");
}

function scp_render_icon_preview(frm) {
	const keys = scp_stage_keys();
	const raw = (frm.doc.icon_key || "").trim().toLowerCase();
	const known = keys.includes(raw);
	const shown = known ? raw : SCP_DEFAULT_STAGE_KEY;
	const note = !raw
		? __("No icon key: the apps draw the default circle.")
		: known
		? ""
		: __("Unknown key: the apps fall back to the circle.");

	const choices = keys
		.map(
			(k) =>
				`<span class="scp-stage-icon-choice" data-key="${k}" title="${k}"
					style="display:inline-flex;align-items:center;gap:4px;margin:0 10px 6px 0;cursor:pointer;">
					${scp_stage_icon(k)}<span class="small">${k}</span>
				</span>`
		)
		.join("");

	const $wrap = frm.get_field("icon_key").$wrapper;
	$wrap.find(".scp-stage-icon-preview").remove();
	const $preview = $(`
		<div class="scp-stage-icon-preview" style="margin-top:8px;">
			<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
				${scp_stage_icon(shown)}
				<span>${frappe.utils.escape_html(shown)}</span>
				${note ? `<span class="text-muted small">${note}</span>` : ""}
			</div>
			${keys.length ? `<div class="text-muted small">${choices}</div>` : ""}
		</div>
	`);
	$wrap.append($preview);
	$preview.on("click", ".scp-stage-icon-choice", (e) => {
		frm.set_value("icon_key", $(e.currentTarget).data("key"));
	});
}

frappe.ui.form.on("Stage", {
	refresh(frm) {
		scp_render_icon_preview(frm);
	},
	icon_key(frm) {
		scp_render_icon_preview(frm);
	},
});
