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
