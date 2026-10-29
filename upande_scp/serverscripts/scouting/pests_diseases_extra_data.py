"""Extra scouting taxonomy for the Mutara crops (Avocado, Potato, Onion, Cabbage,
Passion Fruit), merged into `seed_pests_diseases` at run time.

Pure data - no frappe import - so `tests/test_pests_diseases_data.py` can check it.

Sources (ID guidelines condensed from): Infonet-Biovision (pest / disease fact
sheets), CABI Compendium / PlantwisePlus, KALRO (passion fruit disease brochure,
potato / onion extension), EPPO datasheets, UC IPM, icipe (potato cyst nematode in
East Africa). Scientific names follow the GBIF backbone. Avocado is exported from
kaitet.local (unit / measure per filter, plant sections, the Mealybugs severity
scale); the rest of Avocado is already in `seed_pests_diseases`.
"""

# Existing records in seed_pests_diseases that gain extra crop filters (one Pest /
# Plant Disease record, several filter rows - never a duplicate record).
EXTRA_PEST_CROPS = {
    "Aphids": ["Potato", "Cabbage", "Passion Fruit", "Onion"],
    "Whiteflies": ["Potato", "Cabbage", "Passion Fruit"],
    "Thrips": ["Onion", "Cabbage", "Passion Fruit", "Potato", "Corn"],
    # Caterpillars are scouted on every crop (a generic catch-all by life stage).
    "Caterpillars": ["Potato", "Onion", "Cabbage", "Passion Fruit", "Corn"],
    "Spidermites": ["Potato", "Onion", "Passion Fruit"],
    "Spodoptera": ["Onion", "Potato"],
    "Mealybugs": ["Passion Fruit"],
    "Scale Insects": ["Passion Fruit"],
    "Fruit fly (Bactocera)": ["Passion Fruit"],
    "Fruit fly (Ceratitis)": ["Passion Fruit"],
}
EXTRA_DISEASE_CROPS = {
    "Anthracnose": ["Passion Fruit"],
    "Phytophthora Root Rot": ["Passion Fruit"],
}

# Appended to the master's guideline when it is first created (fill-blank).
EXTRA_PEST_NOTES = {
    "Aphids": " Other hosts: potato (Myzus persicae, Macrosiphum euphorbiae - "
              "virus vectors), cabbage (grey-waxy Brevicoryne brassicae colonies "
              "in the heart and on leaf undersides), passion fruit and onion "
              "(Aphis gossypii; passion fruit woodiness vector). Source: "
              "Infonet-Biovision; CABI.",
    "Whiteflies": " Other hosts: potato, cabbage (Aleyrodes proletella, waxy "
                  "white scales on outer leaves), passion fruit. Source: CABI.",
    "Thrips": " Onion: Thrips tabaci (pale yellow, 1 mm) in the leaf axils / neck "
              "- silvery streaks on leaves. Cabbage and passion fruit: silvery "
              "scarring on leaves, buds and fruit. Source: Infonet-Biovision.",
    "Spidermites": " Potato, onion and passion fruit: stippled bronze leaves, "
                   "fine web under the leaf in hot dry spells. Source: UC IPM.",
    "Spodoptera": " Onion / potato: beet armyworm (Spodoptera exigua) and "
                  "S. littoralis larvae chew leaf blades and bore into onion "
                  "tubes. Source: Infonet-Biovision.",
}

# (name, scientific_name, crops, stages, guideline)
PEST_STAGES_MOTH = ["Adult Moth", "Larvae", "Eggs", "Damage"]
PEST_STAGES_SUCKER = ["Adult", "Nymph", "Damages"]

