"""Tests for the dynamic-size label renderer.

These exercise the pure-function parts of ``spray_plan_labels``:
  * ``plan_label`` — tier picker
  * ``_render_label_html`` — single-label HTML
  * ``_render_thermal_html`` / ``_render_a4_html`` / ``_render_legacy_html``
    — page builders

We don't run ``get_pdf`` here — it shells out to wkhtmltopdf and would
make these tests slow and machine-dependent. The renderer's correctness
is what matters; PDF round-trip is covered by the manual verify-skill
checklist.
"""
from __future__ import annotations

import re

import frappe
from frappe.tests.utils import FrappeTestCase

from upande_scp.serverscripts.spray_plan_labels import (
	_load_tiers,
	_render_a4_html,
	_render_label_html,
	_render_legacy_html,
	_render_thermal_html,
	plan_label,
)


def _sample_label(**overrides) -> dict:
	base = {
		"se_name": "STE-TEST-001",
		"image_src": "data:image/png;base64,iVBORw0KGgo=",
		"chem_name": "Pyretone 40EC",
		"item_code": "1111133080",
		"qty_str": "1 L",
		"source": "Chemical Store",
		"target": "GH 04",
		"scheduled": "31 May 2026 09:00",
		"spray_type": "Full",
	}
	base.update(overrides)
	return base


class TestPlanLabel(FrappeTestCase):
	"""``plan_label`` must produce a deterministic, monotonic result —
	smaller labels never gain fields, never grow fonts, never grow the
	QR percentage."""

	def test_xs_under_25mm_drops_all_text(self):
		plan = plan_label(20, 20)
		self.assertEqual(plan["tier"], "xs")
		self.assertEqual(plan["fields"], [])

	def test_s_25_to_34mm_keeps_only_chem(self):
		plan = plan_label(30, 30)
		self.assertEqual(plan["tier"], "s")
		self.assertEqual(plan["fields"], ["chem"])

	def test_m1_35_to_44mm_keeps_chem_and_qty(self):
		plan = plan_label(40, 40)
		# Square 40×40 forces stack orientation via ratio guard, and
		# stack-mode strips ``from``/``to`` — but at m-1 those aren't in
		# the field list anyway, so the visible fields stay [chem, qty].
		self.assertEqual(plan["tier"], "m-1")
		self.assertEqual(plan["fields"], ["chem", "qty"])

	def test_l_60_to_99mm_keeps_warehouse_fields(self):
		# 100×60 — min_dim=60 lands in 'l' (60-99). Aspect ratio 1.67
		# is above the stack threshold so row orientation is preserved,
		# and from/to remain in the field list.
		plan = plan_label(100, 60)
		self.assertEqual(plan["tier"], "l")
		self.assertEqual(plan["orientation"], "row")
		self.assertIn("se", plan["fields"])
		self.assertIn("from", plan["fields"])
		self.assertIn("to", plan["fields"])

	def test_xl_100mm_plus_keeps_everything(self):
		plan = plan_label(102, 152)
		self.assertEqual(plan["tier"], "xl")
		for f in ("chem", "qty", "se", "from", "to", "sched", "type"):
			self.assertIn(f, plan["fields"])

	def test_qr_size_respects_floor(self):
		# Very small label — the floor should kick in.
		plan = plan_label(20, 20)
		cfg = _load_tiers()
		# xs tier's qr_min_mm is 18 in the bundled JSON.
		self.assertGreaterEqual(plan["qr_side_mm"], cfg["tiers"][0]["qr_min_mm"])

	def test_square_label_forces_stack(self):
		# 50×50 is at m-2 tier (orientation=row), but the aspect-ratio
		# guard kicks in because max/min < 1.4 → stack.
		plan = plan_label(50, 50)
		self.assertEqual(plan["orientation"], "stack")

	def test_oblong_label_stays_row(self):
		# 80×40 — m-1 tier (orientation=row), aspect ratio 2.0 is
		# well above the 1.4 stack threshold, so row is preserved.
		plan = plan_label(80, 40)
		self.assertEqual(plan["orientation"], "row")

	def test_stack_strips_from_and_to(self):
		# 50×50 → stack. Even at m-2 (which would include 'se'),
		# stack-mode drops 'from'/'to' but never present here.
		# Use 80×80 to actually trigger l-tier-with-stack.
		plan = plan_label(80, 80)
		self.assertEqual(plan["orientation"], "stack")
		self.assertNotIn("from", plan["fields"])
		self.assertNotIn("to", plan["fields"])

	def test_monotonic_field_count(self):
		# As labels shrink, field count must not grow.
		dims = [(150, 150), (100, 50), (60, 30), (40, 25), (30, 20), (20, 20)]
		prev = None
		for w, h in dims:
			plan = plan_label(w, h)
			count = len(plan["fields"])
			if prev is not None:
				self.assertLessEqual(
					count, prev,
					f"Field count grew at {w}×{h}: prev={prev}, now={count}",
				)
			prev = count


