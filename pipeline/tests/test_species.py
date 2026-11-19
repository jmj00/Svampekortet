from pipeline.species import TARGET_SPECIES, core_species, published_species

TIERS = {"core", "extra", "hidden"}


def test_species_shape():
    seen: set[str] = set()
    for s in TARGET_SPECIES:
        assert s["scientific_name"] and " " in s["scientific_name"], s
        assert s["danish_name"], s
        assert s["lookalike_risk"] in {"low", "medium", "high"}, s
        assert s["group"] in {
            "kantarel",
            "rorhat",
            "traesvamp",
            "pigsvamp",
            "blaeksvamp",
            "stoevbold",
            "morkel",
            "maelkehat",
        }, s
        assert s["tier"] in TIERS, s
        assert s["scientific_name"] not in seen, f"duplicate {s['scientific_name']}"
        seen.add(s["scientific_name"])


def test_core_set_is_sensible():
    core = core_species()
    assert 4 <= len(core) <= 48
    assert all(s["edible"] for s in core)
    assert all(s["tier"] == "core" for s in core)


def test_published_is_core_plus_extra():
    published = published_species()
    assert {s["scientific_name"] for s in core_species()} <= {
        s["scientific_name"] for s in published
    }
    assert all(s["tier"] in {"core", "extra"} for s in published)
    assert all(s["tier"] != "hidden" for s in published)


def test_high_lookalike_risk_species_are_not_core():
    for s in TARGET_SPECIES:
        if s["lookalike_risk"] == "high":
            assert s["tier"] != "core", f"{s['scientific_name']} is high-risk but marked core"