NEW_PESTS = [
    # --- Potato ---
    ("Potato Tuber Moth", "Phthorimaea operculella", ["Potato"],
     ["Adult Moth", "Larvae", "Eggs", "Pupae", "Damage"],
     "ID: small grey-brown moth (~10 mm) with narrow fringed wings; larva "
     "pinkish-white to greenish, up to 12 mm, dark head. Diagnosis: larvae mine "
     "leaves (blotch mines) and bore into tubers in the field and store, "
     "leaving frass-filled tunnels under the eye and skin; tubers exposed by "
     "cracked soil or poor ridging are worst hit. Source: Infonet-Biovision; "
     "CABI Compendium."),
    ("Potato Cyst Nematode", "Globodera rostochiensis", ["Potato"], ["Damages"],
     "ID: microscopic; on roots look for pinhead-size white / yellow-gold (later "
     "brown) round cysts at flowering. Diagnosis: patches of stunted, yellowing, "
     "wilting plants with poor root systems and small tubers; confirmed by "
     "cysts on roots or in soil. Quarantine pest - report to KEPHIS. Source: "
     "icipe; CABI Compendium; EPPO (Globodera spp.)."),
    ("Leafminers", "Liriomyza huidobrensis", ["Potato", "Onion", "Cabbage",
                                              "Passion Fruit"],
     ["Adult", "Larvae", "Damages"],
     "ID: tiny (2 mm) black-and-yellow flies; yellow-white legless maggots "
     "inside the leaf. Diagnosis: winding silvery-white mines and white "
     "puncture dots on the upper leaf surface; heavy mining dries and drops "
     "leaves and opens the crop to disease. Source: Infonet-Biovision; CABI."),
    ("Cutworms", "Agrotis segetum", ["Potato", "Onion", "Cabbage"],
     ["Adult Moth", "Larvae", "Damage"],
     "ID: fat greasy grey-brown caterpillars (up to 45 mm) that curl into a C "
     "when disturbed, hiding in the top soil by day. Diagnosis: seedlings cut "
     "at or just below soil level, wilted plants, tubers and bulbs with "
     "irregular holes; dig around the base of cut plants. Source: "
     "Infonet-Biovision; CABI Compendium."),
    # --- Onion ---
    ("Onion Fly", "Delia antiqua", ["Onion"], ["Adult", "Larvae", "Damages"],
     "ID: grey fly ~7 mm resembling a small house fly; white legless maggots "
     "up to 10 mm in the bulb base. Diagnosis: seedlings yellow, wilt and "
     "collapse; bulbs hollowed, soft and foul smelling at the base. Source: "
     "CABI Compendium; UC IPM (onion maggots)."),
    # --- Cabbage ---
    ("Diamondback Moth", "Plutella xylostella", ["Cabbage"],
     ["Adult Moth", "Larvae", "Eggs", "Pupae", "Damage"],
     "ID: slender grey-brown moth with pale diamond marks on the folded wings; "
     "larva pale green, 8-12 mm, wriggles backwards when touched; loose net-like "
     "cocoon on the leaf. Diagnosis: young larvae mine leaves, older ones chew "
     "windows and holes in the leaf underside, leaving the upper cuticle intact; "
     "heart and head contaminated; builds insecticide resistance fast. Scout at "
     "least twice weekly. Source: Infonet-Biovision; CABI Compendium."),
    ("Cabbage Webworm", "Hellula undalis", ["Cabbage"],
     ["Adult Moth", "Larvae", "Damage"],
     "ID: small buff-brown moth with a wavy zigzag on the forewing; larva "
     "whitish-grey with five purple-brown longitudinal stripes. Diagnosis: "
     "larvae spin silk webs mixed with frass and tunnel into the growing point "
     "of seedlings and young heads, causing blind or multiple-headed plants. "
     "Source: Infonet-Biovision; CABI Compendium."),
    ("Cabbage Looper", "Trichoplusia ni", ["Cabbage"],
     ["Adult Moth", "Larvae", "Eggs", "Damage"],
     "ID: pale green caterpillar to 30 mm with thin white side stripes that "
     "arches (loops) as it walks; adult brown moth with a silver figure-of-eight "
     "mark on each forewing. Diagnosis: large ragged holes in outer leaves, "
     "green frass pellets, bored heads. Source: UC IPM; CABI Compendium."),
    # --- Corn (maize) ---
    ("Fall Armyworm", "Spodoptera frugiperda", ["Corn"],
     ["Adult Moth", "Larvae", "Eggs", "Damage"],
     "ID: larva pale green to dark brown with a pale inverted Y on the head and "
     "four black dots in a square on the second-last segment, up to 40 mm; eggs "
     "in a felt-like mass of 100-200 under grey scales on the leaf; adult grey-"
     "brown moth (~35 mm wingspan). Diagnosis: young larvae scrape windows in "
     "leaves, older ones chew ragged holes in the whorl leaving sawdust-like "
     "frass, and bore into the cob; lines of holes show on unfolded leaves. "
     "Scout the whorl of 20 plants per block weekly from emergence. Source: "
     "Infonet-Biovision; CABI Compendium; FAO FAW guidance."),
    # --- Passion fruit ---
    ("Broad Mites", "Polyphagotarsonemus latus", ["Passion Fruit"],
     ["Motiles", "Eggs", "Damage"],
     "ID: microscopic (0.2 mm) translucent yellow-amber mites needing a 20x lens, "
     "on growing tips and young fruit. Diagnosis: shoot tips and young leaves "
     "curl, harden and turn bronze / brittle; fruit skin turns scabby and "
     "russeted with distortion. Source: CABI Compendium; UC IPM."),
    ("Leaf-footed Bug", "Leptoglossus australis", ["Passion Fruit"],
     PEST_STAGES_SUCKER,
     "ID: dark brown bug ~20 mm with a flattened leaf-like expansion on each "
     "hind leg and a pale zigzag band across the back; nymphs red-orange, "
     "gregarious. Diagnosis: pierce shoots, buds and fruit; young fruit shrivel "
     "and drop, older fruit show sunken pale hard spots. Source: Infonet-"
     "Biovision (coreid bugs); CABI."),
]

