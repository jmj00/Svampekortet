import json
from pathlib import Path

from pipeline.config import DENMARK_BBOX
from pipeline.publish.site import _thumbnail, run, slugify


def test_slugify():
    assert slugify("Boletus edulis") == "boletus-edulis"


def test_publish_writes_manifest_and_species_files(ingested_db: Path, tmp_path: Path):
    out = tmp_path / "publish"
    report = run(ingested_db, out)

    assert report["species"] == 56  # 28 core + 28 extra
    assert report["observations"] == 3  # SA:1, SA:2, SA:9
    assert report["files"] == 57  # manifest + 56 species

    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert len(manifest["species"]) == 56
    assert {s["tier"] for s in manifest["species"]} == {"core", "extra"}
    assert all(s["score_validated"] == (s["tier"] == "core") for s in manifest["species"])
    assert manifest["bbox"] == list(DENMARK_BBOX)
    assert set(manifest["attribution"]) == {
        "observations",
        "weather",
        "basemap",
        "redlist",
        "photos",
        "forests",
    }
    assert manifest["forests"] is None  # no forest_points table in the test fixture DB
    assert manifest["forest_outlines"] is None


def test_species_file_shape(ingested_db: Path, tmp_path: Path):
    out = tmp_path / "publish"
    run(ingested_db, out)

    kantarel = json.loads((out / "species" / "cantharellus-cibarius.json").read_text("utf-8"))
    assert kantarel["danish_name"] == "Almindelig Kantarel"
    assert kantarel["tier"] == "core"
    assert kantarel["score_validated"] is True
    assert kantarel["edible"] is True
    assert kantarel["gbif_usage_key"] == 5249504
    assert kantarel["redlist_category"] is None  # no redlist table in this fixture
    assert kantarel["observation_count"] == 1
    assert kantarel["observations"] == [[9.5, 56.2, 8]]  # SA:1, 2021-08-15
    assert kantarel["season_by_month"][7] == 1  # August
    assert sum(kantarel["season_by_month"]) == 1
    assert "kantarel" in kantarel["description"].lower()  # from data/descriptions/

    assert len(kantarel["images"]) >= 1  # from data/images/<slug>.json
    first = kantarel["images"][0]
    assert first["url"].startswith("https://")
    assert first["credit"] and first["license"]


def test_manifest_carries_season_and_thumbnail(ingested_db: Path, tmp_path: Path):
    out = tmp_path / "publish"
    run(ingested_db, out)

    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    by_slug = {s["slug"]: s for s in manifest["species"]}

    kantarel = by_slug["cantharellus-cibarius"]
    doc = json.loads((out / "species" / "cantharellus-cibarius.json").read_text("utf-8"))
    assert kantarel["season_by_month"] == doc["season_by_month"]
    assert kantarel["season_by_month"][7] == 1  # August
    # the list thumbnail is the first photo's small rendition, not the large one
    assert "/large." in doc["images"][0]["url"]
    assert kantarel["thumbnail"] == doc["images"][0]["url"].replace("/large.", "/small.")

    assert by_slug["suillus-luteus"]["season_by_month"] == [0] * 12


def test_thumbnail_variants():
    inat = "https://inaturalist-open-data.s3.amazonaws.com/photos/45641121"
    assert _thumbnail([{"url": f"{inat}/large.jpeg"}]) == f"{inat}/small.jpeg"
    assert _thumbnail([{"url": f"{inat}/large.jpg"}, {"url": "x"}]) == f"{inat}/small.jpg"
    # an unknown host or shape is passed through rather than guessed at
    other = "https://example.org/a/large-photo.jpg"
    assert _thumbnail([{"url": other}]) == other
    assert _thumbnail([]) is None


def test_species_with_no_observations(ingested_db: Path, tmp_path: Path):
    out = tmp_path / "publish"
    run(ingested_db, out)

    empty = json.loads((out / "species" / "suillus-luteus.json").read_text("utf-8"))
    assert empty["observation_count"] == 0
    assert empty["observations"] == []
    assert empty["season_by_month"] == [0] * 12
