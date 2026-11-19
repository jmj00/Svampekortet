import math

import pytest

from pipeline.model.metrics import (
    _auc_np,
    _average_ranks,
    auc_gap_se,
    calibration_curve,
    precision_at_k,
    roc_auc,
)


def test_average_ranks_ties_share_the_mean():
    assert _average_ranks([1, 2, 2, 3]) == [1.0, 2.5, 2.5, 4.0]
    assert _average_ranks([5, 5, 5]) == [2.0, 2.0, 2.0]


def test_roc_auc_separation():
    scores = [0.1, 0.2, 0.3, 0.8, 0.9, 1.0]
    labels = [0, 0, 0, 1, 1, 1]
    assert roc_auc(scores, labels) == 1.0
    assert roc_auc(scores, labels[::-1]) == 0.0


def test_roc_auc_ties_are_half_and_empty_class_is_nan():
    assert roc_auc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]) == 0.5
    assert math.isnan(roc_auc([0.1, 0.2], [1, 1]))


def test_precision_at_k():
    scores = [0.9, 0.8, 0.7, 0.2, 0.1]
    labels = [1, 0, 1, 0, 1]
    assert precision_at_k(scores, labels, 2) == 0.5  # top 2 -> [1, 0]
    assert precision_at_k(scores, labels, 3) == pytest.approx(2 / 3)
    assert precision_at_k(scores, labels, 99) == 0.6  # clamped to len


def test_calibration_curve_is_monotone_for_a_monotone_signal():
    scores = [i / 100 for i in range(100)]
    labels = [1 if i >= 50 else 0 for i in range(100)]
    curve = calibration_curve(scores, labels, bins=5)
    rates = [b["hit_rate"] for b in curve]
    assert rates == sorted(rates)
    assert sum(b["n"] for b in curve) == 100


def test_auc_np_matches_roc_auc_with_ties():
    import random

    import numpy as np

    rng = random.Random(3)
    scores = [round(rng.random(), 1) for _ in range(300)]  # many ties
    labels = [int(rng.random() < 0.3) for _ in range(300)]
    assert _auc_np(np.array(scores), np.array(labels)) == pytest.approx(roc_auc(scores, labels))


def test_auc_gap_se_is_seeded_and_zero_for_identical_scores():
    import random

    rng = random.Random(4)
    a = [rng.random() for _ in range(400)]
    labels = [int(rng.random() < 0.25) for _ in range(400)]
    b = [x + rng.gauss(0, 0.3) for x in a]
    se = auc_gap_se(a, b, labels, seed=7)
    assert se == auc_gap_se(a, b, labels, seed=7)
    assert 0 < se < 0.1
    assert auc_gap_se(a, a, labels, seed=7) == 0
    assert math.isnan(auc_gap_se(a, b, [0] * 400))
