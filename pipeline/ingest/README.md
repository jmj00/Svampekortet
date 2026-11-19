# pipeline/ingest

Turns a raw source into clean rows in the DuckDB build database (`build/svampekortet.duckdb`).

## svampeatlas

```sh
python -m pipeline.ingest.svampeatlas --archive path\to\dwcarchive.zip --report build\svampeatlas_report.json
```

Reads the Svampeatlas Darwin Core archive and keeps only observations that are:

- one of the MVP target species (`pipeline/species.py`), accepted name or synonym, species rank;
- inside the Denmark bounding box (`pipeline/config.py`);
- georeferenced, with `coordinateUncertaintyInMeters` present and ≤ 5 km;
- carrying a full ISO `eventDate`;
- not flagged `informationWithheld` / `dataGeneralizations`.

Output tables: `species` (from `pipeline/species.py`) and `observations`. The run
prints a validation report and **exits non-zero if a core species has fewer than
50 observations**.

Get the archive: `https://svampe.databasen.org/dwc/dwcarchive.zip` (a few hundred MB).

## dmi

```sh
python -m pipeline.ingest.dmi --from-year 2011 --to-year 2026 --report build\dmi_report.json
```

Pulls the DMI 10 km climate grid (daily `mean_temp` and `acc_precip`) over the
Denmark bounding box into `weather_daily` (`cell_id, date, parameter, value,
cell_lon, cell_lat`). No API key. `--from-year` defaults to 2011 — the 10 km grid
has no earlier history.

Each year is deleted and re-loaded, with progress printed per parameter-year, so
a run can be **resumed** by re-running with a narrower `--from-year`. `--fresh`
drops the whole table first. The time is all network — roughly 3 minutes per two
years (~25 min for 2011–now); the DB write itself is a fast `COPY`.

## redlist

```sh
python -m pipeline.ingest.redlist --report build\redlist_report.json
```

Pulls the Danish Red List (fungi, 2019 round) into a `redlist` table
(`scientific_name, vernacular_name, category, hidden, taxon_id, arter_dk_id`) and
**exits non-zero if any MVP target species is in the hide-set** (RE/CR/EN/VU/NT).
No API key.
