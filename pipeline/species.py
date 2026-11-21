"""Single source of truth for the MVP target species.

Danish name is primary; the scientific name is always shown; when no Danish name
exists the scientific name is shown alone. `synonyms` lets older names in source
data resolve. `lookalike_risk` gates whether a species may appear in "beginner"
suggestions. See docs/adr/0003-species-name-resolution.md.

Every `danish_name` here has been checked against the `vernacularName` carried in
the Svampeatlas Darwin Core archive — the canonical source
(docs/adr/0003-species-name-resolution.md) — and `danish_name_verified` is set.
Re-run `scripts/verify_danish_names.py <archive> --adopt` after adding species:
the archive name wins, so a mismatch means the entry here is wrong.
`danish_name` holds the real Danish spelling, diacritics included; it flows
verbatim through the `species` table and the published payload to the UI.

`tier` (see docs/adr/0012-species-tiers-core-and-extra.md) is one of:

- ``"core"``  -- validated set; the backtest and golden gates are build-blocking.
- ``"extra"`` -- best-effort; published and scored, but a gate failure is only
  advisory and the UI flags the conditions score as not validated.
- ``"hidden"`` -- kept in the registry to document a deliberate exclusion; not
  fitted, not published.

``core_species()`` is the ``core`` tier; ``published_species()`` is ``core`` plus
``extra`` and is what fit, backtest and publish iterate.

On top of the tiers sits the curated scope, ``data/species_scope.json``: a list
of slugs the project owner and the reviewing mycologist have chosen to leave out
of the app. It is edited through the review tool (``scripts/build_photo_review.py``
shows an include/exclude switch per species) and written by
``scripts/apply_review_scope.py``. An excluded species stays in the registry and
is still ingested, so it can be switched back on; it is just not fitted,
backtested or published. ``candidate_species()`` is every ``core``/``extra``
species regardless of scope, which is what the review tool lists.
"""

from __future__ import annotations

import json
from typing import TypedDict

from pipeline.config import DATA_DIR

SCOPE_FILE = DATA_DIR / "species_scope.json"

# Species whose Svampeatlas records at rank "superspecies" (sensu lato, the
# broad species group) count as finds of the species. The ingest otherwise keeps
# species rank only. Svampeatlas files 694 of its 719 Lepista sordida finds as
# "Lepista sordida sensu lato" ("spinkel hekseringshat i bred forstand"), which
# is what a forager means by the name; without them the species is too thin to
# fit. Opt in per species, so no other species' data changes.
SENSU_LATO_SPECIES: frozenset[str] = frozenset({"Lepista sordida"})


class Species(TypedDict):
    danish_name: str
    danish_name_verified: bool
    scientific_name: str
    synonyms: list[str]
    group: str
    edible: bool
    lookalike_risk: str  # "low" | "medium" | "high"
    tier: str  # "core" | "extra" | "hidden"
    gbif_usage_key: int  # GBIF Backbone usageKey, from the gbif_counts spike
    notes: str


