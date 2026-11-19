"""Evaluation metrics for the backtest (pure stdlib).

ROC-AUC via the rank / Mann-Whitney identity, precision@k over the ranked
evaluation points, and an equal-width calibration curve.
"""

from __future__ import annotations

import math
from collections.abc import Sequence


def _average_ranks(sorted_values: Sequence[float]) -> list[float]:
    """1-based ranks for an already-sorted sequence; ties share the mean rank."""
    ranks = [0.0] * len(sorted_values)
    i = 0
    n = len(sorted_values)
    while i < n:
        j = i
        while j + 1 < n and sorted_values[j + 1] == sorted_values[i]:
            j += 1
        mean_rank = (i + j) / 2 + 1  # average of ranks i+1 .. j+1
        for k in range(i, j + 1):
            ranks[k] = mean_rank
        i = j + 1
    return ranks


def roc_auc(scores: Sequence[float], labels: Sequence[int]) -> float:
    """P(score of a random positive > score of a random negative), ties = 0.5.
    Returns nan if either class is empty."""
    paired = sorted(zip(scores, labels, strict=True), key=lambda p: p[0])
    ranks = _average_ranks([s for s, _ in paired])
    n_pos = sum(1 for _, y in paired if y == 1)
    n_neg = len(paired) - n_pos
    if n_pos == 0 or n_neg == 0:
        return math.nan
    rank_sum_pos = sum(r for r, (_, y) in zip(ranks, paired, strict=True) if y == 1)
    u = rank_sum_pos - n_pos * (n_pos + 1) / 2
    return u / (n_pos * n_neg)


def precision_at_k(scores: Sequence[float], labels: Sequence[int], k: int) -> float:
    """Fraction of the top-k highest-scoring points that are positives."""
    k = min(k, len(scores))
    if k <= 0:
        return math.nan
    order = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)
    return sum(labels[i] for i in order[:k]) / k


def calibration_curve(
    scores: Sequence[float], labels: Sequence[int], *, bins: int = 10
) -> list[dict]:
    """Equal-width bins over the score range; per bin: mean score, hit rate, n."""
    lo, hi = min(scores), max(scores)
    width = (hi - lo) / bins or 1.0
    buckets: list[list[float]] = [[] for _ in range(bins)]
    for s, y in zip(scores, labels, strict=True):
        idx = min(bins - 1, int((s - lo) / width))
        buckets[idx].append(y)
    out = []
    for b, ys in enumerate(buckets):
        if not ys:
            continue
        out.append(
            {
                "score": round(lo + (b + 0.5) * width, 4),
                "hit_rate": round(sum(ys) / len(ys), 4),
                "n": len(ys),
            }
        )
    return out


def _auc_np(scores, labels) -> float:
    """roc_auc on numpy arrays (same tie rule), for the bootstrap's inner loop."""
    import numpy as np

    _u, inverse, counts = np.unique(scores, return_inverse=True, return_counts=True)
    avg_rank = np.cumsum(counts) - (counts - 1) / 2  # 1-based mean rank per tie block
    ranks = avg_rank[inverse]
    pos = labels == 1
    n_pos = int(pos.sum())
    n_neg = len(labels) - n_pos
    if n_pos == 0 or n_neg == 0:
        return math.nan
    return float((ranks[pos].sum() - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg))


def auc_gap_se(
    scores_a: Sequence[float],
    scores_b: Sequence[float],
    labels: Sequence[int],
    *,
    resamples: int = 200,
    seed: int = 0,
) -> float:
    """Bootstrap standard error of AUC(a) - AUC(b) on the same points: positives
    and negatives resampled separately (each with replacement), both scores
    kept paired. Seeded, so the same inputs give the same number."""
    import numpy as np

    a = np.asarray(scores_a, dtype=float)
    b = np.asarray(scores_b, dtype=float)
    y = np.asarray(labels, dtype=int)
    pos_idx = np.flatnonzero(y == 1)
    neg_idx = np.flatnonzero(y == 0)
    if len(pos_idx) == 0 or len(neg_idx) == 0 or resamples < 2:
        return math.nan
    rng = np.random.default_rng(seed)
    gaps = np.empty(resamples)
    for i in range(resamples):
        idx = np.concatenate(
            (
                rng.choice(pos_idx, size=len(pos_idx), replace=True),
                rng.choice(neg_idx, size=len(neg_idx), replace=True),
            )
        )
        gaps[i] = _auc_np(a[idx], y[idx]) - _auc_np(b[idx], y[idx])
    return float(gaps.std(ddof=1))
