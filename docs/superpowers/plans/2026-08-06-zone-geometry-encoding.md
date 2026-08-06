# Zone Geometry Encoding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Cut `getBedsAndZones` from 54.80 MB to ~5 MB (10.8× raw, 5.0× gzipped) by sending only the two fields the frontend actually reads, without changing a rendered pixel.

**Architecture:** Every zone currently ships a full escaped GeoJSON `FeatureCollection` string, but the frontend reads exactly two things from it: `features[].geometry.coordinates` and `features[].properties.line_id`. Everything else (`type`, `Feature`, `fid`, `segment_id`, `zone_id`) is dead weight. We emit a compact per-bed structure instead, exploiting the measured fact that 99.2% of beds are contiguous (zone N ends exactly where N+1 begins) so only each zone's end point need be sent. Beds that fail that test carry explicit point pairs.

**Tech Stack:** Frappe 15 (Python 3.14), React 19 + TypeScript.

## Global Constraints

- **Nothing rendered may change.** Reconstructed coordinates must match the originals to within **1e-7 degrees (~1.1 cm)**, which is the rounding we deliberately introduce and is far below display resolution.
- **Measured baseline (kaitet.local): 154 281 zones across 18 471 beds; payload 54.80 MB raw / 5.10 MB gzipped.** Target ≤6 MB raw.
- **NEVER run `bench run-tests`** — broken on this bench. Verification is `bench execute` only.
- **Commit only the paths each task names.** ~10 unrelated modified files must stay dirty. Never `git add -A`.
- No `Co-Authored-By` trailer.
- `kaitet.local` is LIVE data — no DB writes.

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `upande_scp/serverscripts/geo/zone_encoding.py` | Encode/validate; pure functions, no Frappe deps in the codec | **Create** |
| `upande_scp/serverscripts/geo/get_beds_and_zones.py` | Emit the compact payload | Modify |
| `upande_scp/serverscripts/common/cache_utils.py` | New cache key (old payload must not be served) | Modify |
| `upande_scp/serverscripts/tests/check_zone_encoding.py` | Round-trip guard over ALL real zones | **Create** |
| `frontend/src/lib/scouting-api.ts` | Decode to `{name, coords, lineId}` | Modify |
| `frontend/src/pages/maps/bed-projection.ts` · `upright-svg.ts` · `zone-utils.ts` | Consume decoded form | Modify |
| `frontend/src/pages/ApplicationPlan.tsx` · `HeatmapPoc.tsx` | Consume decoded form | Modify |

---

### Task 1: Codec + round-trip guard

**Files:** Create `zone_encoding.py`, `check_zone_encoding.py`

The wire format, per bed:
```
[bed_name, line_id, [x0,y0], [[x1,y1],[x2,y2],...], ["7","8",...], contiguous]
```
`contiguous=1`: zone i spans `points[i-1] -> points[i]` (with `points[-1]` = start). `contiguous=0`: the ends array instead holds explicit `[[xa,ya],[xb,yb]]` pairs, one per zone. Names are the `" - Zone N"` suffix where derivable, else the full name.

- [ ] **Step 1: Write the codec** — `encode_beds(rows) -> list`, `decode_bed(entry) -> [{name, coords, lineId}]`. Round every coordinate with `round(v, 7)`. Detect contiguity per bed by comparing each zone's start to the previous zone's end within `1e-9`; on any mismatch emit `contiguous=0` for that bed only.

- [ ] **Step 2: Write the guard** — `check_zone_encoding.run()`: load every Zone with geojson, encode, decode, and assert for **all 154 281 zones** that reconstructed coordinates match the original within `1e-7` and `line_id` matches exactly. Print counts of contiguous vs explicit beds. `raise SystemExit(1)` on any mismatch.

- [ ] **Step 3: Run it** — `bench --site kaitet.local execute upande_scp.serverscripts.tests.check_zone_encoding.run`. Expected: 0 mismatches, ~99% contiguous. **Any mismatch is a codec bug — fix it, do not loosen the tolerance.**

- [ ] **Step 4: Commit** `zone_encoding.py`, `check_zone_encoding.py`.

---

### Task 2: Serve the compact payload

**Files:** Modify `get_beds_and_zones.py`, `cache_utils.py`

- [ ] **Step 1:** Add `K_BEDS_AND_ZONES_V2 = "scp:beds_and_zones_payload_v2"` in `cache_utils.py` and use it. The v1 key must be abandoned, not overwritten — a rolling deploy would otherwise serve a v1 payload to a v2 frontend.
- [ ] **Step 2:** Rebuild `_build_beds_and_zones` to group by bed and return `{"v": 2, "beds": encode_beds(...)}`. Keep the variety→bed grouping the frontend needs.
- [ ] **Step 3:** Measure: print raw and gzipped size. Expected ≤6 MB raw. Report the real number.
- [ ] **Step 4:** Commit.

---

### Task 3: Frontend decode

**Files:** Modify `scouting-api.ts`, `bed-projection.ts`, `upright-svg.ts`, `zone-utils.ts`, `ApplicationPlan.tsx`, `HeatmapPoc.tsx`

- [ ] **Step 1:** In `scouting-api.ts`, decode the v2 payload into the existing tree shape but with each zone as `{name, coords: [[x,y],[x,y]], lineId}` instead of `{name, raw_geojson}`.
- [ ] **Step 2:** Update the five consumers. Each currently does `JSON.parse(raw_geojson)` then reaches for `features[].geometry.coordinates` and `features[].properties.line_id`; they now read `coords` and `lineId` directly. **Delete the now-dead parse helpers** (`parseGeo`, `parseRawGeo`).
- [ ] **Step 3:** `cd frontend && yarn tsc --noEmit && yarn build` — both must pass.
- [ ] **Step 4:** Commit.

---

### Task 4: Verify and record

- [ ] **Step 1:** Re-run `check_zone_encoding.run` and the four existing checks (`equivalence.verify`, `check_scope.run`, `check_diagnose_cache.run`, `check_card_detail.run`) — all must stay green.
- [ ] **Step 2:** Record before/after in `docs/Optimization/dataload-architecture.md` §10a and rebuild the HTML via `build_html.py`.
- [ ] **Step 3:** Commit.

**Outstanding for the human partner:** a browser check of the bed maps (ApplicationPlan diagnose, Heatmaps, HeatmapPoc, avocado maps). No browser exists on this host.
