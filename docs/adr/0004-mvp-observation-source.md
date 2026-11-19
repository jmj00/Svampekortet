# 4. Svampeatlas is the only observation source for the MVP

Date: 2026-09-01

## Status

Accepted. Svampeatlas is still the only source; the "in Jutland" framing was
widened to all of Denmark by
[ADR-0010](0010-expand-study-area-to-denmark.md).

## Context

The Phase 0 spikes compared the two open observation sources for the six core
species in Jutland:

- **Svampeatlas** — 20,664 target-species rows in its Darwin Core archive,
  full national coverage, uniformly `CC BY-NC 4.0`, `vernacularName` 95.9%
  populated, `WGS84` coordinates.
- **arter.dk** — only 161 target-species rows, `license` column empty (terms
  unconfirmed), a different `taxonRank` vocabulary, and its own obfuscation flag
  (`informationWithheld = "Occurrence blurred"`).

The GBIF counts told the same story: arter.dk contributes 1–33 records per species
in Jutland against Svampeatlas's hundreds to low thousands.

## Decision

For the MVP, ingest observations from **Svampeatlas only** (via its GBIF-published
dataset / Darwin Core archive). Defer arter.dk integration to Phase 3, gated on:

1. confirming arter.dk's licence terms, and
2. building the cross-source deduplication and taxonomy-normalisation layer.

Sensitive-species handling (our own red list plus any upstream withheld flags)
applies regardless of source.

## Consequences

- One taxonomy vocabulary, one licence (`CC BY-NC 4.0`), one CRS to reason about;
  no dedup layer needed for the MVP.
- An estimated ~1% recall loss from skipping arter.dk — acceptable at this stage.
- arter.dk's `"Occurrence blurred"` mechanism is recorded in
  `docs/data-sources.md` for when the source is added.
- Published derived data stays `CC BY-NC 4.0`.
