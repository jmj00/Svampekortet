import json
from pathlib import Path

import pytest

from pipeline import species
from pipeline.species import resolve_scope
from pipeline.tests.conftest import TRACKED_SCOPE_FILE


@pytest.fixture
def scope_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "species_scope.json"
    monkeypatch.setattr(species, "SCOPE_FILE", path)
    return path


def _slugs(items: list[species.Species]) -> set[str]:
    return {species.species_slug(s) for s in items}


def test_no_scope_file_publishes_every_candidate(scope_file: Path):
    assert _slugs(species.published_species()) == _slugs(species.candidate_species())


def test_excluded_species_leave_published_and_core_but_stay_candidates(scope_file: Path):
    scope_file.write_text(json.dumps({"excluded": ["cantharellus-cibarius"]}), encoding="utf-8")
    assert "cantharellus-cibarius" not in _slugs(species.published_species())
    assert "cantharellus-cibarius" not in _slugs(species.core_species())
    assert "cantharellus-cibarius" in _slugs(species.candidate_species())
    assert len(species.published_species()) == len(species.candidate_species()) - 1


def test_scope_file_with_unknown_species_is_rejected(scope_file: Path):
    scope_file.write_text(json.dumps({"excluded": ["agaricus-typo"]}), encoding="utf-8")
    with pytest.raises(ValueError, match="agaricus-typo"):
        species.published_species()


def test_tracked_scope_file_is_valid(monkeypatch: pytest.MonkeyPatch):
    # The committed file must parse, name only known species and leave some in.
    monkeypatch.setattr(species, "SCOPE_FILE", TRACKED_SCOPE_FILE)
    assert species.excluded_slugs() <= _slugs(species.candidate_species())
    assert species.published_species()


def test_resolve_scope_applies_choices_both_ways():
    known = {"a", "b", "c"}
    assert resolve_scope(frozenset({"a"}), {"b": "exclude", "a": "include"}, known) == {"b"}
    assert resolve_scope(frozenset({"a"}), {}, known) == {"a"}


def test_resolve_scope_rejects_unknown_species_and_values():
    with pytest.raises(ValueError, match="unknown species"):
        resolve_scope(frozenset(), {"zzz": "exclude"}, {"a"})
    with pytest.raises(ValueError, match="invalid scope values"):
        resolve_scope(frozenset(), {"a": "maybe"}, {"a"})
