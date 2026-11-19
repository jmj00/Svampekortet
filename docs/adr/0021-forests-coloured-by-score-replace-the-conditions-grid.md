# 21. Forests coloured by score replace the conditions grid

Date: 2026-11-18

## Status

Accepted. Builds on [ADR-0020](0020-forest-outlines-for-the-pin.md) (the forest
outlines) and [ADR-0014](0014-named-forests-stednavne-and-score-ranking.md)
(scoring a named forest). The score itself
([ADR-0006](0006-v0-probability-model.md),
[ADR-0008](0008-geometric-mean-score-combine.md)) is unchanged.

## Context

With a species open and a pin set, the map drew a "conditions surface": an
11 by 11 grid of roughly 1 km squares around the pin, each tinted by the
species' score at its centre, over a wash that muted the basemap, with
hairlines between the squares and a numeral in each. In use it was confusing:
the squares cut across forests, lakes, fields and towns alike, a score was
painted on places nobody picks mushrooms, the wash hid the basemap exactly
where one wanted to read it, and the squares' edges meant nothing on the
ground. The owner's words: "I am not sure if the grid overlay is needed
anymore or if it should be done in another way, as it is somewhat confusing."

Since ADR-0020 the app has every named forest's outline. A forest is a place
one can go to, and the question the grid tried to answer ("where around here
is it good today?") is really a question about forests.

## Decision

**The grid is removed**: the cell fills, the wash, the grid lines, the
numerals, its legend section and the code that computed it (`surface.ts`,
`mapsurface.ts`, their tests, the panel's surface callback, the wash and grid
colours in `palette.ts`). The dashed ring around the pin (how far away finds
count towards the score) stays, now in `pinring.ts`, and the find marks are
untouched. Nothing else depended on the grid: the camera on opening a species
was and is set by the finds (`observations.ts`).

**Forests are coloured instead** (`forestscores.ts`), while a species is open,
a pin is set and the species has a conditions model:

- _Which forests._ Those whose outline's bounding box comes within 10 km of the
  pin, nearest first, at most 120. 10 km is a short drive and about what the
  map shows when a species is opened; the cap bounds the work in the densest
  parts of the country (119 forests at a pin in Gribskov, 85 at Silkeborg).
  Only forests with a loaded outline can be coloured; the outline bands for
  the 10 km box are asked for, and the colours are worked out again when a
  band arrives.
- _Which score._ `scoreForest` from `forests.ts`, the call the forest finder
  uses for a row, with the species set narrowed to the open species: the score
  at the forest's point (a point inside it, ADR-0020). It is one number per
  forest, so a large forest is one colour, and it can differ from the score at
  the pin itself, which the panel shows. The forest's card says so.
- _Classes and colours._ The four classes the grid had (0–29, 30–59, 60–79,
  80+) and its teal ramp, painted straight over the basemap's forest green
  without the wash. The lowest class has no tint, only a thin grey edge: the
  forest was looked at and there is little there today. A forest that scored 0,
  or for which no score could be worked out, is not drawn at all.
- _A day with nothing promising._ Unless at least one forest in reach gets to
  30, none is drawn: a map of thin grey edges alone reads as a parcel map, not
  as conditions. The key then says it in a sentence ("Ingen skove inden for
  10 km har middel eller gode forhold for Tragt-Kantarel i dag.") in place of
  the classes. A forest that is not drawn cannot be tapped: a tap in it is a
  tap on bare map. The pin's own forest keeps its ADR-0020 outline and fill.
  The closed key says it too, in a few words where the ramp chip would be
  ("ingen skove med middel/gode forhold"), so the bare map is explained
  without opening anything. With no forest in reach at all (at sea) both say
  only that: "Ingen skove inden for 10 km."
- _Layers._ One GeoJSON source, a fill and a line layer, directly above the
  basemap: beneath the pin's own forest outline (ADR-0020), the ring, the find
  marks and every DOM marker (the pin, the forest finder's numbered markers).
  Features are ordered largest forest first, so a named part of a larger
  forest lies on top of it and stays visible. While forests are coloured, the
  pin's own forest keeps its line and halo but its soft green fill is switched
  off, so that forest is not tinted twice.
- _Cost._ Worked out after the species page has painted (a timer after the
  conditions card is filled), a few milliseconds at a time with the page given
  a turn in between, and drawn in one go. Scores are kept per species, forest
  and day, so moving the pin a little costs almost nothing. Measured in
  headless Chrome (software GL) on the development machine, cold: Tragt-Kantarel
  (1,510 finds) 49 ms for 85 forests at Silkeborg and 76–124 ms for 119 in
  Gribskov; Brunstokket Rørhat (3,101 finds, the most in the payload)
  112–182 ms and 323–327 ms; 4–27 ms after a small move of the pin. The detail
  view was in the DOM 25 ms and painted about 50 ms after the tap in every
  case, the same with the forest colours switched off.
- _Tapping._ Every tap on the map still sets the pin, as before. Every tap in
  a drawn forest (the smallest one containing the point) says which forest it
  is: its name, its score, the class word ("middel forhold") and one line
  saying whose score it is. With no finds at the tap that is a card of its own
  at the pin, of the find card's kind. If the tap also hit find marks, the
  find card opens as before and the forest's lines are its last part
  (`setFindCardExtra` in `observations.ts`). The first version let the find
  card win outright, which in practice hid the forest's number in exactly the
  forests worth looking at: those are full of find marks, and a finger covers
  several. On a phone the forest is one line right under the find card's
  heading ("Kobskov · 46 · middel forhold"), without the sentence. A card is
  never taller than the free map less the pin it hangs on: what does not fit
  scrolls inside under a heading and close button that stay put, the map is
  nudged so card and pin are both on the free map, and on a phone the closed
  key steps aside while a card is open. A tap on bare map opens nothing. There is no "move the pin here"
  action because the tap has already moved it.
- _The key._ One section, "Forhold i skovene i dag": the four classes as
  swatches painted like the forests, the direction, the ring's note and a hint
  that a tap gives a forest's number. Without outlines to score (files
  missing) the section shrinks to "Omkring nålen" with the ring's note.
  The "Zoom ind til nålen" button stays, now fitting the pin and its
  surroundings when the map is zoomed out past where forests can be told apart.
  Closed, the key's line labels its ramp chip "skovenes forhold", on a second
  line where the finds' marks fill the first. On a phone the key sits above
  the scale bar, its panel is never taller than the room under the search
  field, and with the key open the zoom button goes beside the key's line.

**Fallbacks.** No outlines in the manifest, or the band could not be fetched:
no forests are coloured, nothing is reported as an error to the user, and the
ring and the find marks are as before. No conditions model, or none for the
species: neither colours nor ring. The layers go when the species is closed or
the pin is cleared, and are replaced when the pin moves.

**Not done: colouring forests in the list view.** With no species open, forests
could be coloured by their best score across the filter. It is left off:

- it costs up to 50 times as much per forest (every species in the filter),
  which is why the forest finder scores only 12 candidates;
- it would put a second set of forest scores on the map next to the finder's
  numbered markers, which already say "these are the best forests near you"
  for the same filter, in a different form and for a different set of forests;
- a colour without a species behind it needs explaining ("best of which
  species?") in a key that has no room for it on a phone.

## Consequences

- The map says where it is good in terms of places with names, and nothing is
  painted over towns, fields or water. The basemap stays readable.
- A forest is one number, taken at one point inside it. Within a very large
  forest (Rold Skov, Gribskov) conditions differ from end to end and the
  colour does not show that; the score at the pin, in the panel, does, and
  moving the pin moves it. A finer picture (scoring several points per large
  forest) would be the next step if this proves too coarse.
- Open country far from any named forest shows no conditions on the map at
  all, only in the panel. That is intended.
- A forest whose outline is missing from the payload is never coloured.
- About 550 lines of grid code and tests go; `forestscores.ts`, `pinring.ts` and
  their tests are about 650.
