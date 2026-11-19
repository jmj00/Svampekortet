# 22. The Back button, and towns in the place search

Date: 2026-11-19

## Status

Accepted. Builds on [ADR-0015](0015-migrate-off-dawa.md) (Adressevælgeren
replaced DAWA) and the start screen.

## Context

Two leftovers from the start screen's review.

**Back left the site.** The app pushed no history entries. On Android, Back
from a step of the start screen, or from an open species page, left the site;
iOS Safari's edge swipe did the same.

**The address search ranked badly and knew no towns.** "Vestergade 10
Silkeborg" suggested København K first, and a town typed alone ("Silkeborg",
"Rold") found nothing. Adressevælgeren has no public documentation, so what
it does was found by sending it real requests (2026-11-19):

- `/soeg?tekst=` returns up to 100 hits of three kinds: `vejnavn` (a street
  name), `navngivenvejpostnummer` (a street in a postal district) and
  `husnummer` (an address). They come sorted by postal number, not by how well
  they match, which is why København K came first. Spelling is matched
  phonetically ("Vestregade" finds Vestergade).
- A postal number after the address in the text ("Vestergade 10, 8600")
  narrows the answer to that district. A town name in the text does not
  ("Vestergade 10 Silkeborg" gives the same 100 hits as "Vestergade 10", and
  Silkeborg is not among them). "Vestergade, Silkeborg" finds nothing.
- The only filter parameter that works is `kommunekode` (four digits, comma
  separated). `postnummer` is checked for four characters and then ignored.
  No other parameter changes the answer.
- There are no towns, postal districts or place names in the service. No
  other endpoints exist besides lookups by id, and `/husnumre?id_lokalids=a,b`
  looks up several addresses in one request.

## Decision

### Back and Forward (`web/src/nav.ts`)

Three things get a history entry, each with `history.pushState`:

1. a step of the start screen (place or species), over its home view;
2. the start screen opened from the map (a home button), over the map;
3. a species page, over the species list.

Back takes away the top one. The app's own back buttons ("Forside", "Alle
svampe", "Tilbage til kortet", Escape) go back through the same entry rather
than adding another, so Back and the buttons never disagree and Forward still
works.

Leaving the start screen for the map keeps a start screen that the page opened
on behind the map. A fresh visit then goes start → map → (Back) start →
(Back) away. A start screen opened from the map is not kept: going on into the
map returns to the map's entry, so the map is not in the history twice. A
species chosen in the start screen's picker lands as list + page, so Back goes
page → list → start screen.

A modal dialog (About, the photo viewer, any native `<dialog>` shown with
`showModal`) also gets an entry of its own, over whatever it lies on. Back
closes the dialog and nothing else; a second Back then does what it did
before. Closing it with its own button, Escape, the backdrop or a phone's own
Back (Chrome closes a modal dialog itself) goes back through its entry, so
none is left behind. Forward or a reload onto such an entry, with no dialog
to bring back, steps back off it.

The following get no entry:

- **The map itself:** the pin, the camera and the find card.
- **The phone sheet's height.**
- **The Svampe/Skove tabs.** They are two views of one place, one tap apart.
  A tab in the history would make Back flip between them instead of leaving,
  which no map app does.
- **The forest list.** It is part of the Skove tab and goes with it.

The address is never changed, so `?kort` and reload keep working. Each entry's
state carries the whole stack of snapshots up to it. After a reload the app
shows what the reloaded entry showed (a step, a species page) and knows what
lies behind it. A step back of the app's own that never lands (a stale state)
gives up after 1.5 s and rewrites the entry.

The logic is a pure function, `plan(stack, next)`, plus a small controller
over a `HistoryLike`. Both are tested with a fake history.

### Towns and postal numbers in the place search

- **The app carries its own list** (`web/src/data/places.json`, 440 kB, about
  140 kB gzipped). It is fetched the first time a place search runs, as a
  hashed build asset the service worker caches.
  - Towns, villages, parts of towns and holiday-home areas come from Danske
    Stednavne `sn:Bebyggelse` (types `by`, `bydel`, `sommerhusområde`; 10,528
    places). Each has a point inside it and its size.
  - The 1,089 postal districts come from DAGI `dagi10:Postnummerinddeling`,
    with their extent, and each town is put in the district its point lies in.
  - `web/scripts/gen-places.mjs` builds the list by hand: Stednavne has been
    frozen since 2025-09, and postal districts change a few times a year. Both
    services answer the web's own Datafordeler API-Key, so no pipeline
    credentials are involved.
- **A town or postal district is a suggestion of its own**, with a town icon.
  Forests and towns are listed together by how well the name matches: the
  name itself first, then names that begin with what is typed, then names
  that only contain it ("Troldbjerg" for "rold"); a forest before a town of
  the same rank, and all of them before the addresses. So "Rold" lists the
  village and Rold Skov first, "København" the city above Københavnerskoven,
  and "Rold Skov" the forest first. No two suggestions read the same: a
  second town of a name, or one that shares a forest's name, says its postal
  district ("Frederiksberg · 4180 Sorø"); only the city keeps its bare name.
  A query that is just a town's or a district's name asks the address
  service nothing: it would only answer with streets that sound alike.
  - "Silkeborg" gives the town, "8600" gives the district, and "Rold" gives
    Rold Skov (the forest), then the village of Rold.
  - Choosing one sets the pin there and flies to a zoom that fits its size.
    The pin is named after the town ("Rold").
  - A city is shown by its name alone, because its middle can lie in any of
    its districts (Aarhus's lies in 8230 Åbyhøj). A smaller town is shown with
    its district ("Rold · 9510 Arden").
- **A town or postal number after an address is turned into the form the
  service filters on** (`parseAddressQuery`).
  - "Vestergade 10 Silkeborg" → "Vestergade 10, 8600". "Vestergade 10, 8600
    Silkeborg" is read the same way, and "Vestergade 10 Silkebrg" (one slip)
    too.
  - A city of up to ten postal numbers is searched in each, in parallel
    (Aarhus C, N and V). København and Frederiksberg have one postal number
    for every few streets (387 and 106), so they are searched as typed and the
    hits in their districts are put first. Those numbers are the lowest, so
    they are within the service's 100.
  - A town that is not a postal district's name counts only after a comma or
    a house number ("Hovedvejen 3 Rold"). This keeps a street or forest name
    ending in a town's name from being cut in two ("Rold Skov").
  - When the narrowed search finds nothing, the street is searched
    nationwide, the town itself is listed first, and a line above the
    addresses says so: "Ingen Hovedgaden 1 i Rold – adresser andre steder:".
- **A forest with a town** ("Vesterskov Silkeborg") lists the forests of
  that name within 20 km of the town, the name itself first and then the
  nearest, each with how far it is ("Vesterskov · 5 km fra Silkeborg"), since
  many forests share a name. Without a town, the largest forest of a name
  stands for it, as before.
- **The lookups are one request** (`/husnumre?id_lokalids=`) instead of one per
  address.
- **Only the typed text, and the ids it found, go to the service.** The browser
  check asserts this on every request.

## Consequences

- Back does what a map app's Back does. The one place it differs from a
  website is that it never goes to an earlier map position.
- A town search works without the address service. When the service is down,
  towns and forests still show, and the message says only addresses are
  missing.
- The town list is a file in the repository, built 2026-11-19, that has to
  be rebuilt by hand, at least once a year (postal districts change a few
  times a year). Running `node web/scripts/gen-places.mjs`
  takes about two minutes.
- Without a town in the query, addresses still come in the service's postal
  number order. Ranking them by the map's view would need every hit looked
  up, and was not done.
