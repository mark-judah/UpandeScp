# Greenhouse 3D terrain — peaks and troughs from zone counts

**Date:** 2026-08-11
**Status:** approved, not yet implemented

## Goal

A 3D view of one greenhouse as a continuous surface whose height is the
observation count — a platform with peaks and troughs, flowing smoothly from one
peak to the next since the beds are closely packed — morphing across scouted
weeks so pest build-up and collapse read as terrain change, with spray events
marked on the weeks they happened.

## Decisions

| Question | Decision |
| --- | --- |
| Placement | 2D/3D toggle on an existing Heatmaps card |
| Height | Raw observation count per zone |
| Colour | Severity tier from the existing thresholds |
| Animation | Week playback, spray events pulse; **incomplete weeks skipped** |
| Renderer | three.js (already a dependency, already used in `maps/TreesLayer.ts`) |
| Tweening | gsap (already a dependency, currently imported nowhere) |

**anime.js is not being added.** It was the original suggestion, but it is a
tweening engine with no 3D renderer, and gsap — already in `package.json` —
covers that role. This design adds no new packages.

## What already exists

- `Heatmaps.tsx` fetches `zoneObs: Record<zoneName, count>` per
  (greenhouse × observation) — the height field, already on the client.
- `maps/bed-projection.ts` projects zones to 2D. The terrain lattice lifts this,
  so it renders the greenhouse's true shape rather than a synthetic grid.
- `_heatmaps.py` now buckets by ISO week with a `complete` flag per week (see
  `2026-08-11` heatmap weekly correction).
- `_trends.py::_fetch_spray_events` returns control actions keyed
  `"<week>|<station>"` with chemicals, active ingredients, targets and type.

## Server work — `heatmap_terrain`

`heatmap_card_detail` caps at 3 weeks, which is too short a morph.

New endpoint: `heatmap_terrain(greenhouse, obs_name, obs_kind, from_date, to_date)`
→ `{ weeks: [ { week, zoneObs, complete, sessions, oddZones, evenZones,
sprayEvents } ] }`, ascending by week.

It reuses `_build_cards`' week bucketing with `weeks_limit` unbounded over the
requested range, and joins the spray events already built for Trends. Scoped to
one card, so the cost stays proportional to a single greenhouse.

## Rendering — a continuous surface, not columns

A **displaced plane mesh**: a regular vertex grid over the greenhouse footprint,
each vertex raised by the interpolated height field. Not `InstancedMesh` boxes.

Boxes cannot produce the smooth peaks-and-troughs platform this is meant to be —
they give discrete pillars with vertical walls between neighbours. A displaced
plane is also cheaper: one mesh with ~10–20k vertices instead of 4,914 box
instances, and vertex heights are a single typed array, which is exactly what a
tween wants to interpolate.

- `x`/`z` from `bed-projection.ts`, so the surface covers the greenhouse's true
  footprint.
- `y` from the interpolated height field (below), normalised against the max
  across the *whole playback range* so heights stay comparable between weeks —
  per-week normalisation would make every week look equally bad.
- Vertex colour = severity tier from the existing threshold lookup. Height and
  colour therefore carry different variables: a broad green rise (many
  observations, still under threshold) reads differently from a sharp red spike.
- three.js loads lazily; the 2D path pays nothing for it.

## Unscouted zones interpolate — they never dip

**Not scouted does not mean not there.** A zone nobody visited must not render as
a hole or a trough: a dip asserts absence, which is a claim the data does not
support, and it is the same error as flat-ground-means-clean.

Beds are closely packed and pest pressure is spatially autocorrelated, so the
best available estimate for an unvisited zone is its scouted neighbourhood. The
height field is therefore built in three steps:

1. **Sample** — place each scouted zone's count at its projected position.
2. **Fill** — estimate unscouted positions by inverse-distance weighting from the
   nearest scouted zones, so a gap between two peaks rises rather than collapses.
3. **Smooth** — a light Gaussian pass so the surface flows from peak to peak
   instead of stepping per bed.

This matters more than it first appears: scouts cover odd beds one session and
even beds the next, so in any single session **every other bed is unscouted**.
Rendering those as holes would draw the greenhouse as a comb.

### Measured vs inferred must still be legible

Interpolation fixes the false dip but introduces a new risk — inferred ground
looking exactly as authoritative as measured ground. Keep them distinguishable
*without* deforming the surface:

