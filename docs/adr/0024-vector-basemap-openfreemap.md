# 24. Vector basemap: OpenStreetMap data from OpenFreeMap, our own style

Date: 2026-11-20

## Status

Accepted

## Context

The basemap was Klimadatastyrelsen's Skærmkort, a raster WMS (ADR-0015), with
OpenStreetMap's raster tiles as fallback. Side by side with OSM at the zooms
the app uses, Skærmkort is soft from zoom 14 in, has no forest tracks or paths
and few road names, and its look is plainer; the owner preferred OSM's look.
OSM's own tile server is not for app traffic (tile usage policy), so OSM
cannot simply become the main map.

## Decision

- **OpenFreeMap vector tiles** (`tiles.openfreemap.org/planet`, OpenMapTiles
  schema, OSM data): free, no key, no registration, meant for this use.
- **Our own short style** (`web/src/basemapstyle.ts`), not a published one:
  forest, heath, bog, water, roads, forest tracks and paths (brown, dashed, as
  OSM draws them), Danish names (`name:da`), an OSM-like palette with orange
  instead of pink motorways (raspberry is the finds), and a dark palette.
- **Forest names from our own data** (`web/src/forestlabels.ts`): OSM has
  the forests but rarely their names; forests.json (Danske Stednavne) has the
  official ones Skærmkort printed. Bigger forests show from further out.
- **One invisible marker layer** (`basemap`) between the ground and the roads:
  data that belongs on the ground (forest scores, the pin's forest outline)
  goes directly above it, so roads and names stay readable over them.
- **Fallbacks**: if the vector basemap fails before any of its tiles arrived,
  Skærmkort (with a key) and then OSM's raster tiles replace it below the same
  marker. Errors after tiles arrived (no signal in the forest) are left alone.

## Consequences

- Sharper map on phones, forest paths at walking zooms, and a dark map drawn
  dark rather than an inverted raster.
- Attribution changes to © OpenStreetMap · OpenMapTiles · OpenFreeMap (ODbL
  for the data). Skærmkort's credit stays for the fallback.
- A dependency on a free community service; the fallback chain covers an
  outage. An invalid style does not throw but leaves the map unloaded, so
  `basemapstyle.test.ts` validates the style against the MapLibre spec.
- At the opening whole-country zoom the tiles carry only the largest cities;
  towns appear from about zoom 7.
