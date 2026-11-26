# Spray rates per unit, product types, and the block floor plan

Status: approved in conversation 2026-11-26 (user: "each product uses its own determinant, go ahead").
First site: mutara (avocado blocks). Port to kaitet after.

## Why

The rate on a Spray Product is fixed to two hard-coded units: "per 1000 L of water" or
"per 10,000 m²". Real labels say "0.5 L/ha", "1 kg/acre", "100 ml/100 L". The block
Application Floor Plan also always derives quantity from water (area × 1000 L/ha), so a
per-hectare product is planned through a water volume nobody chose. Product type is a
fixed Select, so a new type (e.g. Biostimulant) needs a code change.

## Goals

1. **Product types are a list.** New DocType `Spray Product Type` (name, description,
   disabled). `Spray Product.type` becomes a Link to it. Seed with today's options:
   Insecticide, Fungicide, Adjuvant, pH Buffer, Plant Growth Regulator. Existing values
   stay valid (same names). The Spray Product form and lists show it as before.
2. **A rate is "stock UOM per amount + UOM".**
   - Numerator: the Item's `stock_uom` (read only, e.g. Litre, Kg).
   - Denominator: `per_qty` (Float, e.g. 1, 100, 1000) + `per_uom` (Link UOM).
   - The determinant (`basis`: Water / Hectarage → shown as **Water / Area**) restricts
     `per_uom` to ERPNext UOMs of category **Volume** for Water and **Area** for Area,
     converted through `UOM Conversion Factor` (Litre and Square Meter as the base).
   - Lives on `Spray Product Crop Rate` rows (crop-scoped or blank = every crop), with
     lower/upper limits as now.
   - The Spray Product form shows each rate as a readable line, e.g.
     "Amisil: 0.3–1 Litre per 1000 Litre of water".
3. **Migration, no data loss.** Existing Water rows → `per_qty 1000, per_uom Litre`;
   Hectarage rows → `per_qty 1, per_uom Hectare` (10,000 m² = 1 ha, same numbers).
   The legacy `default_lower/upper_rate_limit` pair stays the Water fallback, read as
   per 1000 Litre. A patch fills the new fields; a missing per_uom reads as the legacy unit.
4. **Each product uses its own determinant in a plan.**
   - Area product: `qty = rate × (area sprayed in per_uom) / per_qty`.
   - Water product: `qty = rate × (water entered in per_uom) / per_qty`.
   - One tank mix can mix both.
5. **Water is a number the user types.** No longer area × 1000. It is required only when
   the mix holds a Water-basis product. For Area products it only feeds a dilution line:
   "With N L of water: X <stock UOM> per litre" per product.
6. **Area sprayed** is the selected blocks' area (editable per block as today). Blocks with
   no area block the plan with a clear "enter the block area" message.

## Floor plan UI (same release, avocado first)

7. The legend (No observations / None-low / Medium / High / Estimated) moves onto the
   filter row on the right, so the map gets the vertical space.
8. Block selection moves to the top as a multi-select filter like the observation picker:
   all, a pivot/section, or individual blocks. The map highlights the picked blocks; the
   plan panel lists them.
9. Heatmap thresholds use the **cumulative weekly** calculation the avocado alerts already
   use (per-ha cumulative over the ISO week), so colours and alerts agree.
10. The 2D/3D switch shows only when the farm has tree-level elements (trees mapped). Hexa/
    triad or plain blocks: no switch.

## Non-goals

- The field-crop vs greenhouse-crop setting and structure-driven layouts (next project).
- Converting avocado blocks to hexas (later, once trees are mapped).
- Changing roses' greenhouse Application Plan maths beyond reading the new rate units.

## Anti-goals

- Any change in quantities for existing plans or rates after migration (same numbers in,
  same quantities out).
- Hard-coded product or crop names in logic.
- A stock quantity computed client-side differently from the server's check.

## Constraints

- Quantity sent stays absolute (server stores it verbatim; see required_qty memory). The
  server's rate-range check must use the same conversion (`spray_rates.py`).
- Units come from ERPNext UOM / UOM Conversion Factor only; a UOM without a conversion to
  the base is refused with a message.
- FilterSelect/pill components; no native selects; Poppins; no vertical accent strips.

## Approaches considered

- **A. Denominator as amount + UOM on the rate row (chosen).** Matches labels exactly,
  reuses ERPNext UOM conversions, keeps one table.
- B. A fixed list of composite units ("L/ha", "ml/100 L"). Simpler UI, but every new label
  unit is a code change — the problem we are removing.
- C. Store everything normalised (per m², per L) and only format on display. Hides the
  label's own unit from the user; rejected.

## Left to the builder

Field labels, exact layout of the rate editor, patch naming, how the dilution line is
styled, test structure.
