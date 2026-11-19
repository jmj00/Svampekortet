# Data sources — access, terms, validity

Living document. Fill in the blanks as the Phase 0 spikes produce answers.
Nothing gets built on a source until its row here is complete.

## Summary

| Source | Access route | Auth | Status |
|---|---|---|---|
| Svampeatlas / Atlas of Danish Fungi | GBIF occurrence API (dataset `84d26682-f762-11e1-a439-00145eb45e9a`); Darwin Core archive `https://svampe.databasen.org/dwc/dwcarchive.zip` | none | **verified — primary source** |
| arter.dk / Danmarks Miljoeportal | GBIF (dataset `963a6b96-4d22-4428-86e4-afee52cf4a8e`); DwC archive `https://arter.dk/dwccontainer/occurrence_dwc_archive.zip`; partner API (OAuth2) later | none (archive) | **verified — minor supplement, deferred to Phase 3 (ADR-0004)** |
| DMI Open Data — Climate Data API | `https://opendataapi.dmi.dk/v2/climateData/` | none since 2025-12-02 | **verified** |
| Den Danske Rødliste — DCE / Aarhus University | `https://api.redlist.au.dk/public/v1/summary/assessments/?vurderingsrunde=2019&speciesGroup=Svampe` | none | **wired — `pipeline.ingest.redlist` (loads `redlist`, guards target species)** |
| Adressevælgeren — address search | `https://adressevaelger.dk/soeg` (phonetic search) + `.../husnumre/{id}` (lookup, coordinates in EPSG:25832) | API-Key (free) | **verified — wired in `web/src/addresses.ts`** (replaced DAWA, ADR-0015) |
| Skærmkort basemap | Datafordeler WMS `https://wms.datafordeler.dk/Dkskaermkort/topo_skaermkort/1.0.0/wms`, layer `dtk_skaermkort` (EPSG:3857) | API-Key (free) | **verified — wired in `web/src/map.ts`** (replaced DAWA's `api.dataforsyningen.dk/topo_skaermkort_DAF`, ADR-0015) |
| GeoDanmark Vektor (forest polygons, unnamed) | Datafordeler WMS `https://wms.datafordeler.dk/GeoDanmarkVektor/GeoDanmark_60_NOHIST/1.0.0/WMS`, layer `SKOV`, `GetFeatureInfo` point-probe (its WFS is currently down — 503 on every path tried) | OAuth Shared Secret (client_credentials, free) | **verified, built (`pipeline.ingest.geodanmark`), but superseded for "forests near me" by Danske Stednavne below (ADR-0014) — kept as an option for later comprehensive land-cover work** |
| Danske Stednavne (named forests) | Datafordeler WFS `https://wfs.datafordeler.dk/Stednavn/STEDNAVNE_BEARBEJDET_GML3SFP/1/WFS`, feature type `sn:Naturareal`, `CQL_FILTER=naturarealtype='skovPlantage'` — **note: this WFS's `EPSG:4326` responses use lat,lon axis order**, the opposite of this codebase's `[lon, lat]` convention | OAuth Shared Secret (same as GeoDanmark; client_credentials, free) | **verified — wired in `pipeline.ingest.stednavne`, 5,795 named forests.** Register itself frozen since 2025-09 (not this session's finding — a standing upstream data freeze); irrelevant at forest-boundary timescales. |
| CORINE Land Cover 2018 (forest type: broadleaf/coniferous/mixed) | EU/Copernicus via EEA's public ArcGIS REST, `https://image.discomap.eea.europa.eu/arcgis/rest/services/Corine/CLC2018_WM/MapServer/0/query`, `Code_18 IN ('311','312','313')` | none | **verified — wired in `pipeline.ingest.biotope`, advisory only (ADR-0016)** |
| GEUS Jordartskort 1:200,000 (soil type) | `https://data.geus.dk/arcgis/rest/services/Denmark/Jordartskort_200000/MapServer/1/query`, field `tsym` — a separate public GEUS service, unrelated to Datafordeler entirely | none | **verified — wired in `pipeline.ingest.biotope`, advisory only (ADR-0016)** |

## Questions to answer in the spike

### Observation data (GBIF + Darwin Core archives)

- [x] Records per target species in Jutland, total and per year — all 6 core species have 336–1863 georeferenced records since 2016 (GBIF spike).
- [x] Per-month distribution matches the known fruiting season (Jul–Oct peak).
- [x] Split by source — Svampeatlas dominates (20,664 target-species rows in its archive vs 161 in arter.dk's). ~10% of GBIF hits come from other datasets → a dedup / source-priority step is needed.
- [~] `coordinateUncertaintyInMeters` — 100% populated (Svampeatlas) / 97.3% (arter.dk), but the inspector could not parse the values numerically. Format (comma decimals? sentinel?) still to be characterised on ingest.
- [x] Licence — **Svampeatlas: 100% `CC BY-NC 4.0`**. **arter.dk: dataset-level `CC BY 4.0`** for observation data (the `license` column is blank in the archive but the GBIF dataset and om.arter.dk/regler-og-vilkar §3.4 confirm CC BY, commercial use allowed with attribution). Species descriptions in Artsbogen and photos have their own terms — see the arter.dk findings block.
- [x] Sensitive taxa — Svampeatlas archive carries **no** `informationWithheld` / `dataGeneralizations` values (sensitive records appear to be withheld or pre-generalised upstream). arter.dk flags **7,887 rows `informationWithheld = "Occurrence blurred"`**. Authoritative red list comes from the DCE/AU Red List API (ADR-0005); categories **RE/CR/EN/VU/NT** hide a species (637 of 3,303 assessed fungi, ~19%). DD is shown.
- [x] Datum — Svampeatlas `WGS84`, arter.dk `EPSG:4326` (same). No reprojection needed on ingest.
- [x] `vernacularName` — 95.9% / 96.3% populated. Svampeatlas is the source of truth for the Danish name. Corrections applied: *Suillus luteus* = "Brungul Slimrørhat" (not "Almindelig Smørrørhat"), *Suillus variegatus* = "Broget Slimrørhat" (not "Sand-Rørhat"). Only the original 6 core names carry `danish_name_verified: true`; every species added since (batches through 2026-09) is `danish_name_verified: false` pending an archive check — a standing follow-up before public launch.
- [ ] Image URLs — the Svampeatlas archive has `references` (100%) but no `associatedMedia` column; media handling still to be worked out. The app uses hand-curated images (`scripts/pull_species_images.py`, iNaturalist Research-Grade CC0/CC BY) per core species regardless.

### Weather (DMI)

- [x] `opendataapi.dmi.dk` needs no auth. No published rate limits; client throttled to ~2 req/s to be polite.
- [x] `parameterId` — `mean_temp` and `acc_precip` confirmed working at `timeResolution=day`. Full list in the DMI docs; evaporation/humidity/sunshine also available.
- [x] `cellId` format for the 10 km grid is like `10km_621_52`. `bbox` (lon/lat) filtering works.
- [x] Daily-data history depth — the 10 km grid starts **2011** (2009–2010 return nothing). ~8,000 of 11,843 observations get a full antecedent-weather window; the rest predate 2011. 1991–2020 normals not yet checked (Phase 3 model input).
- [x] DMI's standalone drought index is **not** in the Climate Data API — derive an antecedent-precipitation / water-balance term from `acc_precip` + `mean_temp`.

### SDFI / maps

> **DAWA (`api.dataforsyningen.dk`) shut down permanently on 2026-10-01.**
> Found 2026-09-11 while investigating forest-name sources (ADR-0014) — this
> was the host behind **both** the app's address search and its basemap, so
> it was a real production risk, not just a forest-feature concern. Resolved
> in [ADR-0015](adr/0015-migrate-off-dawa.md): both migrated to Datafordeler
> (`web/src/addresses.ts`, `web/src/map.ts`), authenticated with a plain
> API-Key (`VITE_DATAFORDELER_API_KEY`) rather than the pipeline's OAuth
> Shared Secret, since only the former is safe to ship in client code.
- [x] DAWA address autocomplete worked with no token and returned WGS84 coordinates (web spike, historical — DAWA is gone). Its replacement, Adressevælgeren, needs an API-Key and a two-step search-then-lookup flow instead (ADR-0015); lookup coordinates come back in EPSG:25832, converted client-side.
- [x] Basemap: Dataforsyningen's Skærmkort **WMTS is UTM32N (EPSG:25832) only** — no Web Mercator, so it does not fit MapLibre. The **WMS** advertises EPSG:3857 and reprojects on the fly, so we use that as a MapLibre raster source with the `{bbox-epsg-3857}` token. Now served from `wms.datafordeler.dk` (ADR-0015) rather than the retired `api.dataforsyningen.dk`, same layer name `dtk_skaermkort`. API-Key in `web/.env.local`; falls back to OpenStreetMap without one.
- [x] Forest / land-cover layer for "forests near me" (not a model input yet — see
  [ADR-0013](adr/0013-forests-near-me-geodanmark-point-grid.md) and
  [ADR-0014](adr/0014-named-forests-stednavne-and-score-ranking.md), which
  supersedes it). Three Danish candidates were tried first and each hit a wall
  from this environment: Dataforsyningen's legacy GeoDanmark WFS 500s
  ("workhorses exhausted", likely deprecated), Datafordeler's own GeoDanmark
  Vektor WFS is currently down (503 on every path, auth included), and
  Miljøportalen's Arealdata (§3 nature types) exposes only its Vue frontend, no
  reachable API. GeoDanmark Vektor's **WMS** works via OAuth Shared Secret
  (`DATAFORDELER_CLIENT_ID`/`SECRET`, a different auth product from the
  basemap's plain `token=` query param) and `pipeline.ingest.geodanmark`
  point-samples its `SKOV` layer over a grid — but that source carries no
  forest *name*. **Danske Stednavne's WFS, by contrast, works outright** and
  gives named forest polygons directly (`pipeline.ingest.stednavne`,
  `naturarealtype='skovPlantage'`, 5,795 found) — see the new source row above
  and ADR-0014; this is what's actually wired into "forests near me" now. The
  polygons themselves are kept too, simplified, since
  [ADR-0020](adr/0020-forest-outlines-for-the-pin.md): the app uses them to
  tell which forest a pin is inside and to draw that forest on the map.
  Soil/geology (GEUS Jordartskort) and CORINE Land Cover (EU/Copernicus,
  coarser 25 ha MMU but a confirmed-working fallback if Datafordeler becomes
  unusable) were scoped but not wired — deferred with the biotope/geology
  model-signal question.

## Findings

### Svampeatlas Darwin Core archive (`dwcarchive.zip`) — 1,307,858 rows, 36 cols

- License: **`CC BY-NC 4.0` on every row.** Fine for a free public project with
  attribution; **blocks commercial use without a separate agreement with the
  Danish Mycological Society / Svampeatlas.**
- `geodeticDatum`: `WGS84` (100%). `decimalLatitude`/`Longitude`: 100%.
- `informationWithheld` / `dataGeneralizations`: **empty** — no per-record
  obfuscation flags in the public archive.
- `vernacularName`: 95.9%. Target-species Danish names (canonical):
  Cantharellus cibarius → almindelig kantarel; Craterellus tubaeformis →
  tragt-kantarel; Boletus edulis → spiselig rørhat / Karl Johan; Imleria badia →
  brunstokket rørhat; Suillus luteus → **brungul slimrørhat**; Suillus variegatus
  → **broget slimrørhat**.
- `taxonRank` uses an abbreviated vocab (`sp.`, `var.`, `gen.`, `superspecies`, …);
  needs normalising. `scientificNameID` present 100% (alternative join key).
- 20,664 rows for the 6 core species.

**Ingest yield** (`pipeline.ingest.svampeatlas`, species rank + full ISO date +
coordinate uncertainty ≤ 5 km). Last Jutland-only build, **11,843 observations
kept** — Boletus edulis 3013, Imleria badia 3101, Cantharellus cibarius 2471,
Craterellus tubaeformis 1510, Suillus luteus 1127, Suillus variegatus 621.
Kept-record uncertainty p50 50 m / p90 250 m / p99 2.5 km. Data spans 1910–2026.
The study area is now all of Denmark ([ADR-0010](adr/0010-expand-study-area-to-denmark.md)),
so these counts rise on the next full build.
*Neoboletus praestigiator* returns 0 — the archive files it under a name not yet
in our synonym list; non-core, to chase when the species set grows.

### arter.dk Darwin Core archive (`occurrence_dwc_archive.zip`) — 1,048,843 rows, 40 cols

- License: **column blank in the archive; dataset-level `CC BY 4.0` on GBIF**
  (DOI 10.15468/q3yy4u). Per om.arter.dk/regler-og-vilkar (27 Jun 2024):
  - **Observation / find data** (location, date, taxon, notes): `CC BY`,
    **commercial use permitted** with the credit line
    `Datagrundlag: Arter – Miljøstyrelsen, Statens Naturhistoriske Museum / Licens CC-BY`.
  - **Species descriptions (Artsbogen) and the help/blog pages**: `CC BY-NC 4.0`.
  - **Photos / audio / video**: a per-photographer CC choice (CC0 / CC-BY /
    CC-BY-NC / "no licence"); copyright stays with the photographer; higher-res
    needs the photographer's permission.
  - Records re-exhibited from other databases (iNaturalist, DOFbasen, Atlas Flora
    Danica, …) keep the originating database's terms and must be credited
    separately; the source is in the `Systemoprindelse` / system-origin column.
  - Publisher is now "Styrelsen for Grøn Arealomlægning og Vandmiljø (SGAV)"
    (formerly Miljøstyrelsen).
- `geodeticDatum`: `EPSG:4326` (100%).
- `informationWithheld`: `"Occurrence blurred"` on 7,887 rows → the obfuscation
  flag to filter on. Ingest rule: blurred → coarse-only or exclude. Terms §4.1:
  the true position is retained upstream for experts/managers, not in the export.
- `taxonRank` uses full words (`species`, `genus`, …) — different vocab from
  Svampeatlas. Has a full `phylum`…`genus` hierarchy.
- Only 161 rows for the 6 core species → optional supplement; MVP ships
  Svampeatlas-only (ADR-0004).

### Open items

- Characterise `coordinateUncertaintyInMeters` value format (fix in `dwca_inspect`,
  re-run for the percentiles — matters for the habitat-kernel bandwidth).
- ~~Obtain the Danish fungi red list.~~ Done — DCE / AU Red List API (ADR-0005),
  now `pipeline.ingest.redlist` (`speciesGroup=Svampe`): 3,303 fungal assessments
  in the 2019 round; 637 hidden under RE/CR/EN/VU/NT. The guard runs against every
  `TARGET_SPECIES` (48 published + hidden) and exits non-zero if any is in the
  hide-set — as of the 2026-09 batches all published species are LC or not
  assessed. *Grifola frondosa*, both *Gyroporus* and *Hericium coralloides* were
  dropped from candidate batches because they are VU/NT.
- ~~Confirm arter.dk licence terms.~~ Done — see the arter.dk findings block above.
- DMI 1991–2020 climate normals (Phase 3 model input).

## Licensing decisions

- Internal taxon id: GBIF Backbone `usageKey`. See `docs/adr/0003-species-name-resolution.md`.
- Store the per-record `license` on every observation from day one (Svampeatlas is
  uniformly `CC BY-NC 4.0`; arter.dk observation data is `CC BY 4.0`).
- **The whole project is non-commercial by default** because of the Svampeatlas
  `CC BY-NC 4.0` terms, and Svampeatlas is the sole MVP source. A commercial
  version would need a data agreement with the Danish Mycological Society. This is
  the concrete monetisation roadblock. (arter.dk observation data would *not* be a
  blocker — it permits commercial use — but it is deferred to Phase 3.)
- Required attribution strings:
  - Svampeatlas: *"Atlas of Danish Fungi / Danmarks Svampeatlas, Danish
    Mycological Society"* + `CC BY-NC 4.0` link.
  - arter.dk: *"Datagrundlag: Arter – Miljøstyrelsen, Statens Naturhistoriske
    Museum / Licens CC-BY"* + credit any `Systemoprindelse` sub-sources.
  - Basemap: *"Kort: GeoDanmark (CC BY 4.0), Datafordeler"* — `CC BY 4.0`
    (GeoDanmark), commercial use allowed. Shown in the MapLibre attribution
    control now; also needs an in-app **"Om data"** screen listing every source
    and licence (Dataforsyningen policy explicitly asks for this for apps).
  - Forest points ("forests near me"): *"Danske Stednavne, Klimadatastyrelsen
    (CC BY 4.0)"* — Klimadatastyrelsen (formerly SDFI, same body behind
    GeoDanmark) has used `CC BY 4.0` on its free geographic data since
    2024-05-16.
  - DMI: free open data, attribution "Data: DMI (frie data)".
  - Danish Red List: *"Den Danske Rødliste, DCE – Nationalt Center for Miljø og
    Energi, Aarhus Universitet (2019)"*.
- Media + descriptions: hand-curated per core species with explicit per-item
  attribution. No bulk media redistribution until a rights review.
- Published derived data: **CC BY-NC 4.0** (match the most restrictive input) with
  attribution to Atlas of Danish Fungi / Danish Mycological Society, arter.dk /
  Danmarks Miljoeportal, GBIF, DMI, SDFI.

## Sensitive-species handling (implementable)

1. Drop any record with `informationWithheld = "Occurrence blurred"` (arter.dk) or
   any equivalent flag from precise display.
2. Pull the Danish Red List (DCE / AU API, `vurderingsrunde=2019`, group `Svampe`)
   and exclude every species whose `redlistCategory` is **RE, CR, EN, VU or NT**
   from the app entirely, showing a short "sensitive / red-listed — not displayed"
   note. Categories **LC / DD / NA / NE** are shown. See ADR-0005.
3. A verified "scientist" role that can see this data is a post-MVP idea only.
4. Validation gate: publish fails if an observation of a hidden taxon, or a
   blurred record, reaches the published artifacts at any coordinate precision.
