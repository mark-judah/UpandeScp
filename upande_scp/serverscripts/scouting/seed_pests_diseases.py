"""Master seeder for scouting pests & diseases across all crops.

Single source of truth for Rose, Avocado and Coffee scouting taxonomy. For
every pest / disease it seeds, non-destructively (FILL-BLANKS-ONLY):

  - the `Pest` / `Plant Disease` master: scientific_name + identification
    guideline (ID + diagnosis, from authoritative sources — Infonet-biovision,
    CABI/PlantwisePlus, EPPO, UC IPM, UF/IFAS; cited inline);
  - the crop mapping via `Pest Filter` / `Disease Filter`;
  - the observation `stages` on each filter (life-stages for pests; the
    Fresh / Dry / Latent state set for diseases), pulled from the `Stage`
    catalog with reading_type inherited from the catalog entry.

Legend colours are handled by the canonical map in `observation_colors.py`
(this seeder calls `seed_canonical_colors()`), and images by
`fetch_pest_disease_images.py` — run that afterwards.

Non-destructive: existing scientific names / guidelines / stages are left
untouched; only empty fields and stage-less filters are populated. Scientific
names were validated against the GBIF backbone.

This supersedes `seed_coffee_pests_diseases.py`.

Run (from the bench directory):

    bench --site kaitet.local execute \
        upande_scp.serverscripts.scouting.seed_pests_diseases.run \
        --kwargs "{'dry_run': True}"

    bench --site kaitet.local execute \
        upande_scp.serverscripts.scouting.seed_pests_diseases.run
"""

import frappe

from upande_scp.serverscripts.scouting.observation_colors import seed_canonical_colors

# Stage catalog entries this seeder relies on that may not exist yet.
# (name, icon_key, default_reading_type). Fresh/Dry already exist; Latent is new.
REQUIRED_STAGES = [
    ("Latent", "star", "Checkbox"),
]

# Standard disease state-stages (the user's Fresh / Dry / Latent vocabulary).
DISEASE_STAGES = ["Fresh", "Dry", "Latent"]