TARGET_SPECIES: list[Species] = [
    {
        "danish_name": "Almindelig Kantarel",
        "danish_name_verified": True,
        "scientific_name": "Cantharellus cibarius",
        "synonyms": [],
        "group": "kantarel",
        "edible": True,
        "lookalike_risk": "medium",  # orangekantarel (Hygrophoropsis aurantiaca)
        "tier": "core",
        "gbif_usage_key": 5249504,
        "notes": "Flagship species. Mycorrhizal with beech/oak/spruce; mossy forest floor.",
    },
    {
        "danish_name": "Tragt-Kantarel",
        "danish_name_verified": True,
        "scientific_name": "Craterellus tubaeformis",
        "synonyms": ["Cantharellus tubaeformis"],
        "group": "kantarel",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "core",
        "gbif_usage_key": 2554536,
        "notes": "Late season, often in large troops in conifer litter and on rotten wood.",
    },
    {
        "danish_name": "Spiselig Rørhat",
        "danish_name_verified": True,
        "scientific_name": "Boletus edulis",
        "synonyms": [],
        "group": "rorhat",
        "edible": True,
        "lookalike_risk": "low",  # galderorhat (Tylopilus felleus) is bitter, not toxic
        "tier": "core",
        "gbif_usage_key": 5954958,
        "notes": "'Karl Johan'. Mycorrhizal, broad host range; forest edges and clearings.",
    },
    {
        "danish_name": "Brunstokket Rørhat",
        "danish_name_verified": True,
        "scientific_name": "Imleria badia",
        "synonyms": ["Boletus badius", "Xerocomus badius"],
        "group": "rorhat",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "core",
        "gbif_usage_key": 7832732,
        "notes": "Very common in conifer plantations; pores stain blue slowly when pressed.",
    },
    {
        "danish_name": "Brungul Slimrørhat",
        "danish_name_verified": True,
        "scientific_name": "Suillus luteus",
        "synonyms": [],
        "group": "rorhat",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "core",
        "gbif_usage_key": 7777157,
        "notes": "Under pine; conspicuous ring. Peel the slimy cap cuticle before cooking.",
    },
    {
        "danish_name": "Broget Slimrørhat",
        "danish_name_verified": True,
        "scientific_name": "Suillus variegatus",
        "synonyms": [],
        "group": "rorhat",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "core",
        "gbif_usage_key": 9043861,
        "notes": "Abundant in sandy Jutland pine plantations and on heath edges.",
    },
    {
        "danish_name": "Trompetsvamp",
        "danish_name_verified": True,
        "scientific_name": "Craterellus cornucopioides",
        "synonyms": ["Cantharellus cornucopioides"],
        "group": "kantarel",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "core",
        "gbif_usage_key": 2554662,
        "notes": "Choice edible, strong aroma dried. Dark; no toxic lookalikes.",
    },
    {
        "danish_name": "Grovporet Slimrørhat",
        "danish_name_verified": True,
        "scientific_name": "Suillus bovinus",
        "synonyms": ["Boletus bovinus"],
        "group": "rorhat",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "core",
        "gbif_usage_key": 7623986,
        "notes": "Under pine, often with S. variegatus. Soft, mild; peel the cap.",
    },
    {
        "danish_name": "Kornet Slimrørhat",
        "danish_name_verified": True,
        "scientific_name": "Suillus granulatus",
        "synonyms": ["Boletus granulatus"],
        "group": "rorhat",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "core",
        "gbif_usage_key": 8146046,
        "notes": "Ringless Suillus under pine; young pores weep milky drops.",
    },
    {
        "danish_name": "Brun Skælrørhat",
        "danish_name_verified": True,
        "scientific_name": "Leccinum scabrum",
        "synonyms": ["Boletus scaber"],
        "group": "rorhat",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "core",
        "gbif_usage_key": 9141390,
        "notes": "With birch only. Best young; goes soft with age. Cook through.",
    },
    {
        "danish_name": "Orange Skælrørhat",
        "danish_name_verified": True,
        "scientific_name": "Leccinum versipelle",
        "synonyms": ["Leccinum testaceoscabrum", "Boletus versipellis"],
        "group": "rorhat",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "core",
        "gbif_usage_key": 2524490,
        "notes": "Orange cap, black-scaled stem, with birch. Flesh greys on cut; harmless.",
    },
    {
        "danish_name": "Almindelig Østershat",
        "danish_name_verified": True,
        "scientific_name": "Pleurotus ostreatus",
        "synonyms": ["Agaricus ostreatus"],
        "group": "traesvamp",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "core",  # promoted 2026-09: passed the temporal backtest
        "gbif_usage_key": 2526530,
        "notes": "Cold-weather wood-rotter on dead broadleaf. Fruits by frost, not rain, "
        "so the seasonal signal is thin -- but the backtest still clears.",
    },
    {
        "danish_name": "Almindelig Judasøre",
        "danish_name_verified": True,
        "scientific_name": "Auricularia auricula-judae",
        "synonyms": ["Auricularia auricula", "Hirneola auricula-judae"],
        "group": "traesvamp",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "core",  # promoted 2026-09: passed the temporal backtest
        "gbif_usage_key": 5249271,
        "notes": "Jelly fungus on elder, fruits year-round, so the seasonal signal is "
        "thin -- but the backtest still clears. No toxic lookalikes.",
    },
    {
        "danish_name": "Almindelig Pigsvamp",
        "danish_name_verified": True,
        "scientific_name": "Hydnum repandum",
        "synonyms": ["Dentinum repandum"],
        "group": "pigsvamp",
        "edible": True,
        "lookalike_risk": "low",  # spines not gills -- no toxic lookalike
        "tier": "extra",
        "gbif_usage_key": 2554716,
        "notes": "Buff cap, brittle spines under. Beginner-safe; extra tier until the "
        "autumn model clears the backtest on a real build.",
    },
    # Hydnum rufescens was tried here (extra tier, 2026-09) but only 8 Svampeatlas
    # records survive the ingest filters -- far below MIN_PER_SPECIES -- because the
    # archive lumps most collections under H. repandum. Revisit if that changes.
    {
        "danish_name": "Stor Parykhat",
        "danish_name_verified": True,
        "scientific_name": "Coprinus comatus",
        "synonyms": ["Agaricus comatus"],
        "group": "blaeksvamp",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "extra",
        "gbif_usage_key": 7987658,
        "notes": "Grassland; eat young while gills are still white. Deliquesces within a "
        "day, so fruiting-condition modelling is marginal -- extra tier.",
    },
    {
        "danish_name": "Svovlporesvamp",
        "danish_name_verified": True,
        "scientific_name": "Laetiporus sulphureus",
        "synonyms": ["Polyporus sulphureus"],
        "group": "traesvamp",
        "edible": True,
        "lookalike_risk": "low",  # unmistakable; a minority react, avoid conifer/yew hosts
        "tier": "core",  # promoted 2026-09: passed the temporal backtest
        "gbif_usage_key": 9072021,
        "notes": "Sulphur-orange brackets on living broadleaf. Eat only young margins, "
        "well cooked.",
    },
    {
        "danish_name": "Oksetunge",
        "danish_name_verified": True,
        "scientific_name": "Fistulina hepatica",
        "synonyms": ["Boletus hepaticus"],
        "group": "traesvamp",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "core",  # promoted 2026-09: passed the temporal backtest
        "gbif_usage_key": 2531012,
        "notes": "Tongue-shaped, blood-red, bleeds red juice; on oak and sweet chestnut. "
        "Sour; no toxic lookalike.",
    },
    {
        "danish_name": "Kruset Blomkålssvamp",
        "danish_name_verified": True,
        "scientific_name": "Sparassis crispa",
        "synonyms": ["Sparassis radicata"],
        "group": "traesvamp",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "extra",
        "gbif_usage_key": 2550247,
        "notes": "Cream cauliflower-like clump at the base of pine. Choice; wash grit "
        "from the folds. No toxic lookalike.",
    },
    {
        "danish_name": "Lærke-Slimrørhat",
        "danish_name_verified": True,
        "scientific_name": "Suillus grevillei",
        "synonyms": ["Boletus grevillei"],
        "group": "rorhat",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "core",
        "gbif_usage_key": 5239864,
        "notes": "Golden-brown slimy cap, ring on the stem; only under larch. Peel the cap.",
    },
    {
        "danish_name": "Mose-Slimrørhat",
        "danish_name_verified": True,
        "scientific_name": "Suillus flavidus",
        "synonyms": ["Boletus flavidus"],
        "group": "rorhat",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "extra",
        "gbif_usage_key": 5239900,
        "notes": "Slender, yellow, slimy; in wet Sphagnum under pine. Peel; soft texture.",
    },
    {
        "danish_name": "Olivengrå Slimrørhat",
        "danish_name_verified": True,
        "scientific_name": "Suillus viscidus",
        "synonyms": ["Boletus viscidus", "Suillus aeruginascens", "Boletus laricinus"],
        "group": "rorhat",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "core",
        "gbif_usage_key": 5239873,
        "notes": "Grey-buff slimy cap under larch; flesh may stain faint blue-green. Peel.",
    },
    {
        "danish_name": "Rødsprukken Rørhat",
        "danish_name_verified": True,
        "scientific_name": "Xerocomellus chrysenteron",
        "synonyms": ["Boletus chrysenteron", "Xerocomus chrysenteron"],
        "group": "rorhat",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "core",
        "gbif_usage_key": 2519413,
        "notes": "Cracked cap with red in the fissures; pores blue slowly. Soft, mild, common.",
    },
    {
        "danish_name": "Dugget Rørhat",
        "danish_name_verified": True,
        "scientific_name": "Xerocomellus pruinatus",
        "synonyms": ["Boletus pruinatus", "Xerocomus pruinatus"],
        "group": "rorhat",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "extra",
        "gbif_usage_key": 2519584,
        "notes": "Like the cracked-cap bolete but cap dark, waxy-bloomed, less cracked.",
    },
    {
        "danish_name": "Finsprukken Rørhat",
        "danish_name_verified": True,
        "scientific_name": "Xerocomellus cisalpinus",
        "synonyms": ["Xerocomus cisalpinus", "Boletus cisalpinus"],
        "group": "rorhat",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "extra",
        "gbif_usage_key": 7529390,
        "notes": "Cracked-cap bolete with strong blueing in cap flesh and a beetroot stem base.",
    },
    {
        "danish_name": "Filtet Rørhat",
        "danish_name_verified": True,
        "scientific_name": "Xerocomus subtomentosus",
        "synonyms": ["Boletus subtomentosus"],
        "group": "rorhat",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "extra",
        "gbif_usage_key": 2519457,
        "notes": "Dry olive-brown velvety cap, wide yellow pores; little or no blueing. Mild.",
    },
    {
        "danish_name": "Vaskeskinds-Rørhat",
        "danish_name_verified": True,
        "scientific_name": "Xerocomus ferrugineus",
        "synonyms": ["Boletus ferrugineus", "Xerocomus spadiceus"],
        "group": "rorhat",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "core",
        "gbif_usage_key": 7816100,
        "notes": "Warm brown velvety cap, white mycelium at the stem base; no blueing.",
    },
    {
        "danish_name": "Rustrød Skælrørhat",
        "danish_name_verified": True,
        "scientific_name": "Leccinum aurantiacum",
        "synonyms": ["Boletus aurantiacus", "Leccinum quercinum"],
        "group": "rorhat",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "core",
        "gbif_usage_key": 2524513,
        "notes": "Orange cap, dark scaly stem; with aspen and "
        "poplar. Flesh darkens on cut; harmless.",
    },
    {
        "danish_name": "Aspe-Skælrørhat",
        "danish_name_verified": True,
        "scientific_name": "Leccinum albostipitatum",
        "synonyms": ["Leccinum aurantiacum var. albostipitatum"],
        "group": "rorhat",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "extra",
        "gbif_usage_key": 7869532,
        "notes": "Orange-capped Leccinum with a white-scaled stem; with aspen.",
    },
    {
        "danish_name": "Flammet Skælrørhat",
        "danish_name_verified": True,
        "scientific_name": "Leccinum variicolor",
        "synonyms": [],
        "group": "rorhat",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "core",
        "gbif_usage_key": 2524553,
        "notes": "Mottled grey-brown birch bolete; cut flesh turns "
        "pink then grey, stem base blue-green.",
    },
    {
        "danish_name": "Hvid Skælrørhat",
        "danish_name_verified": True,
        "scientific_name": "Leccinum holopus",
        "synonyms": ["Boletus holopus"],
        "group": "rorhat",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "extra",
        "gbif_usage_key": 2524503,
        "notes": "Pale, almost white birch bolete of wet bog woodland; soft, best young.",
    },
    {
        "danish_name": "Avnbøg-Skælrørhat",
        "danish_name_verified": True,
        "scientific_name": "Leccinellum pseudoscabrum",
        "synonyms": [
            "Leccinum pseudoscabrum",
            "Leccinum carpini",
            "Leccinum griseum",
            "Leccinellum griseum",
        ],
        "group": "rorhat",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "extra",
        "gbif_usage_key": 9712569,
        "notes": "With hornbeam and hazel; cap often pitted, "
        "cut flesh reddens then blackens. Harmless.",
    },
    {
        "danish_name": "Sommer-Rørhat",
        "danish_name_verified": True,
        "scientific_name": "Boletus reticulatus",
        "synonyms": ["Boletus aestivalis", "Boletus edulis subsp. reticulatus"],
        "group": "rorhat",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "core",
        "gbif_usage_key": 5954691,
        "notes": "Early-summer cep with a finely netted stem the full length; broadleaf woods.",
    },
    {
        "danish_name": "Rødbrun Rørhat",
        "danish_name_verified": True,
        "scientific_name": "Boletus pinophilus",
        "synonyms": ["Boletus pinicola", "Boletus edulis var. pinophilus"],
        "group": "rorhat",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "core",
        "gbif_usage_key": 5954949,
        "notes": "Dark red-brown cep under pine and spruce; flesh white, unchanging. Choice.",
    },
    {
        "danish_name": "Tenstokket Rørhat",
        "danish_name_verified": True,
        "scientific_name": "Butyriboletus appendiculatus",
        "synonyms": ["Boletus appendiculatus"],
        "group": "rorhat",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "extra",
        "gbif_usage_key": 8250249,
        "notes": "Yellow pores (not red), faint blueing, rooting stem; "
        "oak woods. A red-pored bolete this is not.",
    },
    {
        "danish_name": "Blodrød Rørhat",
        "danish_name_verified": True,
        "scientific_name": "Hortiboletus rubellus",
        "synonyms": ["Boletus rubellus", "Xerocomus rubellus", "Boletus versicolor"],
        "group": "rorhat",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "extra",
        "gbif_usage_key": 8060178,
        "notes": "Small, blood-red cap and stem, yellow pores "
        "that blue faintly; grassy woodland edges.",
    },
    {
        "danish_name": "Bleg Kantarel",
        "danish_name_verified": True,
        "scientific_name": "Cantharellus pallens",
        "synonyms": ["Cantharellus cibarius var. pallens", "Cantharellus subpruinosus"],
        "group": "kantarel",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "core",
        "gbif_usage_key": 5249496,
        "notes": "The pale, bloom-frosted form of the chanterelle; "
        "same false-fold ridges, same use.",
    },
    {
        "danish_name": "Sommer-Østershat",
        "danish_name_verified": True,
        "scientific_name": "Pleurotus pulmonarius",
        "synonyms": [],
        "group": "traesvamp",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "core",
        "gbif_usage_key": 2526548,
        "notes": "Paler, thinner, summer counterpart of the "
        "oyster mushroom on dead broadleaf wood.",
    },
    {
        "danish_name": "Skællet Stilkporesvamp",
        "danish_name_verified": True,
        "scientific_name": "Cerioporus squamosus",
        "synonyms": ["Polyporus squamosus"],
        "group": "traesvamp",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "core",
        "gbif_usage_key": 2547092,
        "notes": "Big fan with dark feathery scales and a black stem base; "
        "on living broadleaf. Eat young; smells of watermelon.",
    },
    {
        "danish_name": "Kæmpeporesvamp",
        "danish_name_verified": True,
        "scientific_name": "Meripilus giganteus",
        "synonyms": ["Polyporus giganteus"],
        "group": "traesvamp",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "core",
        "gbif_usage_key": 2540761,
        "notes": "Huge rosette of tongues at the base of beech; bruises "
        "black. Only young margins, bland, cook well.",
    },
    {
        "danish_name": "Purpur-Væbnerhat",
        "danish_name_verified": True,
        "scientific_name": "Tricholomopsis rutilans",
        "synonyms": ["Tricholoma rutilans"],
        "group": "traesvamp",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "extra",
        "gbif_usage_key": 2531814,
        "notes": "Yellow gills, cap and stem covered in wine-red woolly scales; "
        "on conifer stumps. Edible but mediocre; cook well.",
    },
    {
        "danish_name": "Krystal-Støvbold",
        "danish_name_verified": True,
        "scientific_name": "Lycoperdon perlatum",
        "synonyms": ["Lycoperdon gemmatum"],
        "group": "stoevbold",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "extra",
        "gbif_usage_key": 5243258,
        "notes": "Pear-shaped, white, covered in conical warts that leave a "
        "net pattern. Edible only while the inside is pure white.",
    },
    {
        "danish_name": "Pære-Støvbold",
        "danish_name_verified": True,
        "scientific_name": "Apioperdon pyriforme",
        "synonyms": ["Lycoperdon pyriforme", "Morganella pyriformis"],
        "group": "stoevbold",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "core",
        "gbif_usage_key": 10852503,
        "notes": "The only puffball in dense clusters on rotten wood; near-smooth, "
        "tan. Eat only while the flesh is pure white.",
    },
    {
        "danish_name": "Højstokket Støvbold",
        "danish_name_verified": True,
        "scientific_name": "Lycoperdon excipuliforme",
        "synonyms": ["Handkea excipuliformis", "Calvatia excipuliformis"],
        "group": "stoevbold",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "extra",
        "gbif_usage_key": 5243279,
        "notes": "Tall pestle shape with a long sterile stalk; "
        "grassland and open woods. White flesh only.",
    },
    {
        "danish_name": "Skællet Støvbold",
        "danish_name_verified": True,
        "scientific_name": "Lycoperdon utriforme",
        "synonyms": ["Bovistella utriformis", "Handkea utriformis", "Calvatia utriformis"],
        "group": "stoevbold",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "extra",
        "gbif_usage_key": 10828425,
        "notes": "Squat, grey, cracking into a mosaic; dry grassland and dunes. White flesh only.",
    },
    {
        "danish_name": "Kæmpestøvbold",
        "danish_name_verified": True,
        "scientific_name": "Calvatia gigantea",
        "synonyms": ["Langermannia gigantea", "Lycoperdon giganteum"],
        "group": "stoevbold",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "extra",
        "gbif_usage_key": 2536058,
        "notes": "Football-sized white ball in meadows and nettle beds. Unmistakable; "
        "slice and check the flesh is uniformly white.",
    },
    {
        "danish_name": "Sortagtig Bovist",
        "danish_name_verified": True,
        "scientific_name": "Bovista nigrescens",
        "synonyms": [],
        "group": "stoevbold",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "extra",
        "gbif_usage_key": 2535203,
        "notes": "Round, stalkless; white then peeling to a papery purple-black "
        "ball that blows loose. White flesh only.",
    },
    {
        "danish_name": "Blygrå Bovist",
        "danish_name_verified": True,
        "scientific_name": "Bovista plumbea",
        "synonyms": [],
        "group": "stoevbold",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "extra",
        "gbif_usage_key": 2535193,
        "notes": "Small round grassland puffball; white skin flakes to "
        "reveal a lead-grey inner ball. White flesh only.",
    },
    {
        "danish_name": "Spiselig Morkel",
        "danish_name_verified": True,
        "scientific_name": "Morchella esculenta",
        "synonyms": ["Morchella vulgaris", "Morchella rotunda"],
        "group": "morkel",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "extra",
        "gbif_usage_key": 2594602,
        "notes": "Pale honeycombed head fused to the stem, wholly hollow. Spring, "
        "on lime-rich or disturbed ground. Always cook thoroughly.",
    },
    {
        "danish_name": "Gran-Mælkehat",
        "danish_name_verified": True,
        "scientific_name": "Lactarius deterrimus",
        "synonyms": ["Lactarius deliciosus var. deterrimus"],
        "group": "maelkehat",
        "edible": True,
        "lookalike_risk": "low",  # carrot-orange milk; no toxic milkcap has orange milk
        "tier": "extra",
        "gbif_usage_key": 7925734,
        "notes": "Orange latex turning wine-red, flesh greening; with spruce. The toxic "
        "milkcaps all have white milk.",
    },
    {
        "danish_name": "Tvefarvet Mælkehat",
        "danish_name_verified": True,
        "scientific_name": "Lactarius quieticolor",
        "synonyms": ["Lactarius deliciosus var. quieticolor"],
        "group": "maelkehat",
        "edible": True,
        "lookalike_risk": "low",
        "tier": "extra",
        "gbif_usage_key": 5248728,
        "notes": "Deliciosus-group milkcap under pine; carrot-orange milk, blue-green "
        "zones on the cap, flesh greens. No toxic lookalike has orange milk.",
    },
    {
        "danish_name": "Violet Hekseringshat",
        "danish_name_verified": True,
        "scientific_name": "Lepista nuda",
        "synonyms": ["Clitocybe nuda", "Collybia nuda", "Rhodopaxillus nudus"],
        "group": "hekseringshat",
        "edible": True,
        "lookalike_risk": "medium",  # violet slørhatte (Cortinarius): rust-brown spores, veil
        "tier": "extra",
        "gbif_usage_key": 5242048,
        "notes": "Litter saprotroph in woods, gardens and compost, often in rings; "
        "late autumn into a mild winter. Pale pink spore print. Cook thoroughly.",
    },
    {
        "danish_name": "Spinkel Hekseringshat",
        # The archive mostly says "spinkel hekseringshat i bred forstand" (sensu
        # lato); the qualifier is dropped here, as verify_danish_names does.
        "danish_name_verified": True,
        "scientific_name": "Lepista sordida",
        "synonyms": ["Clitocybe sordida", "Collybia sordida"],
        "group": "hekseringshat",
        "edible": True,
        # small and thin-fleshed: easier to confuse with toxic trævlhatte (Inocybe)
        # and small slørhatte than its larger relatives
        "lookalike_risk": "high",
        "tier": "extra",
        "gbif_usage_key": 5242097,
        "notes": "Small, thin-fleshed lilac Lepista of rich, disturbed soil: gardens, "
        "compost, nettle beds, roadsides. Cook thoroughly.",
    },
    {
        "danish_name": "Bleg Hekseringshat",
        "danish_name_verified": True,
        "scientific_name": "Lepista saeva",
        "synonyms": [
            "Lepista personata",
            "Collybia personata",  # iNaturalist's name
            "Clitocybe saeva",
            "Tricholoma personatum",
        ],
        "group": "hekseringshat",
        "edible": True,
        # Giftig Rødblad (Entoloma sinuatum) and white grassland tragthatte
        # (Clitocybe rivulosa) share its meadows; the violet stem is the check
        "lookalike_risk": "medium",
        "tier": "extra",
        # GBIF's backbone treats L. saeva as a synonym of L. personata; the
        # accepted key finds its occurrences and photos under either name
        "gbif_usage_key": 5242070,
        "notes": "Grassland Lepista: pale clay-coloured cap, stout stem streaked "
        "violet. Meadows, pastures and parks, often in rings; late autumn.",
    },
    {
        "danish_name": "Vårmusseron",
        "danish_name_verified": True,
        "scientific_name": "Calocybe gambosa",
        "synonyms": ["Tricholoma gambosum", "Lyophyllum gambosum", "Tricholoma georgii"],
        "group": "musseron",
        "edible": True,
        # Giftig Trævlhat (Inosperma erubescens) is white too, grows in the same
        # parks and verges and overlaps it in June; it can kill
        "lookalike_risk": "high",
        "tier": "extra",
        "gbif_usage_key": 8936224,
        "notes": "The spring mushroom: April-June, peak May. White, fleshy, strong "
        "smell of fresh flour, white spore print; grassland, verges, hedges, often "
        "in rings.",
    },
    {
        "danish_name": "Punktstokket Indigorørhat",
        "danish_name_verified": True,
        "scientific_name": "Neoboletus erythropus",
        # The archive's name; GBIF also keeps N. luridiformis apart, but
        # Svampeatlas files the species as N. erythropus. Its var.
        # pseudosulphureus (gul indigorørhat) is not species rank, so it is
        # not ingested.
        "synonyms": ["Boletus erythropus", "Boletus luridiformis", "Neoboletus luridiformis"],
        "group": "rorhat",
        "edible": True,
        # red pores like Satans Rørhat and Djævle-Rørhat; instant blue bruising
        # teaches that bluing != poisonous, but it takes experience
        "lookalike_risk": "high",
        "tier": "extra",
        "gbif_usage_key": 9723190,
        "notes": "Dark brown velvety cap, red pores, yellow stem with red dots (no "
        "net), yellow flesh turning dark blue at once. Beech and spruce on acid "
        "soil, June-October. Edible only thoroughly cooked.",
    },
    {
        "danish_name": "Netstokket Indigorørhat",
        "danish_name_verified": True,
        "scientific_name": "Suillellus luridus",
        "synonyms": ["Boletus luridus"],
        "group": "rorhat",
        "edible": True,
        # red net on the stem, like Satans Rørhat and Djævle-Rørhat
        "lookalike_risk": "high",
        "tier": "extra",
        "gbif_usage_key": 3355021,
        "notes": "Olive- to orange-brown cap, orange-red pores, red net on the "
        "stem, red line above the tubes when cut. Broadleaf trees on chalky "
        "soil, parks, June-September. Edible only thoroughly cooked.",
    },
]