class TestRenderLabelHtml(FrappeTestCase):
	"""``_render_label_html`` produces the per-label HTML chunk."""

	def test_xs_renders_qr_only(self):
		plan = plan_label(20, 20)
		html = _render_label_html(_sample_label(), plan)
		self.assertIn("label-xs", html)
		self.assertIn("qr-fill", html)
		# No info block, no chem name, no qty.
		self.assertNotIn("Pyretone 40EC", html)
		self.assertNotIn("class=\"info\"", html)

	def test_m1_renders_chem_and_qty_but_no_warehouse(self):
		plan = plan_label(40, 40)
		html = _render_label_html(_sample_label(), plan)
		self.assertIn("Pyretone 40EC", html)
		self.assertIn("1 L", html)
		self.assertNotIn("Chemical Store", html)  # 'from' not in fields
		self.assertNotIn("GH 04", html)            # 'to' not in fields

	def test_xl_renders_everything(self):
		plan = plan_label(102, 152)
		html = _render_label_html(_sample_label(), plan)
		for piece in (
			"STE-TEST-001",
			"Pyretone 40EC",
			"1 L",
			"Chemical Store",
			"GH 04",
			"31 May 2026 09:00",
			"Full",
		):
			self.assertIn(piece, html, f"Missing {piece!r}")


class TestPageRenderers(FrappeTestCase):
	"""Page-level renderers — page size, label count, page breaks."""

	def test_thermal_page_size_equals_label_size(self):
		plan = plan_label(50, 25)
		html = _render_thermal_html([_sample_label()], 50, 25, plan)
		# @page rule must use the label dimensions.
		m = re.search(r"@page\s*{\s*size:\s*([\d.]+)mm\s+([\d.]+)mm", html)
		self.assertIsNotNone(m)
		self.assertAlmostEqual(float(m.group(1)), 50.0)
		self.assertAlmostEqual(float(m.group(2)), 25.0)

	def test_thermal_one_break_per_label(self):
		plan = plan_label(50, 25)
		labels = [_sample_label(se_name=f"STE-{i}") for i in range(3)]
		html = _render_thermal_html(labels, 50, 25, plan)
		# Every .label gets ``page-break-after: always`` via the rule.
		self.assertIn("page-break-after: always", html)
		# Three labels rendered.
		self.assertEqual(html.count("class=\"label"), 3)

	def test_a4_tile_packs_correct_count_per_page(self):
		plan = plan_label(50, 25)
		# 200mm usable W ÷ 50 = 4 cols. 287mm usable H ÷ 25 = 11 rows.
		# So 44 per A4 page.
		labels = [_sample_label(se_name=f"STE-{i}") for i in range(50)]
		html = _render_a4_html(labels, 50, 25, plan)
		# Two pages: first packs 44, second packs the remainder.
		sheets = html.count("<div class=\"sheet\">")
		self.assertEqual(sheets, 2)
		# Total labels rendered equals input.
		self.assertEqual(html.count("class=\"label"), 50)

	def test_a4_grid_template_uses_correct_columns(self):
		plan = plan_label(50, 25)
		html = _render_a4_html([_sample_label()], 50, 25, plan)
		# 200mm / 50mm = 4 cols.
		self.assertIn("grid-template-columns: repeat(4,", html)

	def test_legacy_renderer_produces_102x152_page(self):
		plan = plan_label(102, 76)  # per_page=2 geometry
		labels = [_sample_label(se_name=f"STE-{i}") for i in range(4)]
		html = _render_legacy_html(labels, 102, 76, plan)
		self.assertIn("@page { size: 102mm 152mm", html)
		# Dashed border on every label.
		self.assertIn("border-bottom: 0.3mm dashed", html)


