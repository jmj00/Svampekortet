# 13. "Forests near me": GeoDanmark forest points via a point-grid, not the WFS

Date: 2026-09-11

## Status

Superseded by [ADR-0014](0014-named-forests-stednavne-and-score-ranking.md) for
the data source: Danske Stednavne's WFS turned out to work (this ADR's
GeoDanmark WFS did not) and gives named polygons directly, no point-grid
needed. The architecture reasoning below (static precompute, run-by-hand
cadence, no live vector query from the browser) still holds.

## Context

A user picks a spot (a click, an address, or "my location") to check the ranked
species list there. The ask: suggest nearby places worth checking — specifically
forests, within an adjustable radius (default 20 km) — rather than requiring the
user to already know where to click.

The static-precompute architecture ([ADR-0002](0002-tech-stack-and-precompute-architecture.md))
rules out a live vector query from the browser: this needs a small, build-time-
generated payload, ranked client-side by distance the same way `rank.ts` already
scores species at a pin.

Three Danish sources were tried for forest/land-cover polygons and each hit a
wall from this environment: Dataforsyningen's legacy GeoDanmark WFS proxy
(`api.dataforsyningen.dk`) returns HTTP 500 ("workhorses exhausted") on every
call, with or without a token — likely a deprecated path. Datafordeler's own
GeoDanmark Vektor **WFS is down** — 503 on every URL variant tried, including
nonsense ones, which points to a genuine outage rather than a wrong path.
Miljøportalen's Arealdata (§3-protected nature types) only exposes its Vue
frontend; no working API endpoint was found. CORINE Land Cover (EU/Copernicus)
was confirmed working as a fallback but its 25 ha minimum mapping unit is too
coarse for Denmark's many small forest patches.

GeoDanmark Vektor's **WMS**, however, works, and carries a `SKOV` (forest)
layer under the same CC BY 4.0 licence already used for the basemap
(`web/src/map.ts`). Its auth is an OAuth Shared Secret from a Datafordeler
IT-system (`client_credentials` → a 60-minute bearer token) — a different
product from the basemap's plain `token=` query-param key, both issued from the
same Datafordeler Administration portal. `GetFeatureInfo` against a tiny bbox
around a point returns the covering polygon's attributes and bounding box —
confirmed against real Danish forests (Silkeborg → `Skov`, `underminimumskov:
f`) — even while the WFS is unreachable.

## Decision

**`pipeline.ingest.geodanmark` point-samples the `SKOV` layer over a grid
across Denmark (`GetFeatureInfo`, ~1.5 km spacing, ~76k points, concurrent
requests) and dedupes hits by the polygon's `gmlid` to one representative point
per polygon** (its bounding-box centre). This is a workaround for the WFS
outage, not the preferred design — a real vector pull would give exact polygon
shapes in one request instead of tens of thousands of point probes — but it
needed no new dependency (stdlib `urllib` + `xml.etree`, no image/raster
library) and validated cleanly end to end (0 errors on real test runs).

GeoDanmark carries no forest *name* attribute — it is topographic, not a
gazetteer — so a suggestion reads "Skov — 6.2 km", not "Rold Skov".

This does **not** join `pipeline.build`'s weekly run. GeoDanmark's aerial-photo
topography updates roughly yearly, not weekly, and a full run costs ~76k HTTP
requests (~15-20 min at 10 concurrent workers). It is run by hand when the
forest layer needs refreshing, writing a `forest_points` table into the same
DuckDB the rest of the pipeline uses (so it is joinable later, e.g. for the
deferred habitat/geology model-signal question). `pipeline.publish.site`
writes `forests.json` (a flat `[lon, lat]` array) only if that table exists,
and sets `manifest.forests = null` otherwise — a deploy without a fresh forest
table still ships, just without forest suggestions.

The web side (`web/src/forests.ts`, wired into `main.ts`) is a plain haversine
nearest-N filter over that array, client-side, exactly like the existing
"nearby species" scoring — no new query surface, no live third-party call at
click time.

## Consequences

- A refresh is a manual, occasional operation
  (`python -m pipeline.ingest.geodanmark`), not part of the automated deploy —
  a real gap versus the rest of the pipeline's "always current" posture, traded
  for not adding Datafordeler credentials and a slow network job to every
  routine weekly build.
- Point-grid coverage can miss forest patches narrower than the ~1.5 km grid
  spacing, and can jitter a representative point outside the exact queried
  cell for large/irregular polygons (observed in testing: a probe just inside
  a bbox edge returned a centroid a few hundred metres outside it). Acceptable
  for "here's a forest worth checking", not for anything needing exact
  boundaries.
- If Datafordeler's WFS comes back, replacing the point-grid with a real
  `GetFeature` pull is a drop-in change to `pipeline.ingest.geodanmark` only —
  the DB schema (`forest_points`), publish step, and web side are unaffected.
- Extending to other GeoDanmark land-cover layers (fields, pasture, hedgerows)
  or to soil/geology (GEUS Jordartskort) is the same pattern, deferred until
  asked for.
