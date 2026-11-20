import json

from pipeline.config import IMAGES_DIR
from pipeline.lookalikes import load_lookalikes, lookalikes_for
from pipeline.species import candidate_species, published_species, species_slug


def test_lookalikes_point_at_published_species_and_have_photos():
    lookalikes = load_lookalikes()
    assert lookalikes, "data/lookalikes.json is empty"
    published = {species_slug(s) for s in published_species()}
    targets = {s["scientific_name"] for s in candidate_species()}
    slugs = [entry["slug"] for entry in lookalikes]
    assert len(slugs) == len(set(slugs))
    for entry in lookalikes:
        assert entry["slug"] == entry["scientific_name"].lower().replace(" ", "-")
        # a poisonous lookalike is never one of the app's own species
        assert entry["scientific_name"] not in targets
        assert entry["danish_name"] and entry["text"].strip()
        assert set(entry["shown_on"]) <= published, set(entry["shown_on"]) - published
        images = json.loads((IMAGES_DIR / f"{entry['slug']}.json").read_text(encoding="utf-8"))
        assert images and all(img["license"] in {"CC BY 4.0", "CC0 1.0"} for img in images)


def test_lookalikes_for_filters_by_page():
    lookalikes = load_lookalikes()
    assert [e["slug"] for e in lookalikes_for("boletus-edulis", lookalikes)] == [
        "rubroboletus-satanas",
        "rubroboletus-legaliae",
    ]
    assert lookalikes_for("cantharellus-cibarius", lookalikes) == []
