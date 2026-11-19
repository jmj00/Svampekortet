# 18. Effort-corrected habitat term (target-group background)

Date: 2026-09-11

## Status

Rejected, on real backtest evidence (§ "What the numbers said"). The
machinery below is built and correct, and stays in the repo, dormant: a
`HabitatModel` fit *without* an effort grid -- true of every species in
production today, since nothing runs `pipeline.ingest.recording_effort` as
part of a deploy -- is completely unaffected. `raw_ref` and the original
scoring path are untouched. What's rejected is actually *running* that
ingest and turning the correction on: measured against the real backtest, it
doesn't just fail to help, it collapses the habitat term's ranking power
outright, at every correction strength tested, with the worst case (full
strength) reducing several core species' AUC to barely better than random.

## Context

This project's original motivation for looking past raw find-density
(ADR-0016's biotope work, and the literature review that followed it) was
that good foraging spots get under-reported -- either deliberately kept
secret, or, per the better-evidenced version of that concern, simply because
citizen-science fungal records cluster near paths and accessible ground far
more than the underlying species distribution would predict. In one
cross-taxon study, path density was the single strongest predictor of local
record count for 7 of 8 taxonomic groups tested; a broader review found the
same accessibility-and-observer-inequality pattern generalises across regions
and recording platforms.

ADR-0011 already corrects for one form of this: a spot reported 500 times and
one reported once count the same in the habitat KDE's support, so repeat
visits to the same locality don't inflate `raw_ref`. It does nothing about a
different axis of the same bias -- one whole *area* getting far more
fungi-recording of any kind than another, independent of revisits to a single
spot. A popular, accessible forest can accumulate a large `raw_ref` for a
species purely because it gets recorded a lot in general, not because it's
unusually good habitat; a rarely-visited spot with genuinely comparable
habitat quality scores lower for no ecological reason at all.

### Target-group background

The standard fix in the species-distribution-modelling literature is
*target-group background*: instead of treating a species' own raw
find-density as unbiased, compare it against the density of *all* species
reported by the same recording scheme in the same place -- background points
drawn from, or weighted by, that broader recording-effort surface rather than
sampled uniformly. It's designed for exactly this data shape: Svampeatlas
records every fungal species, not just the ~50 Svampekortet publishes, so
"how much fungi-recording happens here at all" is a ready-made effort proxy
already sitting in the same archive `pipeline.ingest.svampeatlas` reads --
it just wasn't being kept, since `svampeatlas.classify` discards every
non-target-species record at ingest time.

### Why a spatial histogram, not a smoothed density

The literature's own version of target-group background is a plain per-cell
*count* -- a spatial histogram of background records, not a kernel-smoothed
surface. That also happens to be the only form of this computation that
stays tractable to precompute nationally: a KDE summed live over every one of
Denmark's ~1.27M qualifying background records against a ~77,000-cell output
grid is the same kind of join blow-up `pipeline.ingest.biotope` hit (fixed
there with an R-tree index) -- and there is no spatial-index equivalent for
"sum a Gaussian kernel over a million points per output cell" the way there is
for "does this point fall in this polygon." A binned count sidesteps the
problem instead of needing a bigger hammer: `pipeline.ingest.recording_effort`
re-scans the archive once, applies the same quality gates
`svampeatlas.classify` does minus the species-identity and taxon-rank checks,
and bins survivors directly into a ~2 km grid (`GRID_DEG`, matching
`pipeline.model.biotope`'s scale) with a `Counter` -- O(records) with no join
at all. On the real archive: 1,270,366 qualifying records (of 1,309,988
scanned) into 14,537 non-empty cells, median 12 records/cell, 99th percentile
1,411 -- a heavy tail, consistent with the accessibility-bias hypothesis
(a handful of very popular forests dominate).

### The two-reference design

Unlike ADR-0016's biotope term, this is not a new axis -- it's a refinement of
the habitat term's *own* formula, and it changes the always-active core term,
not an optional one. That raises the stakes on backward compatibility:
`golden.py`'s checks call `model.score(lon, lat, peak_doy)` with no auxiliary
arguments at all, by design (ADR-0006), and must keep working unchanged
regardless of whether a species' `HabitatModel` was fit with an effort grid.

`HabitatModel` therefore keeps *both* references:

    raw_ref     = today's reference, unchanged (ADR-0006, ADR-0011)
    ratio_ref   = quantile(raw(loc) / effort(loc) for loc in this species' own
                  localities), only when at least one has real (non-floored)
                  effort coverage -- otherwise None, same as no grid at all

    score(q, effort=None):
        if effort is not None and ratio_ref is not None:
            return min(1, (raw(q) / max(effort, MIN_EFFORT_TO_CORRECT)) / ratio_ref)
        return min(1, raw(q) / raw_ref)          -- exactly today's formula

A caller that doesn't look up and pass `effort` -- `golden.py` in particular,
and any future caller that forgets to -- gets precisely today's score,
byte-for-byte, whether or not the model was fit with an effort grid at all.
`MIN_EFFORT_TO_CORRECT` floors the divisor so a barely- (or never-) recorded
cell doesn't blow the ratio up; a species whose own training localities have
no real background coverage anywhere gets `ratio_ref = None` rather than a
degenerate rescale of `raw_ref` that "corrects" nothing.

Because the ADR-0007 backtest gate's baseline is `HabitatModel.score` itself
(destructured straight out of `model.terms()`), the gate directly measures
whether this correction is a net improvement to the always-shipped baseline,
not just to the full model -- both `raw_full` and `raw_base` use the same
corrected term when effort is supplied, so the comparison stays apples to
apples.

## What the numbers said

Real backtest, `recording_effort_grid` populated from the full archive
(1,270,366 background records, 14,537 non-empty cells), all 6 core species
effort-corrected (every one had real background coverage at its own
localities). Full-strength correction (`ratio(q) = raw(q) / max(effort(q),
floor)`, as designed above):

| species | week_matched (before -> after) | calendar_random (before -> after) |
| --- | --- | --- |
| cantharellus-cibarius | 0.910 -> **0.541** | 0.913 -> **0.544** |
| boletus-edulis | 0.845 -> **0.339** | 0.847 -> **0.329** |
| suillus-variegatus | 0.901 -> **0.669** | 0.895 -> **0.660** |

Both regimes, every species, near the same magnitude of collapse -- 0.34 for
boletus-edulis is *worse than a coin flip*. The gate's own pass/fail check
still reported `passed_all: true`, because it only measures the full model's
AUC against the (now equally collapsed) baseline, not the baseline's absolute
quality -- a reminder that `passed_all` is a *relative* check, not a
substitute for reading the numbers.

To rule out "the correction is directionally right but too strong," a
dampened version was swept: `ratio(q) = raw(q) / max(effort(q), floor)^k` for
`k` from 1.0 down to 0.0 (no correction). The degradation is monotonic and
recovers smoothly back to the original numbers only as `k -> 0` -- there is
no partial-strength sweet spot, unlike ADR-0016's biotope weight sweep, which
found one:

| `k` | cantharellus week (baseline) | boletus week (baseline) |
| --- | --- | --- |
| 1.0 (full) | 0.541 | 0.339 |
| 0.5 | 0.762 | 0.578 |
| 0.25 | 0.857 | 0.744 |
| 0.1 | 0.893 | 0.814 |
| 0.0 (none) | 0.908 | 0.845 |

Even a *light*, 10 %-strength correction still measurably costs AUC. The
mechanism: `ratio_ref` is calibrated against this species' own localities,
which mostly sit in *reasonably*-recorded cells (real finds get reported from
somewhere), so `ratio_ref` implicitly assumes a "normal" effort level. A
random negative in a barely-recorded cell (most of Denmark's land area, given
the heavy-tailed distribution above) gets its tiny `raw(q)` divided by the
*floor* rather than a large number -- inflating cheap, ecologically
meaningless background noise up toward the same scale real finds calibrate
against, exactly inverting the intended correction. More fundamentally: in
this dataset, recording effort and genuine habitat quality are heavily
confounded, not just correlated by bias -- an accessible, popular forest
tends to *actually be* good habitat for many of these species (that's plausibly
*why* it's popular), so dividing out effort removes real ecological signal
along with whatever accessibility bias rides on top of it. Target-group
background is the literature-standard fix for sampling bias; it assumes the
bias is separable from the signal, and on this corpus it isn't.

## Decision

**Do not run this in production.** The machinery is real, correct, and
backward-compatible by construction -- `raw_ref` and every existing caller are
untouched, and a `HabitatModel` fit without an effort grid (every species
today) scores exactly as before ADR-0018. But `pipeline.ingest.recording_effort`
should not be run against the production database, and no `deploy.yml` input
was added for it (contrast ADR-0014's named forests and ADR-0016's biotope
grid, which both got a `skip`/`refresh` toggle) -- there is no dampened
version worth exposing even as an option, since none was found. This is
closer to "measured and rejected" (ADR-0009's calibration routes) than to
"shelved as advisory" (ADR-0016's biotope): there is no benign display use for
a per-cell recording-effort count the way there was for forest/soil type, so
there is nothing to ship even as inert UI context.

## Consequences

- `pipeline.ingest.recording_effort` and `pipeline.model.recording_effort`
  exist and are tested, but are not wired into `pipeline.build`, `deploy.yml`,
  or any other automated path -- they must be run by hand against a local
  database, and doing so is now documented as inadvisable rather than
  optional-but-untried.
- `HabitatModel`'s two-reference design (`raw_ref` always, `ratio_ref` only
  when an effort grid was supplied at fit time) stays in `habitat.py`: it's a
  real, validated pattern for "backward-compatible optional refinement of the
  core term" even though this particular use of it didn't pan out, and it
  cost nothing to the unaffected path (confirmed by the full pipeline test
  suite and a real backtest run with no effort grid at all, unchanged from
  pre-ADR-0018 numbers).
- `species_model.py`'s `terms()`/`score()` keep the `effort: int | None =
  None` parameter; `golden.py` needed no changes at all, confirming the
  backward-compatible design held even under a rejected feature.
- If recording effort is revisited later, the numbers above are the baseline
  to beat, and the mechanism section above is the concrete hypothesis to test
  first: whatever comes next needs to separate effort's bias component from
  its correlation with genuine habitat suitability, not divide the two
  apart naively.
