# R7a — Stop replicating the dataset to the browser

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** For a greenhouse-scoped view, cut the scouting payload from **77.91 MB raw / 6.09 MB gzipped per ISO week** to **~1.69 MB / ~0.11 MB** by filtering server-side instead of in the browser.

**Architecture:** `getScoutingEntriesChunk` already accepts a `greenhouse` parameter; `scouting-sync.ts` deliberately never sends it, so the browser downloads every greenhouse's data and filters in JS (`readEntries`). We send the filter, namespace the IndexedDB loaded-weeks registry by greenhouse exactly as it is already namespaced by crop, narrow the server projection to fields the pages actually read, and stop computing six aggregate structures no page consumes.

**Tech Stack:** Frappe 15 (Python 3.14), React 19 + TypeScript, IndexedDB.

## Global Constraints

- **Nothing rendered may change.**
- **Measured baseline** (ISO week 2026-07-06..12, `Torongo GH 16 - KR`):

  | | raw | gzipped | entries |
  |---|---|---|---|
  | today: whole site, all fields | 77.91 MB | 6.09 MB | 154 640 |
  | filtered to one greenhouse | 2.53 MB | 0.15 MB | 4 747 |
  | + drop unread fields | **1.69 MB** | **0.11 MB** | 4 747 |

- **NEVER run `bench run-tests`** — broken on this bench. `bench execute` only.
- `kaitet.local` is LIVE data — no DB writes.
- **Commit only your own hunks.** ~11 unrelated files are dirty; `git status --porcelain | grep -c "^ M"` must stay **11**. Use `git add -p` where a file you touch is also dirty.
- No `Co-Authored-By` trailer.

## Scope boundary — read this before starting

This plan covers **greenhouse-scoped views only.** Pages also support an all-greenhouses mode (`greenhouse === "__all__"` in `use-scouting.ts`). In that mode the payload legitimately stays site-wide and this change does nothing for it. **Do not** try to fix all-mode by forcing a selection — that is a display change. All-mode needs purpose-built endpoints (R7b), which is a separate, larger piece of work.

---

### Task 1: Send the filter, namespace the cache

**Files:** `frontend/src/lib/scouting-sync.ts`, `frontend/src/hooks/use-scouting.ts`

- [ ] **Step 1:** Extend `weeksMetaKey` to key on greenhouse as well as crop. It is already `${META_LOADED_WEEKS}:${crop}`; make it `${META_LOADED_WEEKS}:${crop ?? ''}:${greenhouse ?? '__all__'}`. **Follow the existing crop pattern exactly** — it is the precedent and it works.
- [ ] **Step 2:** Thread `greenhouse` through `getMissingWeeks`, `hydrateRange`, `refreshRecentWeeks` and the two `getScoutingEntriesChunk` call sites (`scouting-sync.ts:166` and `:318`), passing it to the endpoint.
- [ ] **Step 3:** In `use-scouting.ts`, pass `args.greenhouse` down when it is set and not `__all__`. When a page uses `greenhouses` (a list) or `__all__`, keep today's unfiltered behaviour.
- [ ] **Step 4:** Update the now-incorrect header comment at `scouting-sync.ts:11`, which currently states filtering never happens server-side.
- [ ] **Step 5:** `cd frontend && yarn build` must pass. Commit.

**The correctness risk to guard:** IndexedDB is shared across pages. With per-greenhouse registry keys, a week fetched for greenhouse A must not be treated as covering greenhouse B, and `readEntries` must still return only the requested greenhouse's rows. Entries themselves are keyed by name so the store can hold a mix safely — it is the *registry* that must not over-claim coverage. Verify explicitly: load greenhouse A, then B, then A again, and confirm each returns the right row count.

---

### Task 2: Narrow the server projection

**Files:** `upande_scp/serverscripts/scouting/get_complete_scouting_entries.py`

- [ ] **Step 1:** In `_build_month_entries`, drop fields no page reads. Verified unused across all five consumer pages: `owner`, `modified_by`, `modified`. Measured saving: 2.53 MB → 1.69 MB raw.
  **Check `bed`, `tree` and `row` before removing them** — they appear in some page code and may be live. If in doubt, keep them; the win is mostly in the first three.
- [ ] **Step 2:** `modified` is used by the delta-sync watermark (`get_entries_since`). Confirm removing it from the *chunk* payload does not break delta sync, which is a separate endpoint. If the client needs it, keep it.
- [ ] **Step 3:** Bump the payload cache key (there is a `K_SCOUTING_PAYLOAD_PREFIX` / version stamp) so a cached fat payload is not served to a client expecting the narrow one.
- [ ] **Step 4:** Measure and report raw + gzipped before and after. Commit.

---

### Task 3: Stop computing six unused aggregates

**Files:** `frontend/src/lib/scouting-api.ts`, `frontend/src/lib/scouting-types.ts`

`buildScoutingData` computes `pests`, `diseases`, `traps`, `greenhouses`, `scouts` and `daily` on every load. **Verified: no page reads any of them** — all five consumers use only `data.entries`:

```
RoseScouting entries=10 aggregates=0 · Observations 7/0 · TrapsMap 2/0
AvocadoHeatMap 3/0 · AvocadoTreeMap 3/0
```

- [ ] **Step 1:** Re-verify that count yourself before deleting anything — grep the whole `frontend/src` tree, not just the five pages, for `.pests`, `.diseases`, `.traps`, `.greenhouses`, `.scouts`, `.daily` reached via the hook's `data`.
- [ ] **Step 2:** If genuinely unused, stop computing them and remove them from `ProcessedData`. If any consumer exists, leave that one in place and say which.
- [ ] **Step 3:** Measure the client-side processing time before and after on a real payload. `yarn build`. Commit.

---

### Task 4: Verify and record

- [ ] **Step 1:** All eight existing checks stay green (`check_compression`, `check_agg_cache`, `equivalence.verify`, `check_scope`, `check_diagnose_cache`, `check_card_detail`, `check_zone_encoding`, `check_zone_encoding.run_served_endpoint`).
- [ ] **Step 2:** Record before/after in `docs/Optimization/dataload-architecture.md` and rebuild via `build_html.py`. Commit.

**Outstanding for the human partner:** browser check of all five pages — no browser on this host.
