"""The v0 "conditions score" model.

Given a place and a date, how favourable are conditions for a species fruiting
there? The score is a product of interpretable terms, each in ``[0, 1]``:

    score = habitat x seasonality x weather

This package fits the terms per species from the Phase 1 DuckDB and writes small
static artifacts (``build/publish/model/``) that the web app combines client-side
for an arbitrary pin. See ``docs/adr/0006-v0-probability-model.md``.

Delivered so far: the habitat and seasonality terms. The weather term and the
backtest-calibrated rescaling land in later steps; the combiner already leaves
slots for them so nothing downstream has to move.
"""
