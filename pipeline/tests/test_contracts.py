"""The external APIs match the shape our code reads.

Recorded fixtures in `fixtures/` are trimmed real responses. If an upstream API
changes structure, refresh the fixture and update the matching assertion in
`pipeline/contracts.py`. The live equivalent is `python -m pipeline.contracts`,
run weekly by `.github/workflows/contracts.yml`.
"""

import json
from pathlib import Path

import pytest

from pipeline import contracts
from pipeline.dmi import feature_to_row
from pipeline.redlist import normalise

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.mark.parametrize(("fixture", "assertion"), list(contracts.FIXTURE_CONTRACTS.items()))
def test_recorded_response_matches_contract(fixture, assertion):
    data = json.loads((FIXTURES / fixture).read_text(encoding="utf-8"))
    assertion(data)  # raises AssertionError on drift


def test_parsers_handle_the_recorded_shapes():
    dmi = json.loads((FIXTURES / "dmi_10km_grid_items.json").read_text("utf-8"))
    row = feature_to_row(dmi["features"][0])
    assert row["cell_id"].startswith("10km_")
    assert isinstance(row["value"], float)

    redlist = json.loads((FIXTURES / "redlist_assessments.json").read_text("utf-8"))
    record = normalise(redlist["data"][0])
    assert record["scientific_name"]
    assert record["category"]
    assert record["arter_dk_id"] is None or isinstance(record["arter_dk_id"], str)


def test_contract_assertions_catch_drift():
    broken_dmi = {"features": [{"geometry": {"type": "Point"}, "properties": {}}]}
    with pytest.raises(AssertionError):
        contracts.assert_dmi_grid_items(broken_dmi)
    with pytest.raises(AssertionError):
        contracts.assert_redlist_assessments({"pages": 1, "page": 1, "total": 1, "data": [{}]})
    with pytest.raises(AssertionError):
        contracts.assert_adressevaelger_search({"status": "ok", "fund": [{"type": "husnummer"}]})
    with pytest.raises(AssertionError):
        contracts.assert_adressevaelger_lookup({"status": "ok", "husnummer": {}})
