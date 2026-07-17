# Reference-data seeding (not shipped as fixtures)

Some reference/config data used to ship as Frappe **fixtures** (auto-imported on
every `bench migrate`). That was wrong for data that is either **site-specific**
(references this site's Farms, Items, etc.) or **derivable** — shipping it
overwrites per-site edits and pollutes fresh installs. Those fixtures were
removed. Populate the data per site as described below.

| Data | How it used to ship | Populate now |
|------|--------------------|--------------|
| **Stage** catalog | `fixtures/stage.json` | Migration patch (automatic) |
| **Crop Scouted** | `fixtures/crop_scouted.json` | Console snippet (this doc) |

---

## Stage catalog

The `Stage` DocType (pest/disease life-stage names + `icon_key` marker shapes)
is seeded idempotently by the migration patch
`upande_scp/patches/v1_0/seed_stage_catalog.py`. It creates a `Stage` for every
distinct stage name found across the pest/disease filter child tables and maps
each to a frontend marker shape.

Nothing to do on a normal deploy — it runs during:

```bash
bench --site <site> migrate
```

To (re-)run just this seeder (safe/idempotent — skips names that already exist):

```bash
bench --site <site> execute upande_scp.patches.v1_0.seed_stage_catalog.execute
```

Operators can then refine any stage's `icon_key` in the desk UI.

---

## Crop Scouted

`Crop Scouted` is **site-specific** — each row links this site's Farms, variety
Items, and per-crop observation filters (predators / weeds / incidents /
physiological disorders / plant sections). It must be configured per site, not
shipped.

### 1. Seed the base crops

This creates the three crops with their default scouted **plant sections**.
Idempotent — skips crops that already exist. Run in the site console
(`bench --site <site> console`) or save as a one-off script:

```python
import frappe

CROPS = {
    "Avocado": ["Stem", "Fruit", "Leaf"],
    "Rose":    ["Stem", "Bud", "Leaf", "Flower"],
    "Coffee":  ["Stem", "Cherry", "Leaf"],
}

for crop_name, sections in CROPS.items():
    if frappe.db.exists("Crop Scouted", crop_name):
        print("skip (exists):", crop_name)
        continue
    doc = frappe.new_doc("Crop Scouted")
    doc.crop_name = crop_name
    for sec in sections:
        # only add sections that exist as Plant Section Filter rows on this site
        if frappe.db.exists("Plant Section", sec):
            doc.append("plant_sections_scouted", {"plant_section": sec})
    doc.insert(ignore_permissions=True)
    print("created:", crop_name)

frappe.db.commit()
```

### 2. Configure the site-specific filters (desk UI)

Open each **Crop Scouted** record and set, per your site's data:

- **farms** — the Farms this crop is scouted on (e.g. Avocado → Lokitela).
- **variety** — optional variety Item.
- **predators / weeds / incidents / physiological_disorders** — the observation
  filters relevant to that crop.
- **image** — optional crop image.

These are intentionally left for per-site configuration because they reference
records that only exist on the target site.
