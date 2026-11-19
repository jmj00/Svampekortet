# 14. Named forests from Danske Stednavne; rank by conditions score

Date: 2026-09-11

## Status

Accepted. Supersedes [ADR-0013](0013-forests-near-me-geodanmark-point-grid.md)'s
data source (its point-grid GeoDanmark workaround); the rest of that ADR's
reasoning (static-precompute architecture, run-by-hand cadence) still holds.

## Context

Two gaps in the first cut of "forests near me" (ADR-0013), found during user
testing: the point-grid GeoDanmark polygons carry no name (GeoDanmark is
topographic, not a gazetteer), so every suggestion read "Skov — 6.2 km"; and
the list was sorted by distance alone, when what a user actually wants is
somewhere *good*, not just close.

**Names.** Denmark has an official place-name register, Danske Stednavne,
reachable through Datafordeler's Stednavne WFS
(`wfs.datafordeler.dk/Stednavn/STEDNAVNE_BEARBEJDET_GML3SFP/1/WFS`) — the same
OAuth Shared Secret as GeoDanmark. Unlike GeoDanmark Vektor's WFS (down, 503 on
every path), **this WFS works**, and its `sn:Naturareal` feature type carries a
`naturarealtype` field; a Denmark-wide sample found six values in use
(`skovPlantage`, `moseSump`, `agerMark`, `parkAnlæg`, `eng`, `hede`) of which
only `skovPlantage` (forest/plantation) is forest. Filtering on it and paging
through the whole country (`CQL_FILTER=naturarealtype='skovPlantage'`, GeoServer's
`STARTINDEX`/`COUNT` paging) returns 5,795 named polygons directly — real
names ("Rold Skov", "Gribskov", "Jægersborg Skov"), real boundaries, in one
clean bulk pull instead of tens of thousands of point probes. This fully
replaces the GeoDanmark point-grid for this feature; `pipeline.ingest.geodanmark`
stays in the repo (documented, tested, still the option if a comprehensive
*unnamed* land-cover layer is wanted later) but nothing publishes its output
anymore.

One caveat found along the way, unrelated to which technology serves it:
**Danske Stednavne has not been updated since September 2025** — a standing
data freeze on the register itself. Forest names/boundaries change on a
timescale of decades, so a year-stale snapshot is not a real problem here.

Separately — worth its own flag, **not** acted on in this change — DAWA
(`api.dataforsyningen.dk`, the host behind the app's *existing* address search
and basemap) shuts down permanently 2026-10-01. That is a different platform
from the Datafordeler infrastructure this ADR uses, and migrating the existing
`web/src/dawa.ts` / basemap WMS is out of scope here; flagged to the user
separately as its own follow-up.

**Ranking.** The app already scores every species at a point
(`conditionsScore` — habitat KDE + seasonality + weather, ADR-0006/0008) for
the pin's ranked list. There is no existing notion of a single combined score
*across* species, and inventing one is a real design choice — geometric mean
across all core species would reward a spot that's mediocre-but-broad over one
that's an excellent single-species spot, which is the opposite of what a
forager scanning "where's something good nearby" wants. **The best (max)
current score among core-tier species** at that point is what's shown instead,
labelled with which species — e.g. "82 · Almindelig Kantarel" — trading
"scientifically tidy combination" for "answers the actual question".
`extra`-tier species are excluded from the max the same way they're excluded
from the pin's validated ranking (ADR-0012).

## Decision

`pipeline.ingest.stednavne` replaces `forest_points` with a `named_forests`
table (`sted_id`, `name`, `lon`, `lat`, `area_m2`); the centroid is computed
from the WFS's `posList` with a proper area-weighted (shoelace) polygon
centroid, not a vertex average — worth the extra ~15 lines for oddly-shaped
polygons, and cheap either way. Note the axis-order trap: this WFS's
`EPSG:4326` responses are **lat, lon**, the opposite of this codebase's
`[lon, lat]` convention everywhere else, including GeoDanmark's own WMS — every
coordinate pair is swapped on the way in.

`pipeline.publish.site` now reads `named_forests` (was `forest_points`) and
writes `forests.json` as `{name, lon, lat, area_m2}` objects (was bare `[lon,
lat]` pairs). `web/src/forests.ts` gains `rankForestsByScore`: takes the
nearest `MAX_CANDIDATES_TO_SCORE` (25) named forests within the chosen radius
— capped because a 50 km radius can hold well over a thousand candidates, and
scoring is a real per-candidate computation, not a lookup — scores each with
the existing `rankHere` (species docs/models are already cached from the pin's
own ranked list, so this is CPU-only, no new network calls), and sorts by the
best core-species score. `nearestForests` (plain distance) stays as the
fallback path when no model is loaded.

## Consequences

- A forest with no `skovPlantage`-typed named area nearby (a genuinely small or
  unremarkable patch) won't appear at all, even if GeoDanmark would show
  forest cover there — this trades comprehensive coverage for names /
  boundaries worth showing a user, which is the right trade for a "go here"
  suggestion feature specifically.
- Scoring 25 candidates × 50 species per search is a real, user-visible
  computation (a loading state — "Finder de bedste skove…" — covers it) rather
  than instant; acceptable for an explicit "find" button press, not something
  to run on every pin move.
- `pipeline.ingest.geodanmark`'s point-grid workaround is now unused by
  anything shipped, kept only as a working, tested option for later
  (unnamed, comprehensive land-cover — the deferred habitat/geology
  model-signal question this whole feature grew out of).
- The "best single species" framing is a real product opinion, not a neutral
  default — if it turns out to mislead (e.g. a forest that's spectacular for
  one obscure species but mediocre overall reads as a top result), the fix is
  choosing a different combination rule here, not touching `conditionsScore`
  itself.
