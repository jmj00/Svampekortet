# 20. Forest outlines: "at the pin" means inside the forest

Date: 2026-11-17

## Status

Accepted. Extends [ADR-0014](0014-named-forests-stednavne-and-score-ranking.md):
the polygons that ADR's ingest read and threw away are now kept. The ranking of
forests by conditions score is unchanged.

## Context

The forest tab and the location chip name the forest the pin stands in ("Ved
din nål"). Until now that was decided from `forests.json` alone, which holds one
point per named forest: the pin was "at" the nearest forest point within
1.5 km. Two things were wrong with that, both seen in use:

- A pin deep inside a large forest got no forest. Rold Skov is 96 km² and
  Gribskov 53 km²; most of either lies more than 1.5 km from its centre.
- A pin in a field or a village got a forest, if a small forest's centre
  happened to be within 1.5 km.

`pipeline.ingest.stednavne` already pulls every forest's polygon from Danske
Stednavne (`sn:Naturareal`, `naturarealtype='skovPlantage'`) to compute the
point. Keeping the polygon answers the question properly: is the pin inside
this forest?

## Decision

**Pipeline.** `pipeline.ingest.stednavne` keeps each feature's geometry in a
new table, `named_forest_outlines (sted_id, outline)`.

- *What is read.* Every `gml:Polygon` of a feature, with its exterior ring and
  any interior rings. In the pull of 2026-11-17 (5,795 features, 5,794 usable)
  every feature had exactly one polygon, and one had a hole; multi-part forests
  and holes are nevertheless carried through, as a list of polygons each with
  `[outer, hole, ...]`.
- *Axis order.* As ADR-0014 notes, this WFS answers `EPSG:4326` as **lat,
  lon**; pairs are swapped to this codebase's `[lon, lat]` on the way in, and a
  test pins that down.
- *Simplification.* Douglas-Peucker at 25 m (`pipeline.forest_outlines`), then
  rounding to five decimals (about 1 m). A simplified ring that crosses itself
  is retried at half the tolerance (up to three times) and otherwise kept
  unsimplified; rings that are not polygons are dropped. Holes smaller than
  2 ha are dropped: they are below what the app's margin (below) can tell
  apart. 123,881 corners remain, 21 per forest on average.
- *The forest's point.* `named_forests.lon/lat`, and so `forests.json`, is now
  a point that is the forest's own, published with five decimals like the
  outlines (four could round it to just outside its outline). The app puts the
  pin there when a forest is chosen by name, so the point must be inside the
  forest's outline, clear of its edge, and outside every *smaller* named forest
  lying in it, since the app names the smallest forest a pin is in. The
  centroid is kept where it is all that; otherwise (`settle_points`) the point
  is moved to the spot in the forest furthest from its own edge and from the
  smaller forests' edges, among a 24 by 24 grid over it. In the 2026-11-17 pull
  110 of 5,794 points were moved: crescent-shaped forests whose centroid is
  outside them, and large forests whose centroid is in one of their named
  parts (Gribskov, Rold Skov). Three forests are left with a point inside a
  smaller forest because smaller named forests cover them entirely; the app's
  rule (below) still names them correctly when they are chosen by name. Tests
  check the snapshot under `web/public/data`: every point inside its own
  outline, at most three inside a smaller forest.
- `--raw-dir` keeps the WFS pages on disk and reuses them, so the parse can be
  changed and re-run without the network or credentials.

**Published format.** `pipeline.publish.site` lists the forests west to east
(in `forests.json`, whose entries are otherwise unchanged: `{name, lon, lat,
area_m2}`) and writes the outlines beside it as `forest-outlines-<n>.json`:
consecutive runs of that list, each at most 400 kB, so that each file is a
band of the country. The manifest names them:

```json
"forest_outlines": [
  {"file": "forest-outlines-0.json", "start": 0, "count": 1991,
   "bbox": [8.1138, 54.81296, 9.82769, 57.44558]}
]
```

Each file is `{version, scale, start, count, stamp, forests}`; `forests[i]` is
the outline of forest `start + i` in `forests.json`, or null. A ring is a flat
list of integers in 1/`scale` degrees: the first corner as lon, lat, each later
corner as the difference from the one before, the closing point left out.
`stamp` is a short hash of the `forests.json` written in the same run; the
manifest entry carries the same one, and the app refuses a file whose stamp
differs, so a manifest and an outline file from different publishes fall back
to the forest points instead of pairing outlines with the wrong forests.

Measured on the full pull:

| | raw | gzip -9 |
| --- | --- | --- |
| `forests.json` (points with five decimals; 455 / 95 kB with four) | 466 kB | 101 kB |
| outlines as plain `[lon, lat]` JSON, one file | 2,537 kB | 718 kB |
| outlines delta-coded, one file | 1,041 kB | 405 kB |
| outlines delta-coded, three bands | 400 + 400 + 242 kB | 156 + 155 + 93 kB |

The delta coding is worth its small decoder (it is tested on both sides). The
split costs nothing in total size and means a visit downloads the 93 to 156 kB
for the part of the country its pin is in, not all 405 kB; it also keeps every
file of the snapshot under `web/public/data` below the repository's 512 kB
large-file check. The bands overlap slightly in extent (a forest belongs to
the band its point is in); the app asks for every band whose box, widened by
500 m, holds the pin.

A manifest without `forest_outlines` (or with it null), which is what any
database without the new table publishes, makes the app fall back to the
forest points. Older clients ignore the key.

**The rule in the app** (`forestAtPin` in `web/src/forests.ts`, shared by the
location chip and the forest tab):

1. a forest chosen by name stays that forest: when the pin stands exactly on a
   forest's own published point (which only choosing the forest does: from a
   search, the start screen, the result list or the "nearest forest"
   shortcut; a tap on the map never lands there) and that forest's outline
   holds the pin, it is that forest, even where a smaller one lies there too;
