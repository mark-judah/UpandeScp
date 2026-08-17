# Traceable chemical QR codes — design

**Date:** 2026-08-17
**Status:** implemented
**Supersedes:** the payload built by `qr.qr_generator.build_chemical_qr_payload`

## The problem

Today's QR payload is `f"{chemical_name}\n{qty} {uom}"` — e.g. `"Score 250 EC\n10 L"`.

Three consequences, in order of how much they matter:

**It proves nothing.** `register_csu_scan` stores `qr_payload` on the scan row and
**never reads it**. The only check is `if item_code not in required: throw`, and
`item_code` arrives as a separate client parameter. So a label printed for one
greenhouse satisfies another greenhouse's work order for the same chemical, and a
hand-typed `item_code` with no scan at all is indistinguishable from a real scan.

**It carries no identity.** Two transfers of the same chemical at the same quantity
produce byte-identical codes. Nothing ties a sticker to the Stock Entry it was
issued against.

**Its quantity is a forecast.** The QR is generated at `se_doc.insert()` in
`spray_plan_approval.approve_and_forward` — while the Stock Entry is a **draft**.
Nothing has moved yet. The storesman submits it later via `submit_with_biometric`,
and the draft is editable in between (the module even re-saves it for
`_patch_zero_rates`). On kaitet, 2 of 3 submitted transfer SEs were modified more
than a minute after creation.

## The design

**A structured numeric code, generated after the transfer is submitted.**

Post-submission timing is what makes the quantity safe to embed: the approved
Material Transfer is what physically moved, nothing more and nothing less, so the
number in the code is a settled fact rather than a proposal. There is no later step
that can change it.

### Why structured rather than random

A random token is unforgeable but opaque: it can only be looked up. A structured code
can be taken apart segment by segment — which is what was asked for, and which matters
for the offline supervision work, where a device holding the day's schedule can
validate a scan with no network and a supervisor can read the segments off a scuffed
label and key them in.

### Density and scannability

Measured, not assumed. The smallest label tier prints the QR at **18 mm**
(`label_tiers.json`, `qr_min_mm`), and the Zebra ZQ520 is 203 dpi = 8 dots/mm.

| | modules | mm per module at 18 mm | dots per module |
| --- | --- | --- | --- |
| v1 | 21×21 | 0.857 | **6.9** |
| v2 | 25×25 | 0.720 | 5.8 |

Both clear the ~4-dot practical floor, so **module count was not the real risk** — the
error-correction level is, because what kills a thermal label in a chemical store is
smudging and scuffing, not resolution. Today's labels are generated at **ECC-L (7%
recovery)**, the weakest setting.

So this stays at **v1 (21×21)** and moves to **ECC-M (15% recovery)**: the same module
count as today with double the damage tolerance. Strictly better on both axes.

Capacity by version and ECC, measured with the bundled `qrcode` library:

| ECC | v1 (21×21) | v2 (25×25) |
| --- | --- | --- |
| L (7%) | 41 | 77 |
| M (15%) | **34** | 63 |
| Q (25%) | 27 | 48 |
| H (30%) | 17 | 34 |

The budget below is **33 digits** — inside v1-M with one spare, and the leading format
digit means a future layout may use all 34 or change shape entirely without ambiguity.

### Resolution by lookup, not reconstruction

34 digits is not enough for both a full document reference and a keyed HMAC. Rather
than trim the parts an operator needs to read, each code is **stored** when it is
generated, in an SCP-owned `Chemical QR Label` row named by the code itself.

That changes what the digits have to carry: they must be *informative*, not
*sufficient to rebuild a document name*. A scan is resolved with one lookup.

It also replaces the HMAC. Forging a code means producing one that **exists as a
stored row** — the same property a random token has, with no key to distribute or
rotate, and no key sitting on a mobile device for offline verification. The random
segment is what makes it unguessable; the structured segments are what make it
readable. The offline case is served by shipping the day's codes with the schedule
download.

### The layout — 33 digits

```
1 26 2562406 0347 00225 005200 84915177
│  │     │     │     │     │       └──── 8  random
│  │     │     │     │     └──────────── 6  WO numeric tail
│  │     │     │     └────────────────── 5  qty × 100
│  │     │     └──────────────────────── 4  item surrogate
│  │     └────────────────────────────── 7  SE numeric tail
│  └──────────────────────────────────── 2  year (YY)
└─────────────────────────────────────── 1  format version
```

Each width is set by what the site actually contains:

| Segment | Width | Why |
| --- | --- | --- |
| format version | 1 | `1` today. Lets the layout change later without ambiguity — this is the future-proofing, rather than reserving spare digits. |
| year | 2 | `YY`. Naming-series counters reset per year, so the tail alone is not unique across years. |
| SE numeric tail | 7 | Largest today 2,562,406. Headroom to 9,999,999. |
| item surrogate | 4 | **15 of 695 chemical item codes are not numeric** (`Foliar 1000`, `Good Pest`), so the item code itself cannot be encoded. 697 items today, room for 9,999. |
| qty × 100 | 5 | **0 of 1051 chemical stock-entry lines need more than 2 decimals.** Transfer-for-manufacture max is 2.25; 5 digits allows 9,999.99. On overflow the sentinel `99999` means "read it from the document", which is safe because the document is authoritative on scan anyway. |
| WO numeric tail | 6 | Largest today 5,202. |
| random | 8 | 10⁸ space. Unguessable, and a guess must also hit a stored row. |

