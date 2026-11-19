# 15. Migrate the basemap and address search off DAWA

Date: 2026-09-11

## Status

Accepted.

## Context

DAWA (`api.dataforsyningen.dk`) — the host behind both the app's address
search (`web/src/dawa.ts`) and its basemap (`web/src/map.ts`'s `topo_skaermkort_DAF`
WMS) — shuts down permanently on **2026-10-01, 10:00**. This was found while
investigating forest-name sources for the "forests near me" feature (ADR-0014),
not something this session set out to look for, and is unrelated to that
feature; it affects functionality the app has shipped with since early on.
Data from DAGI, Matriklen and GeoDanmark already stopped updating in DAWA from
2026-06-30. The designated successor is Datafordeler.

Two separate pieces needed a replacement, and the investigation turned up a
real complication in each:

**Basemap.** Klimadatastyrelsen's "Skærmkort" is still the right map, just
hosted differently: `wms.datafordeler.dk/Dkskaermkort/topo_skaermkort/1.0.0/wms`
carries the identical layer name (`dtk_skaermkort`) and the same on-the-fly
EPSG:3857 reprojection the app already relies on — confirmed with a real
`GetMap` request returning a valid PNG tile. Essentially a URL swap.

**Address search.** DAWA's `adgangsadresser/autocomplete` is replaced by
Adressevælgeren, a genuinely different API shape: a phonetic search
(`adressevaelger.dk/soeg`) returns candidate ids with no coordinates, and each
candidate needs a follow-up lookup by id (`adressevaelger.dk/husnumre/{id}`)
to get them — one autocomplete keystroke now costs 1 + N requests instead of
1, where N is the number of candidates worth showing (capped at 6, matching
DAWA's `per_side=6`). Lookup coordinates also come back in **EPSG:25832
(UTM zone 32N)**, not WGS84 — the app works in `[lon, lat]` everywhere else, so
this needed an actual coordinate conversion, not just a field rename.

**Auth: two different credential types, and only one is client-safe.** Both
the WMS and Adressevælgeren accept either an OAuth Shared Secret or a plain
**API-Key**. The pipeline's existing `DATAFORDELER_CLIENT_ID`/`SECRET` (ADR-0014)
is a Shared Secret — it authorises *all* of Datafordeler's open data for that
IT-system, which makes it exactly the kind of credential that must never ship
in browser code (unlike a scoped, revocable API-Key meant to sit in a URL).
Per Klimadatastyrelsen's own admin guide, an **API-Key** is the client-safe
option: "kun give adgang til ubeskyttet data" (only grants access to public
data), "vil... blive anvendt direkte i URL'en" (used directly in the URL) —
the same shape as the token the app already ships client-side today. It lives
under the same IT-system as the Shared Secret, in a separate "API-Keys"
section, and both services accept it with no extra per-service subscription
step (same pattern already seen for GeoDanmark/Stednavne under the OAuth
Shared Secret in ADR-0014).

## Decision

`VITE_DATAFORDELER_API_KEY` (an API-Key, not the pipeline's OAuth Shared
Secret) replaces `VITE_DATAFORSYNINGEN_TOKEN` everywhere it was used —
`web/src/map.ts`'s basemap WMS, `.env.example`, `vite-env.d.ts`, `deploy.yml`,
and `docs/deploy.md`. `web/src/dawa.ts` is replaced by `web/src/addresses.ts`
(`DawaAutocompleteItem` → `AddressSuggestion`, kept structurally identical so
callers barely changed): a phonetic search, a lookup per candidate, and a
hand-written UTM32N→WGS84 conversion (`utm32nToWgs84`, exported and unit
tested against a real Adressevælgeren response) since all of Denmark falls in
one UTM zone, so a general multi-zone implementation would be unneeded
complexity.

## Consequences

- Address search now costs up to 7 HTTP requests per debounced keystroke
  instead of 1. Kept to the existing 250 ms debounce and 6-result cap; no
  further throttling added since this hasn't been observed to feel slow, but
  it's the first thing to revisit if it does.
- The repo now carries two Datafordeler credential *families* that must not be
  confused: `DATAFORDELER_CLIENT_ID`/`SECRET` (OAuth Shared Secret, root
  `.env`, pipeline-only, never client-side) and `VITE_DATAFORDELER_API_KEY`
  (API-Key, `web/.env.local`, deliberately shipped in the client bundle). Both
  live under the same "API adgang svampe app" IT-system in Datafordeler
  Administration.
- `VITE_DATAFORSYNINGEN_TOKEN` is fully retired from the codebase; the
  matching GitHub Actions secret should be removed once this deploys
  successfully (not done here — a manual repo-settings step).
- Needs a browser check before merge, same as any change to how the map's
  basemap loads (prior incident, recorded in the durable session memory) --
  the API-Key must be live-tested end to end in a real browser, not just via
  the curl/PowerShell probes used during investigation.
