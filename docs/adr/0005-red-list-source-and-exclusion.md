# 5. Red List source and sensitive-species exclusion

Date: 2026-09-01

## Status

Accepted

## Context

The app must hide sensitive / red-listed fungi (see `docs/data-sources.md`,
"Sensitive-species handling"). Neither the Svampeatlas taxa API nor arter.dk
(without its partner API) exposes red-list status in a usable form; both portals
derive it from the same upstream — **Den Danske Rødliste** (Aarhus University /
DCE – Danish Centre for Environment and Energy), which publishes a public REST API.

## Decision

- **Source:** `https://api.redlist.au.dk/public/v1/summary/assessments/` with
  `vurderingsrunde=2019` (the round in which fungi were assessed, 2014–2019).
  No authentication. Paginated (`page` / `per_page`, response carries `pages` /
  `total`). Fields used: `scientificName`, `vernacularName`, `redlistCategory`,
  `overallSpeciesGroup`, `taxonId`, `arterDkId`.
- **Filter** with `speciesGroup=Svampe` (then keep `overallSpeciesGroup == "Svampe"`).
  The 2019 round has 3,303 fungal assessments: LC 1436, DD 1018, EN 268, VU 205,
  NE 113, NA 99, CR 99, NT 50, RE 15.
- **Categories that hide a species** (shown as a "sensitive / red-listed — not
  displayed" note): **RE, CR, EN, VU, NT** — 637 species (~19% of assessed fungi).
- **Categories shown normally:** **LC**, **DD**, and not-evaluated (**NA / NE**).
  DD (Data Deficient) is *not* hidden: it means "too little data to assess", not
  "rare", and it covers 671 species — a third of the assessed fungal flora.
- **Join** to observation data on `scientificName` (GBIF-backbone-compatible);
  keep `arterDkId` for cross-reference.
- **Enforcement:** a publish-blocking test — no observation of a hidden taxon may
  reach the published artifacts, at any coordinate precision.
- **Refresh:** re-pull when a new assessment round is published; `vurderingsrunde=
  latest` detects it.
- **Attribution:** "Den Danske Rødliste, DCE – Nationalt Center for Miljø og
  Energi, Aarhus Universitet (2019)". Terms: free use with citation.

## Consequences

- One authoritative, versioned list, independent of the observation sources.
- **NT is hidden** (precautionary — near-threatened species are still of
  conservation concern). **DD is not** — hiding a third of Danish fungi because
  they are understudied would be disproportionate, and DD is not a location-
  sensitivity signal the way the threatened categories are.
- The hidden set is data-driven and changes between assessment rounds, so the
  user-facing note must not hard-code a category.
- If a core MVP species were ever red-listed it would silently disappear from the
  app — the ingest logs the category of every target species so this is visible.
- Confirmed by the `redlist_fungi` spike: none of the six core species are listed
  (four LC, two — both *Suillus* — not assessed).
