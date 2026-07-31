# kaitet15 restore tooling

Scripts that built the Frappe 15 line described in
`docs/superpowers/specs/2026-07-30-kaitet15-v15-line-design.md`. They read the v15
production dump (`~/stive/code/frappe15/20260713_234519-stream-database.sql.gz`) and never
decompress it to disk.

| file | what it does |
| --- | --- |
| `stream_load.sh` | one pass over the gzip: emits whitelisted tables as-is, rewrites windowed tables to `_stage_tab…` |
| `merge_stage.py` | merges a `_stage_` table into the real one by **column intersection** (production's schema lags this bench's), `INSERT IGNORE` by default |
| `load_pass1.sh` | pass 1: full tables + July scouting window + users/roles/singles/custom fields |
| `load_stock.sh` | one pass per stock table; **raise its 3 GB guard to 4 GB before re-running** — a single table can exceed 3 GB while staging |
| `post_load.py` | the repairs a partial production restore always needs (installed_apps, DefaultValue/Singles dedupe, Notification Settings, setup wizard, tabSeries) |
| `smoke.py` | drives the load-bearing SCP endpoints; paths are the kaitet15-branch (pre-regrouping) ones |
| `*_tables.txt` | the generated whitelists — derived from each app's own DocType JSONs, not transcribed |

Order: pass 1 → `post_load.py` → `bench migrate` → (optional) `load_stock.sh` → `smoke.py`.