NEW_DISEASES = [
    # --- Potato ---
    ("Late Blight", "Phytophthora infestans", ["Potato"], None,
     "ID: water-soaked pale-green to dark-brown blotches on leaf edges and tips "
     "that expand fast; a white fluffy mould ring on the leaf UNDERSIDE in "
     "humid mornings; dark sunken lesions on stems; tubers with copper-brown "
     "dry rot under the skin. Diagnosis: cool (10-20 C), wet or misty weather; "
     "whole fields can collapse in a week. Source: Infonet-Biovision; "
     "CABI PlantwisePlus; EPPO."),
    ("Early Blight", "Alternaria solani", ["Potato"], None,
     "ID: dark brown, angular to round leaf spots with concentric 'target' "
     "rings and a yellow halo, starting on the older lower leaves. Diagnosis: "
     "lesions merge, leaves yellow and drop; favoured by plant stress, warm "
     "alternating wet/dry weather; tuber lesions are dark sunken and corky. "
     "Source: Infonet-Biovision; CABI Compendium."),
    ("Bacterial Wilt (Ralstonia)", "Ralstonia solanacearum", ["Potato"], None,
     "ID: sudden wilting of the whole plant while leaves stay green, "
     "recovering at night then dying; cut stem placed in clear water streams "
     "milky-white ooze; tubers show brown vascular ring and ooze from the eyes. "
     "Diagnosis: soil-borne and in seed tubers; do not replant solanaceous "
     "crops in affected soil. Source: Infonet-Biovision; CABI; EPPO. (Separate "
     "from the Rose 'Bacterial Wilt' label, which is crown gall.)"),
    ("Potato Viruses", "Potato virus Y / Potato leafroll virus", ["Potato"], None,
     "ID: leaf mosaic, crinkling and mottling (PVY, PVX); upward-rolled, leathery "
     "pale leaves and stunting (PLRV). Diagnosis: aphid-spread and carried in "
     "seed tubers; about 36% of plants in a Kenyan survey showed virus-like "
     "symptoms; use certified seed and rogue sick plants. Source: Infonet-"
     "Biovision; CABI; Springer 2013 Kenya survey."),
    ("Common Scab", "Streptomyces scabies", ["Potato"], None,
     "ID: rough, corky, raised or pitted brown lesions on the tuber skin only; "
     "foliage looks normal. Diagnosis: worst in dry, alkaline soils and light "
     "soils; cosmetic loss in marketable grade. Source: CABI Compendium; "
     "UC IPM."),
    ("Black Scurf", "Rhizoctonia solani", ["Potato"], None,
     "ID: black hard crusts (sclerotia) that do not wash off tubers; brown "
     "sunken cankers on sprouts and stolons; white mycelial collar on stems. "
     "Diagnosis: poor, uneven emergence, aerial tubers, malformed tubers; cold "
     "wet soils at planting. Source: Infonet-Biovision; CABI."),
    # --- Shared (potato / onion / cabbage) ---
    ("Bacterial Soft Rot", "Pectobacterium carotovorum", ["Potato", "Onion",
                                                            "Cabbage"], None,
     "ID: watery, cream-coloured, foul-smelling slimy rot of tubers, bulbs or "
     "heads; potato blackleg: black slimy stem base with wilting. Diagnosis: "
     "enters through wounds, insect damage and over-wet soil; spreads rapidly in "
     "store. Source: Infonet-Biovision; CABI; UC IPM."),
    # --- Onion ---
    ("Purple Blotch", "Alternaria porri", ["Onion"], None,
     "ID: small sunken whitish flecks that enlarge into purple-brown blotches "
     "with a yellow border and concentric rings, often with dark spore "
     "masses; leaves break at the lesion and fall over. Diagnosis: warm humid "
     "weather with long leaf wetness; thrips damage opens the way. Source: "
     "Infonet-Biovision; CABI; KALRO."),
    ("Onion Downy Mildew", "Peronospora destructor", ["Onion"], None,
     "ID: pale oval patches on the leaves and a violet-grey fuzz of sporulation "
     "in cool humid mornings; leaf tips yellow and collapse. Diagnosis: "
     "systemically infected bulbs produce pale, dwarfed shoots; cool wet "
     "weather and dew. Source: Infonet-Biovision; CABI Compendium."),
    ("Fusarium Basal Rot", "Fusarium oxysporum f. sp. cepae", ["Onion"], None,
     "ID: yellowing and dieback of leaf tips from the tips down; basal plate "
     "pinkish-brown, rotted, with white mycelium; plants pull out easily. "
     "Diagnosis: soil-borne, favoured by warm soils and wounds; bulbs rot in "
     "store. Source: CABI Compendium; Greenlife / KALRO extension."),
    ("Stemphylium Leaf Blight", "Stemphylium vesicarium", ["Onion"], None,
     "ID: small yellow-tan to brown elongated spots on leaves that coalesce "
     "and turn dark olive-brown, leaf tips dying back. Diagnosis: often "
     "follows purple blotch or thrips damage; warm wet weather. Source: "
     "UC IPM; CABI Compendium."),
    # --- Cabbage ---
    ("Black Rot", "Xanthomonas campestris pv. campestris", ["Cabbage"], None,
     "ID: V-shaped yellow wedges from the leaf margin pointing to the midrib, "
     "with blackened veins; stem cut across shows a black vascular ring. "
     "Diagnosis: seed-borne and splashed by rain / sprinklers; heads rot with a "
     "soft secondary decay. Source: Infonet-Biovision; KALRO / Chuka (major "
     "cabbage disease in Kenya)."),
    ("Cabbage Downy Mildew", "Hyaloperonospora brassicae", ["Cabbage"], None,
     "ID: yellow angular patches on the upper leaf surface with white fluffy "
     "growth on the underside; black sunken spots on head leaves; seedlings "
     "damp off in nurseries. Diagnosis: cool humid weather; nursery nets that "
     "trap humidity can worsen it. Source: Infonet-Biovision; KALRO / Chuka."),
    ("Alternaria Leaf Spot", "Alternaria brassicae", ["Cabbage"], None,
     "ID: round tan-to-black spots with concentric rings and a yellow halo, "
     "often with dark sooty spore masses, on older leaves and heads. Diagnosis: "
     "seed-borne; warm wet weather; spots on wrapper leaves lower grade. "
     "Source: UC IPM; CABI Compendium."),
    ("Clubroot", "Plasmodiophora brassicae", ["Cabbage"], None,
     "ID: swollen, club-shaped, distorted roots; above ground wilting in the "
     "heat of the day, stunted bluish-purple plants. Diagnosis: acid, wet soils; "
     "resting spores last up to 15 years - rotate and lime. Source: "
     "Infonet-Biovision; CABI Compendium."),
    # --- Passion fruit ---
    ("Passion Fruit Woodiness", "Passion fruit woodiness virus / Cowpea aphid-borne mosaic virus",
     ["Passion Fruit"], None,
     "ID: mosaic and distortion of young leaves, stunted shoots; fruit small, "
     "deformed, with thick hard woody rind and little pulp. Diagnosis: aphid "
     "and grafting spread, no cure - uproot infected vines and plant clean "
     "nursery stock. Most important passion fruit disease in Kenya. Source: "
     "KALRO passion fruit brochure; Ondieki (ISHS); BMC Plant Biology 2023."),
    ("Brown Spot", "Alternaria passiflorae", ["Passion Fruit"], None,
     "ID: small circular dark-brown spots with a yellow halo on leaves, stems "
     "and fruit; fruit spots become sunken and corky. Diagnosis: severe "
     "defoliation, fruit drop and shrivelling in humid weather; one of the two "
     "most important diseases in Kenya. Source: Ondieki (ISHS); KALRO."),
    ("Fusarium Wilt", "Fusarium oxysporum f. sp. passiflorae", ["Passion Fruit"], None,
     "ID: yellowing and wilting of leaves starting on one side, vines collapse "
     "while still attached; brown staining inside the stem and roots. "
     "Diagnosis: soil-borne in poorly-drained soil; graft onto resistant "
     "Passiflora edulis f. flavicarpa rootstock. Source: KALRO; CABI Compendium."),
    ("Septoria Spot", "Septoria passiflorae", ["Passion Fruit"], None,
     "ID: small round tan spots with a dark border on leaves and fruit, with "
     "tiny black dots (pycnidia) in the centre. Diagnosis: cool wet weather, "
     "mostly high altitude; leaf drop and blemished fruit. Source: KALRO; "
     "CABI Compendium."),
    ("Bacterial Oily Spot", "Xanthomonas axonopodis pv. passiflorae", ["Passion Fruit"], None,
     "ID: oily water-soaked angular spots on leaves that turn brown with a "
     "yellow halo; greasy dark spots on fruit and stems. Diagnosis: spread by "
     "rain splash and wounds in warm wet weather; can progress to leaf drop. "
     "Source: CABI Compendium; KALRO."),
]

