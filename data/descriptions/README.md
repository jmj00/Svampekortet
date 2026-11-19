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

### Flagged for the reviewer

| slug | flag |
| --- | --- |
| `fistulina-hepatica` | text suggests eating it raw ("bruges tit rå i små mængder i salat") — decide whether to keep or make it cook-only |
| `hydnum-repandum` | mentions *Hydnum rufescens* ("Rødgul Pigsvamp", archive-confirmed) as a harmless lookalike; that species is not itself in the app |
| `apioperdon-pyriforme` etc. | "kartoffelbovist" was changed to the archive form "bruskbold" — confirm that's the term you want in a beginner safety line |
| `cantharellus-cibarius`, `cerioporus-squamosus`, `craterellus-tubaeformis` | season phrasing is a little off the record peak (a few weeks early or late) — kept as written; tighten if you like |
| *(all)* | every edibility claim, cap-size range, and "no toxic lookalike" line still needs an expert eye — these are the safety-critical lines and were not verifiable against a structured source |

When a species is expert-reviewed, note it in this file (and, if we later add a
`description_reviewed` field to `pipeline/species.py`, flip it there).
