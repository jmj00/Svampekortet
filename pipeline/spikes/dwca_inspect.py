"""Spike: inspect a downloaded Darwin Core Archive (Svampeatlas or arter.dk).

Download the archive first (these are large -- do it by hand, don't script it yet):

    Svampeatlas: https://svampe.databasen.org/dwc/dwcarchive.zip
    arter.dk:    https://b0410prodmediasto.blob.core.windows.net/dwccontainer/occurrence_dwc_archive.zip

Then:

    py -m pipeline.spikes.dwca_inspect  path\\to\\archive.zip

Reports: core file + columns, per-column fill rate, licence mix, how sensitive
taxa are flagged (informationWithheld / dataGeneralizations), coordinate
uncertainty percentiles, and the Danish names carried for the target species.
"""

from __future__ import annotations

import contextlib
import csv
import sys
import zipfile
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree as ET

from pipeline.species import TARGET_SPECIES
from pipeline.spikes import use_utf8_stdout

DWC_NS = {"d": "http://rs.tdwg.org/dwc/text/"}

INTEREST = {
    "license",
    "rightsHolder",
    "informationWithheld",
    "dataGeneralizations",
    "coordinateUncertaintyInMeters",
    "coordinatePrecision",
    "decimalLatitude",
    "decimalLongitude",
    "geodeticDatum",
    "vernacularName",
    "scientificName",
    "taxonRank",
    "eventDate",
    "associatedMedia",
    "identificationVerificationStatus",
}

TARGET_SCI = tuple(s["scientific_name"].lower() for s in TARGET_SPECIES)


def core_descriptor(zf: zipfile.ZipFile) -> tuple[str, dict[int, str], str, int]:
    root = ET.fromstring(zf.read("meta.xml"))
    core = root.find("d:core", DWC_NS)
    if core is None:
        raise SystemExit("meta.xml has no <core> element")
    location = core.find("d:files/d:location", DWC_NS).text.strip()

    fields: dict[int, str] = {}
    id_el = core.find("d:id", DWC_NS)
    if id_el is not None and id_el.get("index") is not None:
        fields[int(id_el.get("index"))] = "_id"
    for field in core.findall("d:field", DWC_NS):
        idx = field.get("index")
        if idx is None:
            continue
        term = field.get("term", "").rsplit("/", 1)[-1]
        fields[int(idx)] = term

    raw_delim = core.get("fieldsTerminatedBy", "\\t")
    delim = raw_delim.encode().decode("unicode_escape") or "\t"
    skip = int(core.get("ignoreHeaderLines", "0"))
    return location, fields, delim, skip


def percentile(values: list[float], p: float) -> float:
    if not values:
        return float("nan")
    k = min(len(values) - 1, int(p * len(values)))
    return sorted(values)[k]


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(1)

    use_utf8_stdout()
    path = Path(sys.argv[1])
    if not path.exists():
        raise SystemExit(f"no such file: {path}")

    with zipfile.ZipFile(path) as zf:
        location, fields, delim, skip = core_descriptor(zf)
        print(f"archive:   {path.name}")
        print(f"core file: {location}")
        print(f"columns:   {len(fields)}  delimiter={delim!r}  skip_header_lines={skip}")

        rows = 0
        fill: Counter[str] = Counter()
        licenses: Counter[str] = Counter()
        withheld: Counter[str] = Counter()
        generalized: Counter[str] = Counter()
        ranks: Counter[str] = Counter()
        datums: Counter[str] = Counter()
        coord_unc: list[float] = []
        vernacular_for_targets: dict[str, str] = {}
        target_hits = 0

        with zf.open(location) as raw:
            reader = csv.reader((line.decode("utf-8", "replace") for line in raw), delimiter=delim)
            for _ in range(skip):
                next(reader, None)
            for row in reader:
                rows += 1
                rec = {fields[i]: v for i, v in enumerate(row) if i in fields}
                for name, value in rec.items():
                    if value:
                        fill[name] += 1
                if rec.get("license"):
                    licenses[rec["license"]] += 1
                if rec.get("informationWithheld"):
                    withheld[rec["informationWithheld"]] += 1
                if rec.get("dataGeneralizations"):
                    generalized[rec["dataGeneralizations"]] += 1
                if rec.get("taxonRank"):
                    ranks[rec["taxonRank"].lower()] += 1
                if rec.get("geodeticDatum"):
                    datums[rec["geodeticDatum"]] += 1
                cu = rec.get("coordinateUncertaintyInMeters")
                if cu:
                    with contextlib.suppress(ValueError):
                        coord_unc.append(float(cu.replace(",", ".").strip()))
                sci = (rec.get("scientificName") or "").lower()
                if sci.startswith(TARGET_SCI):
                    target_hits += 1
                    if rec.get("vernacularName") and sci not in vernacular_for_targets:
                        vernacular_for_targets[sci] = rec["vernacularName"]
                if rows % 200_000 == 0:
                    print(f"  ...{rows:,} rows")

    print(f"\ntotal rows: {rows:,}")
    print("\ncolumn fill rate:")
    for name in fields.values():
        pct = 100 * fill[name] / rows if rows else 0
        flag = "   <-- of interest" if name in INTEREST else ""
        print(f"  {name:<34} {pct:6.1f}%{flag}")

    print(f"\nlicense: {dict(licenses)}")
    print(f"geodeticDatum: {dict(datums)}")
    print(f"taxonRank: {dict(ranks)}")
    print(f"informationWithheld (top 10): {withheld.most_common(10)}")
    print(f"dataGeneralizations (top 10): {generalized.most_common(10)}")
    if coord_unc:
        print(
            "coordinateUncertaintyInMeters: "
            f"n={len(coord_unc):,} p50={percentile(coord_unc, 0.5):.0f} "
            f"p90={percentile(coord_unc, 0.9):.0f} p99={percentile(coord_unc, 0.99):.0f} "
            f"max={max(coord_unc):.0f}"
        )
    print(f"\ntarget-species rows: {target_hits:,}")
    print("Danish names carried for target species:")
    for sci, dk in sorted(vernacular_for_targets.items()):
        print(f"  {sci:<32} {dk}")
    if not vernacular_for_targets:
        print("  (none found in this archive -- get Danish names from the other source)")


if __name__ == "__main__":
    main()