# ---- PESTS -----------------------------------------------------------------
# (name, scientific_name, crops, stages, guideline)
PESTS = [
    # --- Rose ---
    ("Aphids", "Myzus persicae", ["Rose"], ["Singles", "Colonies"],
     "ID: soft pear-shaped insects 1-3 mm in dense colonies on buds and shoot "
     "tips, green/black/yellow, winged and wingless forms, paired cornicles at "
     "the rear. Diagnosis: sap-sucking curls/distorts young growth; sticky "
     "honeydew and black sooty mould; can transmit viruses. Source: UC IPM."),
    ("Helicoverpa", "Helicoverpa armigera", ["Rose"],
     ["Adult Moth", "Larvae", "Eggs", "Damages"],
     "ID: stout caterpillar to 40 mm, colour-variable green/brown with pale "
     "lateral stripes and dark tubercles; adult a stout buff-brown moth. "
     "Diagnosis: bores into buds and flowers leaving frass at entry holes; "
     "damaged blooms and shed buds. Source: CABI Compendium."),
    ("Mealybugs", "Pseudococcidae", ["Rose", "Avocado"],
     ["Singles", "Colonies", "Egg Sacs"],
     "ID: soft oval insects under white mealy wax with lateral filaments, "
     "clustered in leaf axils and under sepals, ant-attended. Diagnosis: "
     "honeydew and sooty mould, stunted growth, cottony egg sacs. Source: "
     "UC IPM."),
    ("Scale Insects", "Coccidae", ["Rose", "Avocado"], ["Scale Insects"],
     "ID: small immobile bumps on stems, leaves and fruit; soft scales (Coccidae) "
     "waxy/dome-shaped, armoured scales (Diaspididae) with a hard detachable "
     "plate. Diagnosis: sap-sucking causes yellowing, leaf drop and twig "
     "dieback; soft scales excrete honeydew feeding sooty mould, armoured "
     "scales crust twigs and fruit. Source: Infonet-biovision (Scales)."),
    ("Spidermites", "Tetranychus urticae", ["Rose"], ["Motiles", "Eggs", "Web"],
     "ID: minute (<0.5 mm) yellow-green to orange mites with two dark spots on "
     "leaf undersides, with fine webbing. Diagnosis: pale stippling/bronzing "
     "then yellowing and leaf drop; webbing in heavy attacks. Source: UC IPM."),
    ("Thrips", "Frankliniella occidentalis", ["Rose"],
     ["Adult", "Larvae", "Damages"],
     "ID: slender pale-yellow to brown insects ~1-2 mm with fringed wings, "
     "hidden in buds and flowers. Diagnosis: silvery scarring and black frass "
     "specks on petals/leaves, deformed/streaked blooms; vectors tospoviruses. "
     "Source: UC IPM."),
    ("Whiteflies", "Bemisia tabaci", ["Rose"],
     ["Adult Singles", "Adult Cloud", "Scales", "Eggs"],
     "ID: tiny white moth-like insects ~1-2 mm on leaf undersides that fly up "
     "when disturbed; flat translucent scale-like nymphs. Diagnosis: sap-sucking "
     "yellows leaves, honeydew and sooty mould; transmits viruses. Source: "
     "UC IPM."),
    ("Duponchella", "Duponchelia fovealis", ["Rose"],
     ["Adult Moth", "Larvae", "Eggs", "Damage"],
     "ID: adult small (19-21 mm wingspan), grey-brown forewings with two "
     "yellowish-white transverse lines, the outer bent into a finger-like point; "
     "larva 20-30 mm, cream-brown with a shiny dark head and rows of brown-grey "
     "spots. Diagnosis: larvae feed hidden at the crown/soil line, roots, lower "
     "stems and flowers, spinning silk webbing with frass at the base; girdled "
     "stems wilt and collapse. Source: UF/IFAS Featured Creatures; FDACS."),
    ("FCM", "Thaumatotibia leucotreta", ["Rose", "Avocado"],
     ["Adult Moth", "Larvae", "Eggs", "Pupae", "Damage"],
     "ID: inconspicuous grey-brown moth (15-20 mm wingspan) with dark crescent "
     "marks and a white scale patch on the forewing; males have a pale "
     "keyhole pocket on the hindwing; larva to 15 mm, pink-orange with a "
     "yellow-brown head. Diagnosis: larvae bore into buds, stems and fruit "
     "leaving small frass-plugged entry holes; infested buds/fruit dry and "
     "drop. Source: CABI Compendium; Defra FCM factsheet."),
    ("Spodoptera", "Spodoptera littoralis", ["Rose"],
     ["Adult Moth", "Larvae", "Eggs", "Damage"],
     "ID: grey-brown noctuid moth (~30-38 mm wingspan) with pale oblique "
     "forewing markings; larva to 45 mm, grey to blackish with dark triangular "
     "dorsal patches prominent on segments 1 and 8. Diagnosis: nocturnal larvae "
     "window/skeletonize leaves then chew large holes to the veins, and bore "
     "buds/flowers; gregarious young larvae and dark frass. Source: EPPO "
     "datasheet (SPODLI); CABI."),
    ("Unidentified Moth", None, ["Rose"],
     ["Adult Moth", "Larvae", "Eggs", "Damage"],
     "ID: catch-all for moths/caterpillars not matching a listed species; "
     "photograph the adult wing pattern and the larva, and record the host "
     "part. Diagnosis: note boring vs leaf-chewing damage to aid later "
     "identification. Source: n/a."),
    ("Weevils", "Curculionidae", ["Rose"], ["Weevils", "Ragged Margins"],
     "ID: hard-bodied snout beetles ~3-10 mm, dull black/brown/grey, with "
     "elbowed club-tipped antennae on an elongated snout; larva a legless "
     "C-shaped white grub with a brown head. Diagnosis: adults chew ragged "
     "notches from leaf margins; larvae feed hidden on roots (the damaging "
     "stage) causing wilting and poor vigour. Source: UC IPM."),

    # --- Avocado ---
    ("Caterpillars", "Lepidoptera", ["Avocado"], ["Adult", "Larvae", "Damages"],
     "ID: soft cylindrical moth/butterfly larvae with three pairs of true legs "
     "plus prolegs, colour and size variable, with chewing mouthparts. "
     "Diagnosis: irregular holes and notches in leaves with frass pellets; "
     "identify to species from the adult moth where possible. Source: general "
     "IPM."),
    ("Coconut Bug", "Pseudotheraptus wayi", ["Avocado"], ["Adult", "Damages"],
     "ID: adult reddish-brown, slender, ~1.5 cm with long thick antennae; "
     "nymphs light brown, long-legged; eggs scattered singly on fruit, twigs "
     "and flowers. Diagnosis: nymphs and adults suck sap and inject toxins into "
     "young fruit/shoots - look for dark brown-black sunken hail-mark lesions "
     "(~8 mm) and grey-brown indentations; young fruit drops. Source: "
     "Infonet-biovision; CABI 45033."),
    ("Fruit fly (Bactocera)", "Bactrocera dorsalis", ["Avocado"],
     ["Adult", "Damages"],
     "ID: adult ~8 mm, black scutum with two yellow lateral stripes, yellow "
     "scutellum and a dark T-shaped abdominal mark; wings clear with a narrow "
     "costal band; larva a white maggot in the fruit. Diagnosis: oviposition "
     "punctures in ripening fruit; flesh softens, discolours and rots around "
     "tunnels with premature fruit fall. Source: CABI/EPPO (Bactrocera "
     "dorsalis)."),
    ("Fruit fly (Ceratitis)", "Ceratitis capitata", ["Avocado", "Coffee"],
     ["Adult", "Damages"],
     "ID: adult 4-7 mm, brightly patterned brown-yellow, blackish thorax with "
     "silver marks, tan-banded abdomen, wings banded/spotted yellow-brown; "
     "larva a whitish maggot in the flesh. Diagnosis: egg-laying punctures with "
     "necrosis; maggot galleries soften flesh, fruit colours prematurely and "
     "shows small exit holes. Source: Infonet-biovision (Fruit flies)."),
    ("Leaf Rollers", "Cacoecimorpha pronubana", ["Avocado"], ["Adult", "Damages"],
     "ID: caterpillar olive to bright yellow-green with a dark head; adult "
     "forewings yellow-to-purple over bright orange hindwings. Diagnosis: larvae "
     "bind leaves, tips or flowers with silk into rolled shelters and feed "
     "hidden inside - look for rolled leaves, egg masses on upper leaf surfaces "
     "and chewed buds. Source: EPPO/CABI (Cacoecimorpha pronubana)."),
    ("Loopers", "Chrysodeixis chalcites", ["Avocado"],
     ["Adult", "Damages", "Eggs"],
     "ID: caterpillar yellowish-green with a green head, a yellow lateral stripe "
     "each side and a black dot per segment, moving with a looping gait; adult "
     "gold-brown with two droplet-shaped white forewing marks. Diagnosis: young "
     "larvae graze the lower epidermis leaving translucent windows; older larvae "
     "chew through leaves (skeletonizing) and bore fruit; look for looping "
     "caterpillars and green frass. Source: CABI (Chrysodeixis chalcites)."),
    ("Mosquito Bugs", "Helopeltis", ["Avocado"], ["Adult", "Nymph", "Damages"],
     "ID: slender mosquito-like bug 6-10 mm with long legs and antennae; adult "
     "black with a red/orange thorax and black-and-white abdomen; nymphs "
     "yellowish, wingless. Diagnosis: both stages inject toxic saliva into young "
     "leaves, shoots and buds leaving sunken dark-brown to black necrotic spots; "
     "heavy feeding blackens and withers shoot tips. Source: Infonet-biovision "
     "(Helopeltis)."),
    ("Stinkbug", "Nezara viridula", ["Avocado"], ["Adult", "Damages"],
     "ID: adult shield-shaped, apple-green, ~15 mm; early nymphs black and "
     "clustered, older nymphs green with pale spots; barrel-shaped eggs in "
     "hexagonal clusters on leaf undersides. Diagnosis: feeds on shoots and "
     "developing fruit leaving hard brownish-black spots; shoots wither and "
     "young fruit deforms and drops; foul odour when disturbed. Source: "
     "Infonet-biovision; CABI 36282."),
    ("Unidentified Insects", None, ["Avocado"], ["Adult", "Damages"],
     "ID: catch-all for insects not matching a listed category - record numbers "
     "and plant part and take a clear dorsal + close-up photo for later "
     "identification. Diagnosis: note the damage type (chewing/sucking/mining) "
     "to aid ID. Source: n/a."),

    # --- Coffee ---
    ("Antestia Bug", "Antestiopsis thunbergii", ["Coffee"],
     ["Adult", "Nymph", "Damages"],
     "ID: shield bug 6-8 mm, brown-black with white/orange markings and an "
     "X-pattern on the back. Diagnosis: feeds on buds, green berries and growing "
     "tips causing bud blackening/abortion, 'zebra' beans and rot; linked to "
     "fan-heads and cup taint."),
    ("Capsid Bug", "Lygus coffeae", ["Coffee"], ["Adult", "Nymph", "Damages"],
     "ID: active green-brown soft bug ~5 mm, nymphs pale. Diagnosis: sucking on "
     "young shoots and berries produces sunken corky spots, scarred/deformed "
     "berries and shoot dieback."),
    ("Lace Bug", "Habrochila placida", ["Coffee"], ["Adult", "Nymph", "Damages"],
     "ID: tiny ~3 mm flattened bug with lace-like clear wing covers; spiny "
     "nymphs on leaf undersides. Diagnosis: underside feeding causes chlorotic "
     "stippling/silvering, brown frass specks and premature leaf fall."),
    ("Leaf Skeletonizer", "Leucoplema dohertyii", ["Coffee"],
     ["Adult Moth", "Larvae", "Damage"],
     "ID: gregarious caterpillars on leaf undersides; grey-brown moth. "
     "Diagnosis: larvae feed between veins, skeletonizing leaves (lace/window "
     "damage) with patchy defoliation."),
    ("Leaf Miner", "Leucoptera caffeina", ["Coffee"],
     ["Adult Moth", "Larvae", "Damage"],
     "ID: minute white moth; larva mines inside the leaf. Diagnosis: irregular "
     "brown blister mines/blotches on the upper leaf surface; heavy mining "
     "causes leaf drop and reduced photosynthesis."),
    ("Tailed Caterpillar", "Epicampoptera andersoni", ["Coffee"],
     ["Adult Moth", "Larvae", "Damage"],
     "ID: green/brown looper-like caterpillar with a raised forked 'tail'. "
     "Diagnosis: chews leaf margins and defoliates young flush."),
    ("Systates Weevil", "Systates", ["Coffee"], ["Weevils", "Ragged Margins"],
     "ID: dull grey-black flightless weevil 8-12 mm, nocturnal. Diagnosis: "
     "adults notch/scallop leaf margins at night; larvae feed on roots; ragged "
     "young foliage."),
    ("Kenya Mealybug", "Planococcus kenyae", ["Coffee"],
     ["Singles", "Colonies", "Egg Sacs"],
     "ID: pink oval body under white mealy wax with lateral filaments; "
     "ant-attended clusters. Diagnosis: on clusters, nodes and roots; honeydew "
     "plus sooty mould, berry drop and dieback (historically a major Kenya "
     "coffee pest)."),
    ("Brown Scale", "Saissetia coffeae", ["Coffee"], ["Scale Insects"],
     "ID: smooth hemispherical brown 'helmet' scale 2-4 mm on stems and "
     "midribs. Diagnosis: sap feeding plus heavy honeydew leads to black sooty "
     "mould and loss of vigour."),
    ("Yellow Termites", "Macrotermes", ["Coffee"], ["Damages"],
     "ID: pale/yellowish soft workers in soil galleries and mud sheeting on "
     "stems. Diagnosis: girdle young trees at the collar, tunnel roots and "
     "stems, causing wilting, lodging and death of young coffee."),
    ("Green Scale", "Coccus alienus", ["Coffee"], ["Scale Insects"],
     "ID: flat oval pale-green translucent scale on leaves and green shoots, "
     "often ant-attended. Diagnosis: sap feeding plus copious honeydew causes "
     "sooty mould and reduced berry set."),
    ("Coffee Thrips", "Diarthrothrips coffeae", ["Coffee"],
     ["Adult", "Larvae", "Damages"],
     "ID: minute ~1 mm slender pale-yellow thrips on leaf undersides. "
     "Diagnosis: silvery-brown scarring/scurfing of leaves and berries, leaf "
     "curl and bronzing in dry spells."),
    ("Berry Moth", "Prophantis smaragdina", ["Coffee"],
     ["Adult Moth", "Larvae", "Eggs", "Damage"],
     "ID: small moth; pinkish caterpillar webs berries together. Diagnosis: "
     "larva bores into clustered green/ripening berries, leaving webbing and "
     "frass, with rot and berry drop."),
    ("Berry Borer", "Hypothenemus hampei", ["Coffee"], ["Adult", "Damages"],
     "ID: tiny ~1.5 mm black beetle boring a neat hole at the berry tip "
     "(navel). Diagnosis: larvae tunnel and consume the beans; the key global "
     "coffee yield and quality pest."),
    ("Sting Caterpillar", "Parasa vivida", ["Coffee"],
     ["Adult Moth", "Larvae", "Damage"],
     "ID: stout green slug-caterpillar with rows of urticating (stinging) "
     "spines/tubercles. Diagnosis: chews and skeletonizes leaves; spines cause "
     "painful stings to pickers."),
]

