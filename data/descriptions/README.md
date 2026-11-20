# Species descriptions

One plain-Danish file per species, `<slug>.md`, read by `pipeline/publish/site.py`
into the `description` field of the published payload. Slug = lower-case
scientific name with spaces as hyphens (e.g. `cantharellus-cibarius.md`).

These are **project-original text** (not copied from Svampeatlas or Artsbogen, so
no upstream licence applies). Keep them short — a few sentences on appearance,
habitat and season, an edibility note, and the main lookalike. The app already
shows the "not an identification tool" / Giftlinjen warning separately.
Puffball files lead with the mandatory cut-open white-flesh check.

## Review status

> **None of these have had a mycologist review yet.** This is a launch blocker —
> the appearance, habitat, season, edibility and *especially* the
> "forvekslingsart" lines carry real safety weight and were written by the
> project, not an expert.

- **self-checked** — Claude passes (2026-09), *not* an authority on edibility or
  safety:
  1. **Names.** Every lookalike/relative named in the prose now uses the Danish
     name the Svampeatlas archive carries for that taxon. Corrections:
     *Hygrophoropsis aurantiaca* → "Almindelig Orangekantarel" (was "Falsk
     Kantarel"); a young *Amanita* button → "fluesvamp" (was "knoldslørhat",
     which is *Cortinarius*); *Scleroderma* → "bruskbold"; *Gyromitra esculenta*
     → "Ægte Stenmorkel"; *Exidia* → "bævretop"; *Lactarius necator* →
     "Manddraber-Mælkehat"; *Sparassis brevipes* → "Ege-Blomkålssvamp"; "Grå
     Kantarel" = *Craterellus cinereus*.
  2. **Phenology.** Each description's stated season was checked against the
     month distribution of that species' dated Danish finds in the archive
     (`scripts/`-style scan, ~85 k records). 47 of 50 matched; corrected:
     `leccinum-scabrum` "juni til oktober" → "juli til oktober"; and
     `laetiporus-sulphureus` "sidst på foråret hen over sommeren" → "maj til
     oktober" (records run well into autumn). `morchella-esculenta` "april-maj"
     is exactly right — a prior flag here was wrong and is removed.
  3. **Hallucination scan.** No invented species and no claim contradicted by
     the data. Morphology, host trees and edibility notes were written from
     general mycology and *spot-checked* — none were wrong — but arter.dk and
     Svampeatlas render their species texts client-side (not machine-readable
     here) and are CC BY-NC, so those details were not verified line-by-line
     against them.
- **expert** — signed off by a named mycologist. *(none yet)*

All 50 published species are **self-checked**; 0 are **expert**.

The three hekseringshatte added 2026-11-20 (`lepista-nuda`, `lepista-sordida`,
`lepista-saeva`) went through the same checks when they were written: every
lookalike named takes its archive name (Lysviolet Slørhat, Mørkviolet Slørhat,
Violet Ametysthat, Giftig Rødblad, Eng-Tragthat; genera slørhat, trævlhat), and
each season matches the month distribution of the species' archive finds
(nuda Sep–Dec, peak Oct–Nov; sordida Sep–Nov, peak Oct; saeva Oct–Dec, peak
Nov; all three have January finds in mild winters). `calocybe-gambosa`
(Vårmusseron, same day) likewise: Giftig Trævlhat is the archive's name for
*Inosperma erubescens* (formerly *Inocybe*), with Snehvid Fluesvamp and Flammet
Rødblad; season April–June, peak May (1,285 of 2,046 finds), and Giftig Trævlhat's
own finds start in June.

### Review round 2026-11-20

From the review page (scope switches) and a written second opinion:

- **Taken out of the app** (`data/species_scope.json`): Sortagtig Bovist, Blygrå
  Bovist, Højstokket Støvbold, Skællet Stilkporesvamp, Oksetunge, Svovlporesvamp
  (stomach upsets reported unless thoroughly fried), Kæmpeporesvamp,
  Purpur-Væbnerhat, Vaskeskinds-Rørhat, and Tenstokket Rørhat (from the second
  opinion). Filtet Rørhat stays. Finsprukken Rørhat stays: despite *cisalpinus*
  it is found all over Denmark (archive).
- **Red-pored boletes.** The old shared line "Ingen danske rørhatte er dødeligt
  giftige. Hold dig fra eksemplarer med røde eller orange porer og kraftig
  blånfarvning" was wrong: Punktstokket and Netstokket Indigorørhat have red
  pores, blue strongly and are edible when cooked. It now says red-pored boletes
  need experience, naming the edible indigorørhatte and the poisonous Satans
  Rørhat and Djævle-Rørhat. It was dropped from the slimrørhatte, which have
  nothing to do with red-pored boletes.
- **Giftige forvekslinger.** New section on the pages of Spiselig, Sommer- and
  Rødbrun Rørhat, the three Xerocomellus, Filtet and Blodrød Rørhat: photo, names
  and how to tell apart for Satans Rørhat (*Rubroboletus satanas*) and
  Djævle-Rørhat (*R. legaliae*), from `data/lookalikes.json` (archive names;
  seasons from their Danish finds, July–October). Their photos were chosen by
  hand and are `reviewed: false`.
- The second opinion mentions corrections written "undervejs", but the review
  page holds no edited descriptions, so none could be applied.

### Flagged for the reviewer

| slug | flag |
| --- | --- |
| `hydnum-repandum` | mentions *Hydnum rufescens* ("Rødgul Pigsvamp", archive-confirmed) as a harmless lookalike; that species is not itself in the app |
| `apioperdon-pyriforme` etc. | "kartoffelbovist" was changed to the archive form "bruskbold" — confirm that's the term you want in a beginner safety line |
| `cantharellus-cibarius`, `cerioporus-squamosus`, `craterellus-tubaeformis` | season phrasing is a little off the record peak (a few weeks early or late) — kept as written; tighten if you like |
| `lepista-*` | all three say "varmebehandles grundigt" (raw or undercooked hekseringshat can upset the stomach); `lepista-sordida` is marked `lookalike_risk: "high"` and "ikke et godt valg for begyndere" because of the toxic trævlhatte in the same habitat — confirm both; the photos were pulled by iNaturalist's name *Collybia* and are `reviewed: false` |
| `calocybe-gambosa` | marked `lookalike_risk: "high"` because Giftig Trævlhat shares its habitat and overlaps in June — confirm; check the description of Giftig Trævlhat (cone-shaped fibrous cap, reddening) and the advice to dig up the base for Snehvid Fluesvamp |
| `data/lookalikes.json` (round 2) | three more poisonous lookalikes: Grøn Fluesvamp (young egg, cut) and Almindelig Bruskbold on the four støvbolde; Ægte Stenmorkel on Spiselig Morkel. (Vårmusseron and Bleg Hekseringshat keep their lookalikes in the description only, by choice.) Archive names; seasons from their Danish finds. Check each text and that every photo (hand-picked, `reviewed: false`) shows the right species and the telling feature |
| `rubroboletus-satanas`, `rubroboletus-legaliae` | lookalike texts and photos in `data/lookalikes.json` / `data/images/` — check the field marks and that each photo shows the right species |
| *(all)* | every edibility claim, cap-size range, and "no toxic lookalike" line still needs an expert eye — these are the safety-critical lines and were not verifiable against a structured source |

When a species is expert-reviewed, note it in this file (and, if we later add a
`description_reviewed` field to `pipeline/species.py`, flip it there).
