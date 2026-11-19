from pathlib import Path

from pipeline.dwca import DwcArchive


def test_reads_core_records(tiny_dwca: Path):
    with DwcArchive(tiny_dwca) as archive:
        assert archive.core_location == "occurrence.txt"
        records = list(archive.iter_core())

    assert len(records) == 10
    first = records[0]
    assert first["occurrenceID"] == "SA:1"
    assert first["scientificName"] == "Cantharellus cibarius Fr."
    assert first["taxonRank"] == "sp."
    assert first["decimalLatitude"] == "56.2"
    # empty trailing columns still parse
    assert records[9]["decimalLongitude"] == ""


def test_iter_core_requires_context_manager(tiny_dwca: Path):
    archive = DwcArchive(tiny_dwca)
    try:
        list(archive.iter_core())
    except RuntimeError:
        pass
    else:  # pragma: no cover
        raise AssertionError("expected RuntimeError outside the context manager")
