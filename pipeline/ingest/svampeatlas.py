"""Ingest the Svampeatlas Darwin Core archive into DuckDB.

Filters the ~1.3M-row national archive down to georeferenced, date-stamped,
sufficiently precise observations of the MVP target species inside Denmark, and
writes a validation report.

    python -m pipeline.ingest.svampeatlas --archive path/to/dwcarchive.zip

Exits non-zero if a published species (tier ``core`` or ``extra``) ends up with
fewer than MIN_PER_SPECIES observations — that is a blocker, not a warning.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import duckdb

from pipeline.config import DUCKDB_PATH, MAX_COORDINATE_UNCERTAINTY_M, in_denmark
from pipeline.duckload import copy_rows
from pipeline.dwca import DwcArchive
from pipeline.species import TARGET_SPECIES, Species

SOURCE = "svampeatlas"
SPECIES_RANKS = {"sp.", "species"}
MIN_PER_SPECIES = 50


def _name_index() -> dict[str, Species]:
    """Lower-case scientific name (accepted name or synonym) -> Species."""
    index: dict[str, Species] = {}
    for species in TARGET_SPECIES:
        for name in (species["scientific_name"], *species["synonyms"]):
            index[name.lower()] = species
    return index


NAME_INDEX = _name_index()


@dataclass(frozen=True)
class Observation:
    observation_id: str
    scientific_name: str
    observed_on: date
    lon: float
    lat: float
    coordinate_uncertainty_m: float
    recorded_by: str | None
    license: str | None
    source: str = SOURCE


def match_species(scientific_name: str) -> Species | None:
    """Match a DwC scientificName (which usually carries an author) to a target."""
    name = scientific_name.strip().lower()
    if name in NAME_INDEX:
        return NAME_INDEX[name]
    for key, species in NAME_INDEX.items():
        if name.startswith(key + " "):
            return species
    return None


def parse_float(raw: str | None) -> float | None:
    try:
        return float((raw or "").replace(",", ".").strip())
    except ValueError:
        return None


def parse_event_date(raw: str | None) -> date | None:
    """Full ISO date only (start of a range); year- or month-only is rejected."""
    token = (raw or "").strip().split("/", 1)[0].strip()
    if len(token) < 10:
        return None
    try:
        return date.fromisoformat(token[:10])
    except ValueError:
        return None


def classify(record: dict[str, str]) -> tuple[Observation | None, str]:
    """Return (observation, "") when the record is kept, else (None, reason)."""
    species = match_species(record.get("scientificName", ""))
    if species is None:
        return None, "not a target species"

    rank = (record.get("taxonRank") or "").strip().lower()
    if rank and rank not in SPECIES_RANKS:
        return None, f"rank {rank!r}"

    if record.get("informationWithheld") or record.get("dataGeneralizations"):
        return None, "withheld/generalized"

    lon = parse_float(record.get("decimalLongitude"))
    lat = parse_float(record.get("decimalLatitude"))
    if lon is None or lat is None:
        return None, "no coordinates"
    if not in_denmark(lon, lat):
        return None, "outside Denmark"

    uncertainty = parse_float(record.get("coordinateUncertaintyInMeters"))
    if uncertainty is None:
        return None, "no coordinate uncertainty"
    if uncertainty > MAX_COORDINATE_UNCERTAINTY_M:
        return None, "coordinate uncertainty too high"

    observed_on = parse_event_date(record.get("eventDate"))
    if observed_on is None:
        return None, "no usable date"

    observation_id = record.get("occurrenceID") or record.get("_id")
    if not observation_id:
        return None, "no id"

    return (
        Observation(
            observation_id=observation_id,
            scientific_name=species["scientific_name"],
            observed_on=observed_on,
            lon=lon,
            lat=lat,
            coordinate_uncertainty_m=uncertainty,
            recorded_by=record.get("recordedBy") or None,
            license=record.get("license") or None,
        ),
        "",
    )


_SCHEMA = [
    "DROP TABLE IF EXISTS observations",
    "DROP TABLE IF EXISTS species",
    """CREATE TABLE species (
        scientific_name  TEXT PRIMARY KEY,
        danish_name      TEXT NOT NULL,
        gbif_usage_key   BIGINT,
        species_group    TEXT NOT NULL,
        tier             TEXT NOT NULL,
        lookalike_risk   TEXT NOT NULL
    )""",
    """CREATE TABLE observations (
        observation_id            TEXT PRIMARY KEY,
        scientific_name           TEXT NOT NULL REFERENCES species(scientific_name),
        observed_on               DATE NOT NULL,
        lon                       DOUBLE NOT NULL,
        lat                       DOUBLE NOT NULL,
        coordinate_uncertainty_m  DOUBLE NOT NULL,
        recorded_by               TEXT,
        license                   TEXT,
        source                    TEXT NOT NULL
    )""",
]


_SPECIES_COLUMNS = (
    "scientific_name",
    "danish_name",
    "gbif_usage_key",
    "species_group",
    "tier",
    "lookalike_risk",
)
_OBSERVATION_COLUMNS = (
    "observation_id",
    "scientific_name",
    "observed_on",
    "lon",
    "lat",
    "coordinate_uncertainty_m",
    "recorded_by",
    "license",
    "source",
)


def load(observations: list[Observation], db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(db_path))
    try:
        for statement in _SCHEMA:
            con.execute(statement)
        copy_rows(
            con,
            "species",
            _SPECIES_COLUMNS,
            (
                (
                    s["scientific_name"],
                    s["danish_name"],
                    s["gbif_usage_key"],
                    s["group"],
                    s["tier"],
                    s["lookalike_risk"],
                )
                for s in TARGET_SPECIES
            ),
        )
        copy_rows(
            con,
            "observations",
            _OBSERVATION_COLUMNS,
            (
                (
                    o.observation_id,
                    o.scientific_name,
                    o.observed_on,
                    o.lon,
                    o.lat,
                    o.coordinate_uncertainty_m,
                    o.recorded_by,
                    o.license,
                    o.source,
                )
                for o in observations
            ),
        )
    finally:
        con.close()


def _percentile(sorted_values: list[float], p: float) -> float | None:
    if not sorted_values:
        return None
    return sorted_values[min(len(sorted_values) - 1, int(p * len(sorted_values)))]


def build_report(
    kept: list[Observation], rejected: Counter[str], rows_scanned: int, db_path: Path
) -> dict:
    by_species = Counter(o.scientific_name for o in kept)
    by_year = Counter(o.observed_on.year for o in kept)
    uncertainty = sorted(o.coordinate_uncertainty_m for o in kept)
    below_min = [
        s["scientific_name"]
        for s in TARGET_SPECIES
        if s["tier"] in ("core", "extra") and by_species[s["scientific_name"]] < MIN_PER_SPECIES
    ]
    return {
        "source": SOURCE,
        "rows_scanned": rows_scanned,
        "kept": len(kept),
        "rejected_total": sum(rejected.values()),
        "rejected_by_reason": dict(rejected.most_common()),
        "kept_by_species": {
            s["scientific_name"]: by_species[s["scientific_name"]] for s in TARGET_SPECIES
        },
        "kept_by_year": {str(y): c for y, c in sorted(by_year.items())},
        "coordinate_uncertainty_m": {
            "p50": _percentile(uncertainty, 0.5),
            "p90": _percentile(uncertainty, 0.9),
            "p99": _percentile(uncertainty, 0.99),
            "max": uncertainty[-1] if uncertainty else None,
        },
        "species_below_min": below_min,
        "db_path": str(db_path),
    }


def run(archive_path: str | Path, db_path: str | Path = DUCKDB_PATH) -> dict:
    db_path = Path(db_path)
    kept: dict[str, Observation] = {}
    rejected: Counter[str] = Counter()
    rows_scanned = 0

    with DwcArchive(archive_path) as archive:
        for record in archive.iter_core():
            rows_scanned += 1
            observation, reason = classify(record)
            if observation is None:
                rejected[reason] += 1
            else:
                kept[observation.observation_id] = observation  # last write wins on dup id
            if rows_scanned % 200_000 == 0:
                print(f"  ...{rows_scanned:,} rows scanned, {len(kept):,} kept")

    observations = list(kept.values())
    load(observations, db_path)
    return build_report(observations, rejected, rows_scanned, db_path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingest the Svampeatlas DwC archive.")
    parser.add_argument("--archive", type=Path, required=True, help="path to dwcarchive.zip")
    parser.add_argument("--db", type=Path, default=DUCKDB_PATH, help=f"DuckDB path [{DUCKDB_PATH}]")
    parser.add_argument("--report", type=Path, help="also write the validation report here as JSON")
    args = parser.parse_args()

    report = run(args.archive, args.db)
    text = json.dumps(report, indent=2, ensure_ascii=False, default=str)
    print(text)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(text, encoding="utf-8")

    if report["species_below_min"]:
        raise SystemExit(
            f"FAIL: published species below {MIN_PER_SPECIES} observations: "
            f"{report['species_below_min']}"
        )


if __name__ == "__main__":
    main()