# --- Avocado, exported from kaitet.local ------------------------------------
# (kind, name) -> (unit, measure) on the Avocado filter row
AVOCADO_FILTER_SETTINGS = {
    ("Pest", "Unidentified Insects"): ("Per Hectare", "Count"),
    ("Pest", "Mealybugs"): ("Per Warehouse", "Percentage"),
    ("Pest", "Fruit fly (Bactocera)"): ("Per Warehouse", "Count"),
    ("Pest", "Fruit fly (Ceratitis)"): ("Per Hectare", "Count"),
    ("Pest", "Mosquito Bugs"): ("Per Hectare", "Count"),
    ("Pest", "FCM"): ("Per Warehouse", "Count"),
    ("Pest", "Loopers"): ("Per Warehouse", "Count"),
    ("Pest", "Caterpillars"): ("Per Hectare", "Count"),
    ("Pest", "Scale Insects"): ("Per Hectare", "Percentage"),
    ("Pest", "Coconut Bug"): ("Per Warehouse", "Count"),
    ("Pest", "Leaf Rollers"): ("Per Hectare", "Count"),
    ("Pest", "Stinkbug"): ("Per Warehouse", "Count"),
}
# Avocado stage rows kaitet limits to plant sections (Pests Stages.plant_sections)
AVOCADO_PLANT_SECTIONS = {"Mealybugs": "Buds\nTop\nMiddle\nBase\nStem",
                          "FCM": "Buds\nTop\nMiddle\nBase\nStem"}
