"""Golden-location checks -- named real forests, concrete expected output.

The backtest (ADR-0007) is a statistical gate over thousands of points. This is
its human-readable complement, asked for in ADR-0006 ("Golden locations"): a
handful of well-known foraging forests where each listed species must

- score at least ``PEAK_FLOOR`` at its seasonal peak,
- fall by at least ``SEASON_DROP`` from that peak to mid-winter,
- score at most ``OFFSHORE_CEIL`` at a point out in the North Sea.

A regression in the combine (ADR-0008) or the seasonality curve trips these even
when the aggregate AUC barely moves -- e.g. reverting the geometric mean to the
bare product drops the peak forest scores from ~70 to ~15. ``SEASON_DROP`` (the
peak-to-January fall) is the real combine-regression canary; ``PEAK_FLOOR`` is a
looser "a known hotspot in season does not read as poor" check. Scored
weather-free, so it needs no date or ``current.json`` and is fully deterministic.

Note: these are *absolute* 0..100 reads. Extending the corpus to all of Denmark
(ADR-0010) first halved the peak reads here -- the densely-recorded Zealand
forests had pulled up ``raw_ref`` -- which ADR-0011 fixed by running the habitat
KDE over ~660 m localities. Post-debias the all-Denmark peaks are back at
55-100, so ``PEAK_FLOOR`` is back to 40.

Runs inside ``pipeline.model.fit``; a failure fails the build.
"""

from __future__ import annotations

from pipeline.model.species_model import SpeciesModel

# lon, lat of the forest centres. Rough is fine -- the habitat term is smooth
# over kilometres; these sit well inside large contiguous woodland. Gribskov
# (Denmark's largest forest, on north Zealand) anchors the island side; Funen
# and a second Zealand anchor can follow once these prove out.
FORESTS: dict[str, tuple[float, float]] = {
    "Rold Skov": (9.86, 56.82),
    "Silkeborg-skovene": (9.53, 56.17),
    "Marselisborgskovene": (10.24, 56.10),
    "Gribskov": (12.30, 56.01),
}

# North Sea, ~40 km west of the Jutland coast: no finds anywhere near, so every
# species' habitat term is zero here.
OFFSHORE: tuple[float, float] = (7.6, 56.3)

# species slug -> the forests where Svampeatlas has enough records to anchor on.
# suillus-variegatus is left out: too few records for a stable golden score.
# Gribskov is added only for the broadleaf species that are densely recorded on
# north Zealand; Suillus (pine) has no reliable Gribskov corpus.
POSITIVES: dict[str, tuple[str, ...]] = {
    "cantharellus-cibarius": ("Rold Skov", "Marselisborgskovene", "Gribskov"),
    "craterellus-tubaeformis": ("Rold Skov", "Silkeborg-skovene", "Marselisborgskovene"),
    "boletus-edulis": ("Rold Skov", "Silkeborg-skovene", "Marselisborgskovene", "Gribskov"),
    "imleria-badia": ("Rold Skov", "Silkeborg-skovene", "Marselisborgskovene", "Gribskov"),
    "suillus-luteus": ("Silkeborg-skovene",),
}

# All-Denmark corpus, post-ADR-0011: peak reads 55-100 at these anchors,
# peak-minus-winter well above SEASON_DROP, offshore 0.
PEAK_FLOOR = 40
SEASON_DROP = 25
OFFSHORE_CEIL = 3
WINTER_DOY = 15

# A golden anchor is only meaningful against a real corpus. Below this many
# training points a species is skipped (tiny fixtures, a species not yet
# ingested) rather than failed -- the real six carry 470-2475 points.
MIN_CORPUS = 200


def _peak_doy(model: SpeciesModel) -> int:
    return max(range(1, 367), key=model.seasonality.score)


def run(models: dict[str, SpeciesModel]) -> dict:
    """Check every anchor against ``models`` (slug -> fitted SpeciesModel).
    Returns a report dict with ``passed``, ``failures`` and per-case detail."""
    cases: list[dict] = []
    failures: list[str] = []
    skipped: list[str] = []

    for slug, forests in POSITIVES.items():
        model = models.get(slug)
        if model is None:
            continue
        if len(model.habitat.observations) < MIN_CORPUS:
            skipped.append(slug)
            continue
        peak_doy = _peak_doy(model)

        for forest in forests:
            lon, lat = FORESTS[forest]
            peak = model.score(lon, lat, peak_doy).value
            winter = model.score(lon, lat, WINTER_DOY).value
            ok = peak >= PEAK_FLOOR and peak - winter >= SEASON_DROP
            cases.append(
                {
                    "slug": slug,
                    "place": forest,
                    "kind": "positive",
                    "peak": peak,
                    "winter": winter,
                    "passed": ok,
                }
            )
            if not ok:
                failures.append(
                    f"{slug} @ {forest}: peak {peak} (floor {PEAK_FLOOR}), "
                    f"drop {peak - winter} (min {SEASON_DROP})"
                )

        off = model.score(*OFFSHORE, peak_doy).value
        off_ok = off <= OFFSHORE_CEIL
        cases.append(
            {"slug": slug, "place": "North Sea", "kind": "negative", "peak": off, "passed": off_ok}
        )
        if not off_ok:
            failures.append(f"{slug} @ North Sea: {off} (ceil {OFFSHORE_CEIL})")

    return {
        "passed": not failures,
        "thresholds": {
            "peak_floor": PEAK_FLOOR,
            "season_drop": SEASON_DROP,
            "offshore_ceil": OFFSHORE_CEIL,
        },
        "failures": failures,
        "skipped": skipped,
        "cases": cases,
    }