2. otherwise the smallest forest (by registered area) whose outline contains
   the pin: a named part inside a larger forest wins over the larger one;
3. otherwise the forest whose edge is nearest, if within 125 m
   (`PIN_EDGE_MARGIN_KM`): a pin on the road or the car park along the forest,
   or one the 25 m simplification left just outside. The chip then reads
   "Ved …" where a pin inside reads "I …";
4. otherwise no named forest at the pin.

When the forest found lies inside larger named forests, the largest of them
is named with it: the card reads "Mølleskov · en del af Rold Skov", the chip
"I Mølleskov i Rold Skov". (The largest, not the next one up: it is the name
people know the place by.)

Without outlines for the spot (none published, or the band could not be
fetched) the old rule applies: nearest forest point within 1.5 km. The
"nearest forest" shortcut measures to the nearest outline edge where the
outline is loaded.

**Loading.** Nothing waits on the outlines: not the first paint, not the pin.

- *Ahead of a pin.* Once the map shows a region rather than the country (zoom
  10 and in), the band or two under the view are fetched in idle time, so a
  pin dropped there has its forest at once. A fresh visit looking at all of
  Denmark fetches nothing: every band would be in view, and most visits end
  up in one part of the country.
- *For a pin.* The band for a pin is requested when the pin is set (or
  restored), if it is not there already.
- *While it is on its way* the chip stays neutral ("Nål på kortet") and the
  forest card is shown saying it is looking ("Finder skoven ved nålen …"). No
  forest is named from the forest points meanwhile, so no name is shown and
  then taken back.
- *Only when the file has failed* do the forest points decide: a fetch that
  fails outright twice in a row (it is tried once more after half a second),
  a file whose stamp does not match, or one that has not arrived within 10 s
  (`OUTLINE_TIMEOUT_MS`), so a request that never answers cannot leave the
  card looking for good. An answer that turns up after the time limit is
  dropped. A later pin asks for the band again.

**On the map.** The outline of the forest at the pin, which is also the forest
just chosen from the list, is drawn as a soft fill and a line with a halo,
directly above the basemap and so beneath the conditions surface, the finds
and all markers. It goes when the pin is cleared or leaves the forest.

The camera depends on how the forest was chosen:

- *By name* (a search field, the start screen, the "nearest forest"
  shortcut): the whole outline is brought into view, never closer than a
  flight to the forest's point would go. Inside a large forest the fill alone
  says little; the boundary says where the pin is.
- *From the result list*: the camera stays where the results were framed when
  the forest is in view, and otherwise flies to it at the current zoom, so
  the other results and their numbers stay on the map. The outline is drawn
  either way.
- *Results searched from a forest chosen by name* keep its outline in the
  frame where the map has room for both; where it has not (a very large
  forest on a phone) the results are framed and the outline runs off the
  edge.

**A score of 0.** With the pin's forest known for large forests too, pins far
from any find are common; the card and the list rows then name no "best"
species and say that none of the species has favourable conditions there
today.

## Consequences

- Production gets the outlines only after a deploy run with `forests: refresh`
  (which re-runs the ingest and creates `named_forest_outlines`). Until then the
  manifest carries `forest_outlines: null` and the app behaves as before.
- The first such refresh also reorders `forests.json` (west to east) and moves
  the points of forests whose centroid lay outside them. Nothing depends on the
  order except the outline files, which are written from the same query.
- The outlines are the register's, simplified: a forest's edge on the map can
  be up to 25 m off, and the register's own boundaries are not a survey of
  where trees stand. The 125 m margin is deliberately several times the
  simplification tolerance.
- The polygons are the extents of named places, not of tree cover: they take
  in lakes, fields and clearings, and a forest's own point can fall on one
  (Rold Skov's has been seen in Store Økssø). Nothing here can tell without a
  water layer, and none is published.
- "Smallest containing forest" uses the register's area. Where two overlapping
  forests have nearly the same area the choice between them is arbitrary but
  stable.
- A forest with no usable polygon keeps its slot (null) and can only be found
  through the fallback rule; the current pull has none.
- The row scores in the forest ranking are still worked out at the forest's
  point, which is now inside the forest for every forest.