# Pest severity scale rows (severity, from, to, colour) kaitet holds for Avocado
AVOCADO_SEVERITY = {"Mealybugs": [("Low", 0, 3, "#90EE90"),
                                  ("Moderate", 4, 10, "#FFD700"),
                                  ("High", 11, 30, "#FFA500")]}

# Crops this data set adds filters for; reading_type of Damage / Damages rows is
# Count here (as on kaitet's Avocado filters) rather than the catalog Checkbox.
COUNT_SIGN_CROPS = {"Avocado", "Potato", "Onion", "Cabbage", "Passion Fruit", "Corn"}

# Stage catalog entries to create when missing: name -> (icon_key, reading_type).
# Everything the seeders reference, so a fresh site needs no earlier patch.
STAGE_CATALOG = {
    "Adult": ("circle", "Count"), "Adult Moth": ("circle", "Count"),
    "Adult Cloud": ("circle", "Checkbox"), "Adult Singles": ("circle", "Checkbox"),
    "Colonies": ("square", "Count"), "Damage": ("cross", "Checkbox"),
    "Damages": ("cross", "Checkbox"), "Dry": ("star", "Checkbox"),
    "Egg Sacs": ("diamond", "Checkbox"), "Eggs": ("diamond", "Count"),
    "Fresh": ("chevron", "Checkbox"), "Larvae": ("triangle", "Count"),
    "Latent": ("star", "Checkbox"), "Motiles": ("square", "Count"),
    "Nymph": ("pentagon", "Count"), "Pupae": ("plus", "Count"),
    "Ragged Margins": ("cross", "Checkbox"), "Scale Insects": ("square", "Checkbox"),
    "Scales": ("square", "Count"), "Singles": ("square", "Count"),
    "Web": ("cross", "Checkbox"), "Weevils": ("circle", "Count"),
}

