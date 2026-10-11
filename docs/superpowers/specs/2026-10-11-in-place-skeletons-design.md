# In-place skeletons — design

Date: 2026-10-11. UI polish, part 2. Built lean: shared pieces first, then the pages in three batches, then one review.

## What the user asked for

"Currently the skeletons are not even in the shape of the page. All the divs and constant data and headings should be in place but the contents of the divs should be skeleton."

## Facts

- **Route fallback.** `App.tsx` shows a generic `PageSkeleton` (or `MapPageSkeleton` / `ApplicationPlanSkeleton`) while a page's code chunk loads. Chunks are prefetched one at a time on idle, so the route fallback is rare after the first minute.
- **Data loading inside pages is the main gap.**
  - The Dashboard, Coverage, Scouts, Trends, Reports, Historical, Heatmaps and maps cover the page with `LoadingOverlay`: a full-screen dimmed backdrop with a progress bar.
  - Others show a spinner, a "Loading…" line or nothing until the data comes, then the layout appears and reflows.
  - Only Scouts, Sprayers and Gallery use shaped skeletons.

## Decisions

| # | Decision |
|---|---|
| K1 | **The frame is real from the first paint.** These render immediately, even with no data:<br>• `PageHeader`: title and eyebrow;<br>• tabs, filter bars and pickers (disabled while their options load, never hidden);<br>• card, section and chart titles; KPI labels; table header rows; legends; buttons;<br>• empty-state wording is NOT shown while loading. |
| K2 | **Only data slots are skeletons**, each at the size the data will take. Use the primitives in `components/Loading.tsx`:<br>• `KpiValueSkeleton` for a figure;<br>• `TextSkeleton` for a line of text;<br>• `Bar` for any block;<br>• `ChartSkeleton height={real height}` for a chart;<br>• `TableRowsSkeleton cols rows avatar` inside the real `<TableBody>`;<br>• `AvatarSkeleton` for a photo;<br>• `RowsSkeleton` for a list.<br>No layout shift when the data lands. |
| K3 | **First load vs refresh.** Use `firstLoad(loading, hasData)`.<br>• **First load:** skeletons.<br>• **Refresh** (filter change, revalidate): the old data stays on screen, with `LoadProgress` (inline, under the header) or the existing `LoadingStrip`. A refresh never blanks the page into skeletons. |
| K4 | **No full-screen overlay.** `LoadingOverlay` is replaced by `LoadProgress`, placed inline under the page header or tabs. It keeps the server's real progress figure and label. Map canvases keep their basemap and draw their frame (legend, controls, side panel titles); only markers, side-panel rows and figures are skeletons. |
| K5 | **Route fallback.** While a chunk loads, the fallback renders the real `PageHeader` with the page's title and eyebrow (from the same nav metadata the sidebar uses) above the body silhouette. It never shows a blank or anonymous title bar. |
| K6 | **Accessibility and motion.** The loading region carries `aria-busy="true"`; skeleton pieces are `aria-hidden`. Skeletons pulse with `animate-pulse`, the same as the existing ones. There are no coloured left-border strips. |
| K7 | **Out of scope.** No data or endpoint changes, no page redesigns, and no files with the user's uncommitted work: `SprayPlanTransfers.tsx`, `TransferBatchPanel.tsx`, `store-keeper-api.ts`. |

## Testing

- Vitest per page group: with the data promise pending, the page title, tab labels, card titles and table headers are in the document, and `[aria-busy="true"]` / skeleton rows are present. With data resolved, the skeletons are gone.
- The full vitest suite, tsc and `yarn build` pass.
