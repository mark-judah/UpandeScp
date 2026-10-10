# One icon set (item 9b) — design

Date: 2026-10-10. Built lean (one build + one review). The user chose two things: the shared icons live in `upande_scp`, and "desktop" means the Frappe desk.

## Facts

- SCP web and Livestock web both use lucide-react ^0.475. SCP draws its domain shapes in code:
  - map stage markers in `frontend/src/pages/maps/MarkerDefs.tsx` (10 shapes keyed by `Stage.icon_key`);
  - weather in `frontend/src/components/WeatherGlyph.tsx`.
- Livestock has 8 lucide-style notice SVGs in `upande_livestock/public/icons/`, served through `notice.py icon()`.
- The mobile apps use `@expo/vector-icons` (Material). Scout has no `react-native-svg` and draws nothing for `icon_key`.
- The Frappe desk supports app icon sprites through the `app_include_icons` hook (frappe and erpnext use it). SCP's hook is commented out.
- Every `icon_key` in use on kaitet.local is one of the 10 marker shapes.

## Decisions

| # | Decision |
|---|---|
| I1 | **Single source:** `upande_scp/shared/icons/<category>/<key>.svg`. Each icon is a 24×24 viewBox in `currentColor`. Categories: `stage` (the 10 marker shapes; the key equals the `icon_key`), `weather`, `notice` (the 8 Livestock icons) and `brand` (the Upande mark). Every shape has a well-defined fill so map markers can still be filled with the legend colour. |
| I2 | **Generic UI icons stay lucide.** Web keeps lucide-react. Mobile keeps `@expo/vector-icons` in this piece. Swapping mobile Material icons to `lucide-react-native` screen by screen is follow-up 9c. |
| I3 | **Generator:** `scripts/build_icons.mjs` is plain Node with no new dependencies. One run writes every target, all committed: (a) `shared/icons/manifest.json` (key → category, viewBox, inner markup) plus `defaultStageKey: "circle"`; (b) the desk sprite `upande_scp/public/icons/scp-icons.svg` with `<symbol id="scp-<category>-<key>">`, enabled via `app_include_icons`; (c) Livestock's `public/icons/<name>.svg` regenerated from the `notice` sources under the same filenames, so `notice.py` does not change; (d) an RN module `sharedIcons.ts` (key → SVG XML string) written into the Scout app. A `--check` flag fails when any output is stale. A vitest/pytest test runs it. |
| I4 | **SCP web:** a `SharedIcon` component (`name`, `size`, `fill`/`stroke`) renders from the manifest. `MarkerDefs` builds its `<symbol>`s from the manifest's stage icons; `iconKeyToShape`, `MARKER_ID` and the ids stay the same, so map callers do not change. `WeatherGlyph` takes its glyphs from the manifest's weather icons and keeps the same exported API. |
| I5 | **Desk:** `app_include_icons = ["upande_scp/icons/scp-icons.svg"]`, so `frappe.utils.icon("scp-stage-star")` works in desk forms. The Stage form shows a preview of its `icon_key` (small client script). |
| I6 | **Scout RN:** add `react-native-svg` (Expo 54 pinned version via `expo install`) and a `StageIcon` component that uses `SvgXml` over `sharedIcons.ts`, with the circle as the fallback for an unknown key. Show it beside the stage name wherever the observation UI lists stages. This needs a new app build, which the user already has to do. |
| I7 | Icons render identically to today's shapes, so a visual change is not the goal. Unknown keys fall back to circle everywhere. |

## Out of scope

The generic mobile icon swap and the other three mobile apps (9c), new icon artwork, and the email work.

## Testing

- Generator `--check` passes on committed outputs.
- Vitest: `SharedIcon` renders, `MarkerDefs` still emits all 10 symbol ids, `WeatherGlyph` snapshot keys are unchanged.
- Pytest: the hook path exists, the sprite contains every manifest key, and the Livestock notice files match their sources.
- Jest (RN): `StageIcon` falls back to circle.
- `yarn build` and `tsc` pass.
