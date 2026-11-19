# 3. Species name resolution and display

Date: 2026-09-01

## Status

Accepted

## Context

Records come from multiple sources with inconsistent taxonomy and synonymy
(e.g. *Boletus badius* vs *Imleria badia*). The UI must show the Danish name by
default, always expose the scientific name, and fall back to the scientific name
when no Danish name exists. Fungal taxonomy also changes over time.

## Decision

- **Internal taxon id:** the GBIF Backbone Taxonomy `usageKey`, obtained via the
  GBIF `species/match` endpoint. All observations are keyed to it.
- **Synonyms:** `pipeline/species.py` records known synonyms per species so older
  names in source data resolve correctly.
- **Danish name, in priority order:** `vernacularName` from the Svampeatlas Darwin
  Core archive; then arter.dk; then a manually curated value; otherwise the
  scientific name is shown alone.
- **Verification gate (Phase 0):** every `danish_name` in `pipeline/species.py`
  must be checked against Svampeatlas's own `vernacularName` (the value carried in
  its Darwin Core archive is accepted as canonical) and its `danish_name_verified`
  flag set to `true`. Done for the 6 core species; this corrected *Suillus luteus*
  to "Brungul Slimrørhat" and *Suillus variegatus* to "Broget Slimrørhat".
- Display: `Danish Name (Scientific name)`; when unverified, the UI must not ship.

## Consequences

- One stable integer id to join on, resilient to display-name changes.
- A small manual verification step for the MVP species list, done once.
- If GBIF's backbone lumps/splits a target taxon oddly, that species needs a
  documented override.