# ---- DISEASES --------------------------------------------------------------
# (name, scientific_name, crops, stages, guideline). guideline "" = leave the
# existing value untouched (record already documented).
DISEASES = [
    # --- Rose (mostly already complete; blanks are no-ops) ---
    ("Agrobacterium", "Agrobacterium tumefaciens", ["Rose"], DISEASE_STAGES, ""),
    ("Botrytis", "Botrytis cinerea", ["Rose"], DISEASE_STAGES, ""),
    ("Downy Mildew", "Peronospora sparsa", ["Rose"], DISEASE_STAGES, ""),
    ("Powdery Mildew", "Podosphaera pannosa", ["Rose"], DISEASE_STAGES, ""),
    ("Rust", "Phragmidium tuberculatum", ["Rose"], DISEASE_STAGES,
     "ID: bright orange/yellow powdery pustules on the LOWER leaf surface with "
     "matching yellow flecks above; late-season pustules turn black. Diagnosis: "
     "rub the underside - orange spore dust confirms rust; favoured by cool, "
     "moist greenhouse conditions; distinguish from black spot (dark upper "
     "blotches, no orange dust). Source: CABI (Phragmidium); SDSU Extension."),
    ("Bacterial Wilt", "Agrobacterium tumefaciens", ["Rose"], DISEASE_STAGES,
     "ID: rough, wart-like tumour galls at the crown/soil line, graft union or "
     "lower stems and roots, softening and hardening with age; galled plants are "
     "stunted and weak. Diagnosis: look for gall swellings at wounds/graft "
     "points (crown gall) rather than true vascular wilt; soil-borne, enters "
     "through wounds. Source: UMass Greenhouse & Floriculture; UMN Extension. "
     "Note: there is no recognised true bacterial wilt of rose - this label "
     "most likely means crown gall; verify against field symptoms."),

    # --- Coffee ---
    ("Coffee Berry Disease", "Colletotrichum kahawae", ["Coffee"], DISEASE_STAGES,
     "ID: dark, sunken, circular anthracnose lesions on green berries, often "
     "with pinkish spore masses. Diagnosis: infects expanding green berries "
     "causing active dark sunken lesions, premature drop and mummified berries; "
     "severe loss in cool, wet highlands."),
    ("Coffee Leaf Rust", "Hemileia vastatrix", ["Coffee"], DISEASE_STAGES,
     "ID: yellow-orange powdery uredospore pustules on the leaf UNDERSIDE, "
     "matching yellow blotches on the upper surface. Diagnosis: progressive "
     "chlorosis and heavy premature defoliation, dieback and next-season yield "
     "loss."),
    ("Coffee Wilt (Fusarium)", "Fusarium xylarioides", ["Coffee"], DISEASE_STAGES,
     "ID: vascular tracheomycosis; brown-black staining under the bark, often "
     "with blue-black stem streaks. Diagnosis: progressive wilting, leaf "
     "yellowing/curling, defoliation and tree death; bark cracking near the "
     "collar."),
    ("Brown Eye Spot", "Cercospora coffeicola", ["Coffee"], DISEASE_STAGES,
     "ID: circular brown leaf spots with a pale grey/white centre and yellow "
     "halo ('bird's eye'); sunken dark spots on berries. Diagnosis: on nursery "
     "seedlings and stressed/unshaded trees, causing defoliation; berry lesions "
     "cause uneven ripening."),
    ("Bacterial Blight of Coffee", "Pseudomonas syringae pv. garcae", ["Coffee"],
     DISEASE_STAGES,
     "ID: water-soaked dark-green to black lesions on leaves, tips and young "
     "shoots, often with a chlorotic halo; blackened shoot tips ('candle'). "
     "Diagnosis: shoot dieback and defoliation in cool, wet, windy highland "
     "conditions."),

    # --- Avocado (new) ---
    ("Anthracnose", "Colletotrichum gloeosporioides", ["Avocado"], DISEASE_STAGES,
     "ID: circular black sunken spots on fruit (to ~1 cm) that may crack, "
     "exuding pinkish-salmon spore masses in moist conditions; damage mostly "
     "develops post-harvest as fruit ripens. Diagnosis: hemibiotroph - infects "
     "immature fruit but stays latent until ripening then rapid black rot; "
     "pinkish spore ooze in wet weather is the key sign. Source: CABI "
     "PlantwisePlus; CTAHR."),
    ("Cercospora Spot", "Pseudocercospora purpurea", ["Avocado"], DISEASE_STAGES,
     "ID: small (2-5 mm) angular brown to purplish spots first on the lower leaf "
     "surface, often with a yellow halo; on fruit small irregular brown spots "
     "with cracks. Diagnosis: under high humidity lesion centres show grey felty "
     "sporulation; fruit cracks admit secondary anthracnose. Source: "
     "Infonet-biovision; Florida EDIS PP-233."),
    ("Phytophthora Root Rot", "Phytophthora cinnamomi", ["Avocado"], DISEASE_STAGES,
     "ID: canopy thins with small pale/yellow-green leaves, wilting and "
     "premature leaf fall, branch dieback; feeder roots blackened, brittle and "
     "decayed. Diagnosis: dig feeder roots - blackened rotted rootlets in "
     "wet/poorly-drained soil confirm it; decline starts below ground, not "
     "foliar. Source: Infonet-biovision; UC IPM."),
    ("Avocado Scab", "Elsinoe perseae", ["Avocado"], DISEASE_STAGES,
     "ID: on fruit, oval raised corky brown-to-purplish scab lesions that "
     "coalesce and become sunken/cracked; on leaves/twigs small (<3 mm) dark "
     "raised spots, often elongated along veins, distorting young leaves. "
     "Diagnosis: raised corky texture and susceptibility right after fruit set "
     "distinguish it; check young tissue as old lesions mimic wind scarring. "
     "Source: CABI PlantwisePlus; APS (Elsinoe perseae)."),
]


