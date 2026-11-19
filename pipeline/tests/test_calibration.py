import random

import pytest

from pipeline.model.calibration import IsotonicCalibrator, _pava, _rescale_unit


def test_identity_is_a_passthrough_clamped_to_unit():
    cal = IsotonicCalibrator.identity()
    assert cal.is_identity
    assert cal.predict(0.3) == pytest.approx(0.3)
    assert cal.predict(-1.0) == 0.0
    assert cal.predict(2.0) == 1.0


def test_fit_below_the_point_floor_returns_identity():
    assert IsotonicCalibrator.fit([0.1, 0.2, 0.3], [0, 0, 1]).is_identity


def test_pava_makes_a_non_decreasing_fit():
    pooled = _pava([3.0, 1.0, 2.0, 5.0, 4.0], [1.0] * 5)
    assert pooled == sorted(pooled)


def test_rescale_unit():
    assert _rescale_unit([0.2, 0.5, 0.8]) == pytest.approx([0.0, 0.5, 1.0])
    assert _rescale_unit([0.3, 0.3]) == [0.3, 0.3]  # degenerate: left alone


def test_fit_recovers_a_monotone_relationship_and_spans_the_unit_interval():
    rng = random.Random(1)
    raw, outcome = [], []
    for _ in range(4000):
        x = rng.random()
        raw.append(x)
        outcome.append(1 if rng.random() < x else 0)  # P(1) rises with x

    cal = IsotonicCalibrator.fit(raw, outcome)
    assert not cal.is_identity
    assert cal.predict(0.05) < 0.25
    assert cal.predict(0.95) > 0.75
    assert cal.predict(0.2) <= cal.predict(0.5) <= cal.predict(0.8)
    assert cal.ys[0] == pytest.approx(0.0)
    assert cal.ys[-1] == pytest.approx(1.0)


def test_fit_output_is_monotone_even_from_a_noisy_dip():
    raw = [i / 200 for i in range(200)]
    outcome = [0] * 80 + [1] * 10 + [0] * 20 + [1] * 90  # a dip in the middle
    cal = IsotonicCalibrator.fit(raw, outcome)
    ys = [cal.predict(x) for x in raw]
    assert all(a <= b + 1e-9 for a, b in zip(ys, ys[1:], strict=False))


def test_dict_roundtrip():
    cal = IsotonicCalibrator((0.0, 0.3, 1.0), (0.0, 0.6, 1.0))
    back = IsotonicCalibrator.from_dict(cal.to_dict())
    assert back.predict(0.15) == pytest.approx(cal.predict(0.15))
    assert IsotonicCalibrator.from_dict(None).is_identity
    assert IsotonicCalibrator.from_dict({"x": [1.0], "y": [1.0]}).is_identity