- Interpolated regions render **desaturated**, with confidence falling off with
  distance from the nearest scouted zone. Far-from-any-observation areas wash out
  toward grey while keeping their height.
- No geometric cue is used for confidence — height means count and only count.
- A legend states plainly that pale ground is estimated, not measured.

A zone scouted with zero observations is *measured* zero: full saturation, low
height. An unscouted zone sitting between two peaks is *inferred*: pale, and
raised to match its neighbours. That is the distinction the viewer needs, and it
now lives in colour rather than in shape.

## Playback

- Steps through the weeks in the range, oldest → latest.
- **Incomplete weeks (`complete === false`) are skipped.** Interpolation stops a
  half-scouted week from collapsing, but it cannot manufacture information: a
  week sampled from one bed parity is a materially weaker estimate, and stepping
  through it alongside full weeks would present a guess with the same authority
  as a measurement.
- **Skipped weeks stay visible in the timeline** as greyed, non-selectable ticks
  labelled "half scouted". Silently compressing them would misrepresent the
  cadence — 101 of 229 greenhouse-weeks on this site are incomplete, so a
  12-week range may drop ~5 of them. The viewer must be able to see that the
  jump from W27 to W30 is a data gap, not three quiet weeks.
- If **fewer than two complete weeks** exist in the range, playback is disabled
  and the terrain renders as a single static frame with a note explaining why.
- gsap tweens the vertex-height array between consecutive complete weeks, and the
  per-vertex confidence alongside it. A zone that goes from scouted to unscouted
  therefore shifts from saturated to pale while its height eases toward the
  interpolated neighbourhood value — it never collapses, because losing coverage
  is not the same as losing pests.
- A week with a spray fires a pulse on its frame, tinted by whether the work
  order's `targets` included the charted observation. The tooltip leads with the
  active ingredient (populated for ~82% of real events).

## Controls

Play / pause / scrub, a week label, and a legend covering height (count), colour
(severity tier) and paleness (estimated rather than measured).
Camera: orbit + zoom, no fly-throughs.

## Accessibility and fallbacks

- `prefers-reduced-motion` skips playback and lands on the latest complete week.
- No WebGL → the 3D toggle hides itself, 2D stays.
- The 2D `BedSvg` view remains the default and is never removed.

## Testing

- **Python**: `heatmap_terrain` returns ascending weeks; `complete` flags match
  `parity_balanced`; spray events land on the right week/station; range with no
  complete weeks returns a usable payload.
- **Vitest**: the pure parts — the height field is where the real logic lives, so
  it carries the most tests:
  - interpolation raises a gap between two peaks instead of dipping (the
    correction this design turns on), and never exceeds its neighbours;
  - a measured zero stays zero and stays saturated, while an unscouted zone
    beside it is raised and desaturated;
  - confidence falls with distance from the nearest scouted zone;
  - an alternating odd/even sample produces a smooth surface, not a comb;
  - height normalisation across the range; the complete-week filter; and the
    week→frame mapping (skipped weeks keep their timeline position).
- The three.js layer itself is not unit-tested (no WebGL in jsdom); it is covered
  by the pure functions feeding it plus manual verification.

## Out of scope

- Multi-greenhouse terrain — one house is the honest unit.
- Camera fly-throughs and cinematic transitions.
- Editing or drill-down from the 3D view; it is a read-only visualisation.
- Replacing the 2D heatmap.

## Risks

1. **Interpolation is a model, and models can mislead.** A smooth surface implies
   confidence the sample may not justify — a single scouted zone surrounded by
   unvisited ones will raise a broad hill from one data point. The desaturation
   channel is what keeps that honest, so it is a correctness requirement, not
   decoration. If it proves too subtle in practice, the fallback is to cap the
   interpolation radius and let far-from-anything ground stay flat *and* grey.

2. **Grid resolution vs. bed spacing.** The vertex grid must be fine enough to
   resolve adjacent beds, or genuine bed-to-bed differences get smoothed away
   before they are ever drawn. Needs checking against the tightest real bed
   spacing, not assumed.

3. **4,914 zones is the upper bound measured here.** A displaced plane should hold
   60fps comfortably, but the sample-fill-smooth pass runs per frame change and
   needs verification on the real worst-case greenhouse.
4. **Skipping incomplete weeks can leave very few frames.** Over a short range a
   greenhouse may have only one complete week, so the static-frame fallback is
   the common path, not an edge case.
5. **Height normalisation across the range** means adding a new week can rescale
   the whole terrain. Acceptable, but the legend must state the scale.