def _ensure_stage_catalog(dry_run, log):
    for stage_name, icon_key, reading_type in REQUIRED_STAGES:
        if frappe.db.exists("Stage", stage_name):
            continue
        log["stages_created"].append(stage_name)
        if dry_run:
            continue
        doc = frappe.new_doc("Stage")
        doc.stage_name = stage_name
        doc.icon_key = icon_key
        doc.default_reading_type = reading_type
        doc.insert(ignore_permissions=True)


def _ensure_master(doctype, name, scientific_name, guideline, dry_run, log):
    """Create if missing; otherwise fill only the blank fields."""
    if not frappe.db.exists(doctype, name):
        log["masters_created"].append(f"{doctype}: {name}")
        if not dry_run:
            doc = frappe.new_doc(doctype)
            doc.common_name = name
            if scientific_name:
                doc.scientific_name = scientific_name
            if guideline:
                doc.identification_guideline = guideline
            doc.insert(ignore_permissions=True)
        return

    current = frappe.db.get_value(
        doctype, name, ["scientific_name", "identification_guideline"], as_dict=True
    )
    updates = {}
    if scientific_name and not (current.scientific_name or "").strip():
        updates["scientific_name"] = scientific_name
    if guideline and not (current.identification_guideline or "").strip():
        updates["identification_guideline"] = guideline
    if updates:
        log["masters_filled"].append(f"{doctype}: {name} <- {', '.join(updates)}")
        if not dry_run:
            for field, value in updates.items():
                frappe.db.set_value(doctype, name, field, value)