# Legend colours for the new records (merged into observation_colors defaults).
NEW_PEST_COLORS = {
    "Whiteflies": "#6b7280",
    "Potato Tuber Moth": "#8b5cf6", "Potato Cyst Nematode": "#7c2d12",
    "Leafminers": "#0f766e", "Cutworms": "#44403c", "Onion Fly": "#64748b",
    "Diamondback Moth": "#7e22ce", "Cabbage Webworm": "#c026d3",
    "Cabbage Looper": "#059669", "Broad Mites": "#f59e0b",
    "Leaf-footed Bug": "#9f1239", "Fall Armyworm": "#b45309",
}
NEW_DISEASE_COLORS = {
    "Late Blight": "#1f2937", "Early Blight": "#92400e",
    "Bacterial Wilt (Ralstonia)": "#991b1b", "Potato Viruses": "#4338ca",
    "Common Scab": "#a8a29e", "Black Scurf": "#171717",
    "Bacterial Soft Rot": "#b45309", "Purple Blotch": "#86198f",
    "Onion Downy Mildew": "#db2777", "Fusarium Basal Rot": "#be185d",
    "Stemphylium Leaf Blight": "#854d0e", "Black Rot": "#0f172a",
    "Cabbage Downy Mildew": "#f472b6", "Alternaria Leaf Spot": "#78350f",
    "Clubroot": "#57534e", "Passion Fruit Woodiness": "#6d28d9",
    "Brown Spot": "#c2410c", "Fusarium Wilt": "#7f1d1d",
    "Septoria Spot": "#ca8a04", "Bacterial Oily Spot": "#0369a1",
}
