# SCP report emails — reconstruction notes

Rebuilt 2026-09-16 from the design decisions locked on 2026-07-22. The original
mockups were served from a session scratchpad and did not survive; these replace
them and live in the repo so that cannot happen again.

## Taken from the locked brief (not re-decided)

| | |
|---|---|
| Paper | `#f4f3ef` |
| Ink | `#161514` / `#3d3a35` / `#6f6a61` |
| Gold gradient | `#a87d0d → #edc23c` |
| Rose | `#a33a5b` |
| Avocado | `#5f7d33` |
| Coffee | `#6f4a2f` |
| Coverage levels | green `#4f7a3a` · gold `#a87d0d` · red `#9c3024` |
| Type | Poppins, falling back to a system stack |

Rules carried over: no emoji; full digits (never `1.72M`); compact, dense
spacing; no vertical accent strips; crop identity carried by pill and text, not
by a side bar.

## What changed for email

The originals were built from the UFD dashboard, which uses CSS grid, webfonts
and SVG. None of that survives Gmail or Outlook, so this reconstruction is:

- `<table>` layout, inline styles, 640px cap
- bars drawn as nested table cells with `bgcolor` — no CSS gradients on data
- Poppins named first, but designed to hold up in the fallback stack
- **charts are placeholders here.** Production renders them server-side as PNG
  and attaches them with `cid:`, per the brief. The bar rows in these mockups
  are email-safe as they stand; the trend charts are the part that becomes an
  image.

## Structure

One email per crop, mini-tabs per report type — the tab row is an index, and
the sections stack beneath it, because an email cannot hold real tabs. Roses
carries all four reports; avocado and coffee carry what their data supports.