def species_slug(species: Species) -> str:
    """The slug used for payload files, descriptions, images and the scope file."""
    return species["scientific_name"].lower().replace(" ", "-")


def candidate_species() -> list[Species]:
    """Every ``core``/``extra`` species, whether or not the curated scope includes it."""
    return [s for s in TARGET_SPECIES if s["tier"] in ("core", "extra")]


def excluded_slugs() -> frozenset[str]:
    """Slugs the curated scope leaves out of the app (empty if there is no file)."""
    if not SCOPE_FILE.exists():
        return frozenset()
    excluded = json.loads(SCOPE_FILE.read_text(encoding="utf-8")).get("excluded", [])
    unknown = set(excluded) - {species_slug(s) for s in candidate_species()}
    if unknown:
        raise ValueError(f"{SCOPE_FILE.name} excludes unknown species: {sorted(unknown)}")
    return frozenset(excluded)


def resolve_scope(current: frozenset[str], choices: dict[str, str], known: set[str]) -> set[str]:
    """The excluded set after applying the reviewer's per-species choices."""
    unknown = set(choices) - known
    if unknown:
        raise ValueError(f"review state names unknown species: {sorted(unknown)}")
    bad = {slug: v for slug, v in choices.items() if v not in ("include", "exclude")}
    if bad:
        raise ValueError(f"review state has invalid scope values: {bad}")
    excluded = set(current)
    for slug, choice in choices.items():
        if choice == "exclude":
            excluded.add(slug)
        else:
            excluded.discard(slug)
    return excluded


def core_species() -> list[Species]:
    return [s for s in published_species() if s["tier"] == "core"]


def published_species() -> list[Species]:
    """Everything that reaches the payload: ``core`` plus ``extra``, minus the
    species the curated scope excludes."""
    excluded = excluded_slugs()
    return [s for s in candidate_species() if species_slug(s) not in excluded]