Deliberately **not** encoded:

* the Stock Entry naming series (two are live: `MAT-STE-…` and `SE-…`) and the
  amendment suffix — the stored row names the exact document, so the digits do not
  have to;
* the line index — the item surrogate identifies the line for a human reader, and
  where one Stock Entry carries the same item twice the two rows differ by their
  random segment, which the lookup distinguishes.

### The item surrogate

The item code cannot go in the code: 680 of 695 chemical items are numeric but 15 are
not, and nothing stops more text codes being created.

Each item instead gets a small stable integer on its SCP-owned sidecar —
`Chemical.qr_item_id` or `Foliar.qr_item_id` (479 + 218 rows today, auto-created 1:1
with Item). Allocated lazily from a single shared counter so the two sidecar types
never collide, and never reused.

Chosen over a field on `Item` because Item is ERPNext's, and this app's custom fields
on shared doctypes have already caused missing-column failures on other sites. The
sidecars are ours.

### Verification on scan

`register_csu_scan` parses the payload and, when it is a v1 composite code:

1. **looks up the stored `Chemical QR Label`** — a code that was never issued does not
   exist as a row, which is what makes the 8 random digits unforgeable;
2. **requires the Stock Entry to be `docstatus == 1`** — this is what makes a
   cancelled transfer's label dead. 9 of 12 transfer SEs on kaitet are cancelled, so a
   voided label in somebody's hand is the normal case, not an edge case;
3. **requires the label's `work_order` to match the one being scanned against** — the
   check that stops a label from another plan;
4. **requires the label's `item_code` to match the scanned item**;
5. **cross-checks the digits against the stored row.** The segments and the row are
   written together, so a disagreement means the digits were altered.

Anything that fails is refused with a message naming which check failed — a scan
that cannot be verified must not be recorded as though it were.

### Legacy labels

Labels printed before this change are in circulation and carry the old text payload.
They cannot be verified, and they also must not be silently treated as verified.

So: a payload that is not a composite code is **accepted but recorded as
unverified** (`qr_verified = 0` on the scan row), and the reason is logged. The audit
trail then distinguishes a scan that proved something from one that did not, without
stopping work on the day the change ships. `regenerate_qrs` reissues codes for
submitted entries; once a farm has reprinted, its scans become verified with no
further intervention.

## Where generation moves to

From `spray_plan_approval.approve_and_forward` (draft insert) to the existing
`stock_entry_state.on_submit` dispatcher, which is already wired against
`Stock Entry.on_submit` and already switches on purpose.

This fits the rest of the flow unchanged: `store_label_printing` already filters
`docstatus = 1 AND has_qr`, so labels were only ever *printed* for submitted
entries. Moving generation later also removes today's oddity of QR images existing
for drafts that may never be submitted.

One visible consequence: `approve_and_forward` returns `qr_labels`, and
`Approvals.tsx` renders "· 3 QR labels" as approval feedback. That list is now empty
at approval time, and the message says the labels will be generated when the store
issues the chemicals — which is more accurate about what actually happened.

## What this does not do

**It does not identify physical stock.** The code proves *which transfer a container
was issued against*. It cannot prove which litre is in the jug: batch and serial
tracking are off on all 695 chemical items and there are zero Batch records, so
ERPNext treats the stock as fungible. Three transfers of item `1111156005` — 0.80,
0.37 and 0.94 kg, two from Chepsito and one from Kaptumbo, for three different work
orders — merged into one 452.11 kg Bin quantity in `Chepsito CSU Phase 1`. Only
batches would separate those, and even then the identity ends at the tank mix.

**It does not survive mixing.** Once chemicals are combined into a tank mix, the
inputs' identity ends at the Manufacture entry.

## Proof on live data

The three transfers that previously produced byte-identical labels — same chemical,
same CSU, three different work orders — now carry distinct codes, issued by running
the real submit path:

| Stock Entry | WO | Qty | Code |
| --- | --- | --- | --- |
| SE-2026-2562402 | …5198 | 0.94 | `126256240200030009400519881122399` |
| SE-2026-2562403 | …5199 | 0.37 | `126256240300030003700519928403166` |
| SE-2026-2562406 | …5200 | 0.80 | `126256240600030008000520080766989` |

`explain_code` reads the first back as *"v1 · year 2026 · stock entry …2562402 · item
#3 · qty 0.94 · work order …5198"*, and scanning it against WO-05199 is refused with
"this label belongs to MFG-WO-2026-05198, not MFG-WO-2026-05199" — the check that was
impossible before.

## Tests

`test_chemical_qr.py`:

* round-trip encode → decode for every segment;
* the 33-digit width, and that it renders at QR **v1 at ECC-M** — the density and
  scannability claims the whole layout rests on;
* a flipped digit changes the code (so it will not resolve);
* non-numeric item codes get a surrogate and round-trip;
* an amended SE does not collide with the document it amends;
* quantity encoding at 3 decimals, and refusal on mismatch;
* a cancelled Stock Entry's code is refused;
* a code whose SE belongs to another work order is refused;
* a legacy text payload is accepted but marked unverified.