def _ensure_filter(filter_doctype, link_field, species, crop, dry_run, log):
    """Create the crop mapping if missing. Returns the filter doc name (or None
    in dry-run when it would be created)."""
    existing = frappe.db.get_value(
        filter_doctype, {"crop_scouted": crop, link_field: species}, "name"
    )
    if existing:
        return existing
    log["mapped"].append(f"{filter_doctype}: {species} -> {crop}")
    if dry_run:
        return None
    doc = frappe.new_doc(filter_doctype)
    doc.crop_scouted = crop
    doc.set(link_field, species)
    doc.insert(ignore_permissions=True)
    return doc.name


def _ensure_stages(filter_doctype, filter_name, stage_names, species, crop, dry_run, log):
    """Add stage child rows only when the filter has none (fill-blanks)."""
    if not filter_name:  # dry-run, filter not yet created
        log["staged"].append(f"{crop}/{species}: {', '.join(stage_names)}")
        return
    doc = frappe.get_doc(filter_doctype, filter_name)
    if doc.stages:
        return
    log["staged"].append(f"{crop}/{species}: {', '.join(stage_names)}")
    if dry_run:
        return
    for stage_name in stage_names:
        reading_type = frappe.db.get_value("Stage", stage_name, "default_reading_type") or "Count"
        doc.append("stages", {"stage": stage_name, "reading_type": reading_type})
    doc.save(ignore_permissions=True)


