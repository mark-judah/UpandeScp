### Upande Scp

Scouting & Crop Protection Module

### Installation

You can install this app using the [bench](https://github.com/frappe/bench) CLI:

```bash
cd $PATH_TO_YOUR_BENCH
bench get-app $URL_OF_THIS_REPO --branch develop
bench install-app upande_scp
```

---

## Chemical allocations

When a chemical purchase lands, it has to be divided among the farms that asked for
it. Two things you want are in conflict:

- the split should be **proportional** to what each farm requested;
- every share must be **physically measurable** — your keeper can weigh out 10 g,
  not 4.5 g, and cannot cut a 500 g bottle in half.

The proportional answer is usually a recurring decimal, so something has to give.

There are **two modes**. Which one runs is the General Manager's choice, in
**Settings → Spray Plan → Chemical allocation**.

## Simple split — the default

Each farm's proportional share, rounded **down** to a measurable step. Whatever will
not divide evenly stays in the general store.

```
three farms each asking for 100 kg, 100 kg arrives, step 0.1
  100 / 3         = 33.333…
  rounded down    = 33.3 each
  handed out      = 99.9
  general store   = 0.1
```

That is the whole rule. Its value is that anyone can check it by hand: divide, round
down, and the leftover sits in one visible place.

**Its limit, so it does not surprise you.** When a farm's share is smaller than one
step it gets **nothing**, and the shortfall is not remembered. Five farms each
entitled to 4.5 g with a 10 g step all get zero and the full 22.5 g waits in the
store. In this mode that is accepted — the keeper can see the leftover and hand it out
on their own judgement. Every farm that asked still gets a row showing what it
requested and that it received nothing, so the leftover always has an explanation.

## Balanced split — opt-in

Two additions, both aimed at the case above.

**Leftover steps are redistributed** to the farms with the largest fractional parts
(largest-remainder, or Hamilton, apportionment), so that 22.5 g reaches two farms
instead of nobody. Deterministic — ties break on the larger basis, then farm name — so
re-running an allocation can never reshuffle one you have already published.

**Shortfalls carry forward.** The gap between a farm's exact share and what it
actually got is stored as a credit (`Chemical Allocation Credit`) and added to its
request next cycle:

```
basis = this cycle's request + credit carried in
```

Here is what that buys, on a 95/5 split with 100 arriving each cycle and a 10 g step:

| Cycle | Big farm | Small farm | Ledger after |
| --- | --- | --- | --- |
| 1 | 100 | **0** | Small +5, Big −5 |
| 2 | 90 | **10** | settled |
| 3 | 100 | **0** | Small +5, Big −5 |
| 4 | 90 | **10** | settled |

The small farm goes from *never* served to served every other cycle, and the ledger
clears itself each time it pays out. Fairness a single allocation cannot deliver,
delivered over time.

### Side by side

Two farms asking 30 and 70; the budget cuts the total from 100 to 50; 10 g step.
Exact shares are 15 and 35, neither a multiple of 10:

| Mode | Farm A (asked 30) | Farm B (asked 70) | General store | Carried |
| --- | --- | --- | --- | --- |
| **Simple** | 10 | 30 | **10** | nothing |
| **Balanced** | 10 | 40 | 0 | A +5, B −5 |

Simple leaves the spare step in the store. Balanced gives it to B — whose fraction
was larger — and records that A is owed 5 and B was paid 5 ahead.

When the arithmetic divides evenly the two modes cannot differ. Five farms wanting 10
each, cut from 50 to 45, gives **9 each** either way.

### Switching between them

Switching balancing **off** leaves any credits already earned untouched. They are not
applied and not erased — they simply wait, and resume if it is switched back on. The
general store screen says which state they are in rather than implying they will be
used.

Each allocation records the mode that produced it in the change log, so a past split
stays explicable after the setting changes.

## Rules that hold in balanced mode

**A debit is honoured like a credit.** A farm the redistribution paid ahead carries a
*negative* credit. Forgiving it would mint entitlement out of nothing and the pool
would stop reconciling.

**A budget cut is not a debt.** In the example above, A lost 15 g to the budget and a
further 5 g to the measuring step — and **only the 5 carries**. If cuts carried
forward, every reduction would quietly return as next cycle's entitlement and the
GM's financial decision would mean nothing.

**Credits conserve.** They sum to exactly the part of the leftover that was *owed*, so
the keeper can always answer "why is this 3 kg here, and whose is it?". Narrower than
"credits equal everything in the store": stock bought **beyond** total demand also
sits there, but nobody has a claim on it, so it is credited to nobody.

**A farm that asks for nothing keeps its credit** rather than having stock pushed at
it, and a debit larger than the new request stays outstanding rather than driving an
allocation negative or being quietly forgiven.

## The measuring step

The step is what your store can actually measure, in the item's stock UOM. Defaults
(`apportion.DEFAULT_STEPS`), overridable per cycle line:

| UOM | Step |
| --- | --- |
| Gram, ml | 10 |
| Kg, Litre | 0.1 |
| Bottle, Nos, anything countable or unrecognised | 1 |

Whole units are the fallback on purpose: handing over one of something is always
possible, where a guessed fraction may be unmeasurable.

Conversions between UOMs come from **ERPNext's own** `UOM Conversion Detail` rows on
the Item. This app carries no conversion table, because a "1 bottle = 500 g" constant
in code would drift from whatever you maintain.

One thing worth knowing about the arithmetic: 0.1 has no exact binary representation,
so `3 // 0.1` in Python is **29**, not 30. Before that was accounted for, every clean
kg quantity stranded one step — 100 kg allocated as 99.9 with 0.1 in the store that
nobody could explain. `_steps_in()` handles it with a relative tolerance, and
`TestFloatSafety` keeps it handled.

## Where the leftover goes

What cannot be divided stays in the **general store**, one per company. A farm's
planner can ask the keeper for some of it; the keeper decides each line. Availability
is netted against quantities already approved but not yet moved, so two planners
cannot both be granted the same last kilo.

## Nothing changes silently

Every change to a requirement, an approved total or an allocation is written to
`Chemical Allocation Change` — what changed, from, to, by whom, when — and the
affected farm's planners are notified with the figures. A planner discovering a
changed allocation by noticing the stock did not match is the failure this exists to
prevent.

Once the GM marks a figure **final** it is locked. Re-running consolidation refreshes
what was requested but never moves a settled number; changing it takes an amendment,
not an edit.

## Code and further reading

| What | Where |
| --- | --- |
| Both modes, as pure functions with no database | `upande_scp/serverscripts/store/apportion.py` |
| The cycle, reviews, allocation and the pool | `upande_scp/serverscripts/store/procurement.py` |
| Tests for the maths, incl. every example above | `upande_scp/serverscripts/tests/test_apportion.py` |
| Tests for the flow, against a real site | `upande_scp/serverscripts/tests/test_procurement.py` |
| Design record and the decisions behind it | `docs/superpowers/specs/2026-08-17-chemical-procurement-cycle-design.md`, `docs/superpowers/specs/2026-08-11-chemical-procurement-decisions.md` |

```bash
bench --site <site> run-tests --module upande_scp.serverscripts.tests.test_apportion
bench --site <site> run-tests --module upande_scp.serverscripts.tests.test_procurement
```

---

## Offline spray sessions

A supervisor with no signal scans the chemicals, makes the tank mix, sprays, and finishes.
The handset holds a **token** — the ordered log of what happened and when — and the server
replays it into the documents it should have created at the time: a Manufacture and a
Material Issue **posted at the real moments**, so the cost lands in the month the spray
did.

### The failure this had to survive

Could a synced session issue a tank mix that was never made? It splits into two, and both
were tested against real Stock Entries rather than reasoned about:

| Failure | Result |
| --- | --- |
| Issue with no Manufacture at all | **Blocked by the state machine.** `start_spray_session` requires `Tank Mix Manufactured`; `end_spray_session` requires `Spraying In Progress` **and** a submitted Manufacture entry |
| Issue posted **earlier in the ledger** than its Manufacture | **Refused** by ERPNext with `NegativeStockError` — this is the one backdating introduces, since stock is judged on posting time, not creation order |

That refusal depends on `allow_negative_stock` being **off**, so it is asserted as a tested
precondition rather than left as a lucky setting.

### How a wrong phone clock is made harmless

Not by trusting it, and not by refusing it. Three layers:

1. **Skew is measured.** While online the app records `device_now − server_now` and applies
   it to every offline stamp, so a phone seven minutes fast still produces correct moments.
2. **Moments travel as UTC**, so the phone's *timezone* cannot shift anything — only its
   clock can, and (1) handles that.
3. **The server clamps to a floor derived from data:**

```
anchor = the transfer Stock Entry's posting moment   (raws provably in the CSU)
mix_at = max(token.mix_at,   anchor)
end_at = max(token.ended_at, mix_at + 1s)
```

`max()` in both places means a wrong clock can only ever push a posting **later**, never
behind the moment its inputs arrived. Tested: the ledger refuses a consumption dated before
the transfer that delivered it, so the floor is real rather than merely polite.

The principle is borrowed from the remediation script that cleaned up the original
mis-dated backlog:

> *"The honest, valid anchor is the TRANSFER date: on that date the raw chemicals are
> provably in the CSU, so a manufacture + issue posted that day cannot fail on stock."*

### Cost is never sacrificed to make a sync succeed

`allow_zero_valuation_rate` would let anything post — at zero cost, which defeats the whole
reason for dating it correctly. A mix with no value is **refused and reported**, exactly as
the remediation script skips rather than "issuing at a zero value".

Worth knowing: a missing valuation surfaces as *"Valuation Rate for the Item ... is
required"*, which looks nothing like a stock error and is easily misdiagnosed as an
ordering problem. It was, on the first run of these tests.

### One atomic sync, not four queued calls

`register_csu_scan` → `manufacture_tank_mix` → `start` → `end` is a state machine: each step
refuses unless the previous one happened. Queued separately they can interleave across
sessions and half-fail, leaving a plan in a state nobody chose. `sync_spray_session()`
replays the log in one transaction — the session lands whole or not at all.

### It explains itself before it touches stock

The ledger *would* stop an impossible session, with a stock error naming a warehouse the
supervisor has never heard of, halfway through a transaction. `preflight()` reaches the same
conclusions first, in words about chemicals and dates:

- no submitted transfer, so there is nothing to date the mix from
- chemicals scanned that are not on this plan, or plan chemicals not scanned
- `Amistar: 0.8 needed in the CSU on 2026-08-17 08:00 but only 0.3 was there`
- the mix has no valuation, so it would post at zero cost
- the session is older than the 7-day limit and needs a person

It is whitelisted and read-only, so the handset can warn while there is still signal.

### A re-sync cannot double-post

Each session is a `Spray Session Token` named by its token id, holding what it created.
A second sync finds the row and returns it. The guarantee lives server-side deliberately:
the handset's own id lives in the handset's storage and does not survive a reinstall.

A **refused** token is kept too, with its reason. The session happened in the field; the
reason it could not be applied is worth more than a clean table.

### Two policies, and where they are set

**A late start is recorded, not refused.** If a spray began after its daily cutoff, the
token is flagged `past_cutoff` rather than rejected — the session happened, and losing the
record would be worse than flagging it. A flag can be reported on; a refusal only teaches
supervisors to stop syncing. To enforce instead, call
`postponement.assert_within_cutoff` from `offline_session._started_past_cutoff`.

**A session older than 7 days is held for a person** (`MAX_AGE_DAYS`). Backdating that far
can land behind entries that already consumed the same stock, and re-valuing those is not a
sync's decision.

### Results

| Suite | Cases | What it covers |
| --- | --- | --- |
| `test_offline_session.py` | 26 | the guard, moment clamping, idempotency, endpoint signatures |
| `test_offline_token_mechanics.py` | 11 | the ledger itself: ordering, anchor floor, backdating, valuation |
| `test_offline_sequence_feasibility.py` | 8 | the state machine's guarantees, through the real endpoints |
| `test_offline_session_e2e.py` | 10 | **one real plan through the whole chain**, on real stock |
| `spraySession.test.ts` (mobile) | 27 | skew measurement, UTC stamping, local ordering checks |
| `spraySessionDb.test.ts` (mobile) | 15 | the local store: upsert, lifecycle, what prune will not delete |
| `spraySessionRecorder.test.ts` (mobile) | 14 | the journal-always / settle-on-success rule |

### Proven end to end on kaitet

`MFG-WO-2026-05200`, a real plan with 0.8 kg of chemical genuinely in `Chepsito CSU Phase 1`,
put through scan → mix → spray → sync with the session dated two days back:

| Document | Posted | Not |
| --- | --- | --- |
| Manufacture — 0.8 kg consumed from the CSU, 1 tank mix into `Chepsito GH 14` | **2026-08-15** (the mix date) | 2026-08-17 (the sync date) |
| Material Issue — 1 tank mix out of the greenhouse, at real cost | **2026-08-15** (the spray date) | 2026-08-17 |

The Issue lands after the Manufacture in the ledger, the plan reaches `Completed`, the token
records both documents, and a second sync returns the same two rather than making more. The
test reverses the whole chain afterwards and is verified to run twice in a row leaving the
site untouched.

Four things the end-to-end run caught that no unit test had:

- **scans and sprays were credited to whoever pressed Sync**, not to whoever did the work.
  A replayed session now carries the field employee, falling back to the plan's own
  supervisor rather than the office user syncing it.
- **the CSU warehouse is mandatory on a scan row** and the token did not send it. Defaulted
  server-side from the plan's `wip_warehouse` — asking the handset to echo back something the
  server already holds is only an opportunity for the two to disagree.
- **the daily cutoff refused the sync entirely.** The cutoff governs whether work may *start*
  late; it cannot sensibly forbid *recording* a spray that already happened. The replay now
  passes `enforce_cutoff=False` and flags the token `past_cutoff` instead, which is what the
  policy above always said and the code did not yet do.
- **the Material Issue has no `work_order` link** — deliberately, so issuing causes no Work
  Order side effects — so searching for it found nothing. The sync now takes each document
  from the endpoint that created it instead of guessing.

Two findings that overturned assumptions, kept here because they are the kind of thing that
gets re-assumed:

- **The one-second gap between Manufacture and Issue is not load-bearing.** Same-second
  posting is accepted. It is kept for legibility, and the design does not depend on it.
- **Backdating does not block the submit.** It queues a `Repost Item Valuation`, so a bulk
  sync will not hang.

### Where the code is

| What | Where |
| --- | --- |
| Sync, guard, clamping | `upande_scp/serverscripts/spray_plan_creator/offline_session.py` |
| Posting moments on the chain | `spray_session.py`, `auto_material_issue.py` |
| The token record | `Spray Session Token` + `Spray Session Scan` doctypes |
| Handset token logic | `src/services/spraySession.ts` (Upande-Scout) |
| Design record | `docs/superpowers/specs/2026-08-17-offline-spray-session-design.md` |

```bash
bench --site <site> run-tests --module upande_scp.serverscripts.tests.test_offline_session
bench --site <site> run-tests --module upande_scp.serverscripts.tests.test_offline_token_mechanics
```

---

## Field units: beds, rows and bands

Roses are planted in **beds**, avocado in **rows**, coffee in **bands**. Those are
three names for one thing. All of them are rows in `tabBed`, told apart by
`unit_type`, and a band is simply what coffee calls a row — it sits on a Block and
holds trees, exactly as a row does.

That matters because it decides how much code the third crop costs. Nothing
downstream — the maps, the scouting screens, the mobile bundle — needs to learn a
new structure for coffee.

### One tool instead of three

There used to be two automations that turned a GeoJSON export into records:

| Tool | Crop | Made |
| --- | --- | --- |
| Bed And Zone Automation | roses | `Bed` + a `Zone` per zone |
| Tree And Row Automation | avocado | `Bed` (`unit_type = Row`) + an `Orchard Tree` per tree |

They already wrote into the same table and differed only in field names, GeoJSON
conventions and which child they made. Coffee would have been a third copy, so
they are now one **Field Unit Automation**, with `unit_type` selecting the
vocabulary:

| Unit Type | Crop | Children |
| --- | --- | --- |
| `Bed` | roses | `Zone` |
| `Row` | avocado | `Orchard Tree` |
| `Band` | coffee | `Orchard Tree` |

Both GeoJSON layouts and all three id conventions now work for every unit type —
a single `FeatureCollection` or one per line, and ids from `unit_id`/`child_id`,
`row_id`/`tree_id`, `line_id`/`zone_id`, or a name ending `_ROW<n>_T<n>`. Each old
tool read only its own, so an operator had to reshape an export to suit whichever
tool their crop happened to use.

Re-running is safe and is the normal way to extend a layout: anything that already
exists is counted as skipped, never duplicated. So an operator can paste an
updated export without first working out what is new.

`Band` is added to `Bed.unit_type` by Property Setter rather than by editing
upande_core's doctype, appending only, so a site's own options survive.

### What building this uncovered

Writing tests against real data showed **neither old tool could create anything on
kaitet**. `Bed`, `Zone` and `Orchard Tree` moved into upande_core, which renamed
fields and added validation the automations were never updated for:

- `Orchard Tree.tree` (Int) is mandatory and names the document. The avocado tool
  wrote only the legacy `tree_number` (Data), so every tree insert failed. New
  trees set both — `tree` because core requires it, `tree_number` because every
  reader in this app queries it and all 53,699 existing trees carry it.
- `Zone`'s geometry field is `geojson`; the rose tool wrote `raw_geojson`.
- Units and children require the warehouse's Farm to declare a matching structure
  level — "Has Beds", "Has Rows", "Has Zones", "Has Orchard Trees". **No farm on
  kaitet declares any of them**, so every insert throws.

None of it surfaced because both tools logged insert failures and carried on,
reporting a cheerful "0 created, 0 existed". The merged tool still logs rather
than raising — one bad feature must not abort a 700-feature import — but it counts
what it skipped, so a run that creates nothing says so.

**The last point is outstanding and needs the office, not a patch.** Seeding farm
types is a decision about what each farm grows; until a farm declares its levels
the tool will correctly refuse to create units there.

### The migration

All 173 documents were carried across — 96 rose, 77 avocado — keeping every name,
GeoJSON payload and sector range. Both were named after their warehouse and the
merged doctype is too, and no warehouse had a layout in both tools, so no name
changed. The patch re-checks that rather than trusting the measurement, and
refuses to pick a winner if it is ever false. The 18,796 Beds, 1,872 Rows, 154,341
Zones and 53,699 Trees are untouched.

One claim did not survive contact with the code. The merge was going to fix a
latent collision, since the rose tool matched units on `greenhouse + bed` while
ignoring `unit_type`. It cannot happen: core validates the warehouse's role too,
so a warehouse is either a Greenhouse holding beds or a Block holding rows and
bands, never both. Keying the lookup on `unit_type` is still right — it states
what the data model guarantees instead of borrowing the guarantee from another
app — but it is not load-bearing.

### What the phone gets

`getFarmDataBundle` now sends `unit_type` per unit, plus a
`unit_type_by_warehouse` summary so a screen can title itself "Bands" without
walking the list. Without it the app called every unit a bed, wrong on two of the
three crops.

The version digest gained a schema stamp, because it is otherwise built from
`modified` timestamps alone: a phone holding a bundle from before the field
existed would have gone on reporting itself up to date while missing it. Cached
bed payloads are stored verbatim, so no handset cache change was needed.

| What | Where |
| --- | --- |
| The tool | `upande_scp/upande_scp/doctype/field_unit_automation/` |
| Band as a unit type | `upande_scp/serverscripts/geo/field_unit_types.py` |
| Migration | `upande_scp/patches/v1_0/merge_field_unit_automations.py` |
| Bundle field | `upande_scp/serverscripts/mobile/get_farm_data_bundle.py` |
| Handset labels | `src/services/fieldUnits.ts` (Upande-Scout) |

```bash
bench --site <site> run-tests --module upande_scp.serverscripts.tests.test_field_unit_automation
```

---

## Pest and disease photos on the phone

A scout matching what they can see against the master needs the picture. The
masters hold full-resolution research downloads — on kaitet, 47 files totalling
**44 MB**, averaging 944 KB and up to 2048 px wide — which is not something to
send to a field phone on a metered connection, even once.

`getReferenceImages` answers with a **manifest**, not bytes. Every image file on
this site is public, so the phone fetches the pictures directly and the endpoint
only has to say which ones it needs:

| Field | What it is for |
| --- | --- |
| `key` | `"pest:Antestia Bug"` — what the phone caches against |
| `url`, `size` | the copy to download |
| `full_url`, `full_size` | the original, for tap-to-zoom |
| `content_hash` | sha256 of the original's **bytes** |

Hashing the bytes rather than the URL is the whole point. Replacing a master's
photo under the same file name is how it happens in the office; the hash changes,
so the phone notices. A URL-only check would serve that stale picture forever.
Renaming the record changes no bytes, so nothing is re-downloaded.

A `version` digest over the manifest means an up-to-date phone transfers no
listing at all — the common case, since these masters change a few times a year.

### Measured results

| | |
| --- | --- |
| Originals | 44.4 MB across 47 photos |
| What the phone downloads | **3.03 MB** — 15x less |
| Cold manifest rebuild | 345 ms |
| Warm | 0 ms |

The manifest points at a derivative fitted inside 800 px, named by the source's
content hash so it is immutable and generated on first request. Two things
measurement changed:

- Re-encoding **grew** two already-small, already-compressed photos. A derivative
  is discarded unless it saves bytes, so the manifest never offers the phone more
  than the original.
- One Predator points at a `.webp` that is not on disk. Those are reported under
  `missing` rather than shipped as URLs the phone would 404 on.

Coverage on kaitet is 34/36 pests, 13/15 diseases, 1/4 predators, 0/6 disorders —
a data gap for the office, not a code limit.

### On the handset

`referenceImages.ts` downloads only what its hashes say it does not hold, and
verifies the file is actually on disk before trusting its own index — a cache
directory can be cleared by the OS without saying so. A failure never writes off
work: one unreachable picture does not abandon the rest, and the manifest version
is stored only when nothing failed, so the next sync retries rather than believing
it is finished. Nothing here can throw into a scouting screen; a missing picture
is a worse screen, a thrown error is a scout who cannot record what they found.

It runs from the configure flow, alongside the observations the photos belong to,
because that is the one moment the phone is known to have signal and the scout is
deliberately waiting.

| What | Where |
| --- | --- |
| Manifest + derivatives | `upande_scp/serverscripts/mobile/reference_images.py` |
| Handset cache | `src/services/referenceImages.ts` (Upande-Scout) |

```bash
bench --site <site> run-tests --module upande_scp.serverscripts.tests.test_reference_images
```

---

### Contributing

This app uses `pre-commit` for code formatting and linting. Please [install pre-commit](https://pre-commit.com/#installation) and enable it for this repository:

```bash
cd apps/upande_scp
pre-commit install
```

Pre-commit is configured to use the following tools for checking and formatting your code:

- ruff
- eslint
- prettier
- pyupgrade

### License

mit