class TestGeneratePdfSignature(FrappeTestCase):
	"""Surface-level checks on ``generate_pdf`` — input validation only,
	since we don't shell out to wkhtmltopdf in the test environment."""

	def test_rejects_label_below_floor(self):
		from upande_scp.serverscripts.spray_plan_labels import generate_pdf
		with self.assertRaises(frappe.exceptions.ValidationError):
			generate_pdf(["STE-DOES-NOT-EXIST"], width_mm=10, height_mm=10)

	def test_rejects_label_above_500mm(self):
		from upande_scp.serverscripts.spray_plan_labels import generate_pdf
		with self.assertRaises(frappe.exceptions.ValidationError):
			generate_pdf(["STE-DOES-NOT-EXIST"], width_mm=600, height_mm=600)

	def test_rejects_invalid_output_mode(self):
		from upande_scp.serverscripts.spray_plan_labels import generate_pdf
		with self.assertRaises(frappe.exceptions.ValidationError):
			generate_pdf(
				["STE-DOES-NOT-EXIST"], width_mm=50, height_mm=25,
				output_mode="invalid",
			)

	def test_rejects_empty_list(self):
		from upande_scp.serverscripts.spray_plan_labels import generate_pdf
		with self.assertRaises(frappe.exceptions.ValidationError):
			generate_pdf([])

	def test_legacy_per_page_accepted(self):
		"""``per_page=2`` is the existing client-script call shape and
		must keep flowing through validation. We can't run get_pdf in
		test, so just confirm the input passes the front gate by
		exercising the helper that maps per_page to geometry."""
		from upande_scp.serverscripts.spray_plan_labels import (
			_legacy_per_page_to_geometry,
		)
		w, h, mode = _legacy_per_page_to_geometry(2)
		self.assertEqual(w, 102.0)
		self.assertEqual(h, 76.0)
		self.assertEqual(mode, "legacy_102x152")

	def test_rejects_invalid_orientation(self):
		from upande_scp.serverscripts.spray_plan_labels import generate_pdf
		with self.assertRaises(frappe.exceptions.ValidationError):
			generate_pdf(
				["STE-DOES-NOT-EXIST"], width_mm=50, height_mm=25,
				orientation="diagonal",
			)


class TestFontScaleAndOrientation(FrappeTestCase):
	"""Font multiplier + orientation must thread cleanly through the
	renderer. We assert on the *HTML output* rather than the PDF, so
	wkhtmltopdf isn't involved."""

	def test_font_scale_multiplies_typography(self):
		plan = plan_label(102, 152)
		# Manually apply the same multiplier ``generate_pdf`` would —
		# this is the contract between the public endpoint and the
		# page renderers.
		plan["base_pt"] = round(plan["base_pt"] * 0.7, 2)
		plan["head_pt"] = round(plan["head_pt"] * 0.7, 2)
		html = _render_thermal_html([_sample_label()], 102, 152, plan)
		self.assertIn(f"font-size: {plan['base_pt']}pt", html)
		self.assertIn(f"font-size: {plan['head_pt']}pt", html)

	def test_a4_tile_landscape_swaps_sheet(self):
		from upande_scp.serverscripts.spray_plan_labels import _A4_H_MM, _A4_W_MM
		plan = plan_label(50, 25)
		# Caller (generate_pdf) hands the swapped dimensions to
		# _render_a4_html — assert the @page rule reflects that.
		landscape_html = _render_a4_html(
			[_sample_label()], 50, 25, plan,
			sheet_w_mm=_A4_H_MM, sheet_h_mm=_A4_W_MM,
		)
		self.assertIn(f"@page {{ size: {_A4_H_MM}mm {_A4_W_MM}mm", landscape_html)

	def test_a4_tile_landscape_packs_more_columns(self):
		from upande_scp.serverscripts.spray_plan_labels import _A4_H_MM, _A4_W_MM
		plan = plan_label(50, 25)
		# Portrait A4 (210 usable W − 10 margin = 200): 4 cols.
		# Landscape A4 (297 usable W − 10 margin = 287): 5 cols.
		port = _render_a4_html(
			[_sample_label()], 50, 25, plan,
			sheet_w_mm=_A4_W_MM, sheet_h_mm=_A4_H_MM,
		)
		land = _render_a4_html(
			[_sample_label()], 50, 25, plan,
			sheet_w_mm=_A4_H_MM, sheet_h_mm=_A4_W_MM,
		)
		self.assertIn("grid-template-columns: repeat(4,", port)
		self.assertIn("grid-template-columns: repeat(5,", land)

	def test_poppins_loaded_in_css(self):
		plan = plan_label(50, 25)
		html = _render_thermal_html([_sample_label()], 50, 25, plan)
		self.assertIn("Poppins", html)