def run(dry_run=False):
    dry_run = frappe.parse_json(dry_run) if isinstance(dry_run, str) else bool(dry_run)

    log = {
        "stages_created": [], "masters_created": [], "masters_filled": [],
        "mapped": [], "staged": [], "colors": None,
    }

    _ensure_stage_catalog(dry_run, log)

    for name, sci, crops, stages, guideline in PESTS:
        _ensure_master("Pest", name, sci, guideline, dry_run, log)
        for crop in crops:
            fname = _ensure_filter("Pest Filter", "pest", name, crop, dry_run, log)
            _ensure_stages("Pest Filter", fname, stages, name, crop, dry_run, log)

    for name, sci, crops, stages, guideline in DISEASES:
        _ensure_master("Plant Disease", name, sci, guideline, dry_run, log)
        for crop in crops:
            fname = _ensure_filter("Disease Filter", "disease", name, crop, dry_run, log)
            _ensure_stages("Disease Filter", fname, stages, name, crop, dry_run, log)

    if not dry_run:
        frappe.db.commit()
        # Fill legend colours from the (extended) canonical map.
        log["colors"] = seed_canonical_colors()

    _print_summary(log, dry_run)
    return {k: (len(v) if isinstance(v, list) else v) for k, v in log.items()} | {"dry_run": dry_run}


def _print_summary(log, dry_run):
    mode = "DRY RUN (no writes)" if dry_run else "LIVE"
    print(f"\n=== seed_pests_diseases [{mode}] ===")
    print(f"Stage catalog added: {len(log['stages_created'])}")
    print(f"Masters created:     {len(log['masters_created'])}")
    print(f"Masters filled:      {len(log['masters_filled'])}")
    print(f"Crop mappings:       {len(log['mapped'])}")
    print(f"Stage sets seeded:   {len(log['staged'])}")
    if log["colors"] is not None:
        print(f"Colours seeded:      pests={len(log['colors']['pests'])} "
              f"diseases={len(log['colors']['diseases'])}")

    def _block(title, items):
        if items:
            print(f"\n{title}:")
            for it in items:
                print(f"  - {it}")

    _block("Stage catalog added", log["stages_created"])
    _block("Masters created", log["masters_created"])
    _block("Masters filled (blank fields)", log["masters_filled"])
    _block("Crop mappings created", log["mapped"])
    _block("Stage sets seeded", log["staged"])
