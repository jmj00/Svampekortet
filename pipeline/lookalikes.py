"""Poisonous lookalikes shown on species pages (data/lookalikes.json).

They are not target species: no observations, no score, no list row. Each one
has a short Danish text, its own photos in data/images/<slug>.json, and the
slugs of the species pages it is relevant to (`shown_on`).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import TypedDict

from pipeline.config import DATA_DIR

LOOKALIKES_FILE = DATA_DIR / "lookalikes.json"


class Lookalike(TypedDict):
    slug: str
    danish_name: str
    scientific_name: str
    gbif_usage_key: int
    synonyms: list[str]
    text: str
    shown_on: list[str]


def load_lookalikes(path: Path = LOOKALIKES_FILE) -> list[Lookalike]:
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))["lookalikes"]


def lookalikes_for(slug: str, lookalikes: list[Lookalike]) -> list[Lookalike]:
    return [entry for entry in lookalikes if slug in entry["shown_on"]]
