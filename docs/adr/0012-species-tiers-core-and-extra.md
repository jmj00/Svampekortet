# 12. Species tiers: `core` (gated) and `extra` (best-effort)

Date: 2026-09-07

## Status

Accepted. Replaces the boolean `core_mvp` flag on
[ADR-0003](0003-species-name-resolution.md)'s species registry with a
three-value `tier`. Scopes which species the [ADR-0007](0007-backtest-gate-two-negative-regimes.md)
backtest gate is build-blocking for.

## Context

`pipeline/species.py` carried `core_mvp: bool`. It meant two unrelated things at
once:

- **Published or not.** `core_mvp: False` made a species completely invisible —
  not fitted, not in the payload, not in the UI. The one such entry
  (*Neoboletus praestigiator*) is a deliberate exclusion, kept in the registry
  only to document *why* it is held back.
- **Gated or not.** Every `core_mvp: True` species must clear the temporal
  backtest (full AUC ≥ habitat-only baseline, within tolerance in `week_matched`
  and by a margin in `calendar_random`) or **the whole build fails**. The
  golden-location anchors are the same: build-blocking.

That single bar is right for the flagship set, where we want to stand behind the
0–100 conditions score. It is too strict as the only way to add a species:

- A common, safe, well-recorded edible can still miss `calendar_random` by a
  hair — *Craterellus tubaeformis* cleared the old `+0.01` margin by `+0.009` on
  the national corpus and forced the margin down to `+0.005`
  ([ADR-0010](0010-expand-study-area-to-denmark.md), third build). The next
  late-fruiting species will sit on that line too.
- Species that fruit for months (many *Leccinum*, *Russula*, wood-rotters) have
  a thin seasonal signal by construction, so a calendar baseline is hard to
  beat even when the map is genuinely useful.
- Below `MIN_TEST_POSITIVES = 25` held-out finds the backtest can't score a
  species at all — it is skipped, which today means it cannot ship.

We still want these on the map (observations + season histogram + description are
useful on their own), and we want to be honest that the conditions score for
them is **not validated**.

The user also asked, when we started widening the list, to be able to tell *when
a species is not fully included*. A visible tier does that.

## Decision

`Species["tier"]` is one of `"core"`, `"extra"`, `"hidden"`.

| | `core` | `extra` | `hidden` |
| --- | --- | --- | --- |
| Ingested, `MIN_PER_SPECIES` (50) floor | yes, **blocking** | yes, **blocking** | records kept, no floor |
| Fitted model artifact | yes | yes | no |
| Backtest runs | yes | yes | no |
| Backtest / golden failure fails the build | **yes** | no — recorded in `advisory_failures` | n/a |
| In the published payload | yes | yes | **no** |
| UI: conditions score + pin ranking | full | shown with an "ikke valideret" caveat; listed under a separate **Flere arter** heading, not in the ranked order | absent |

`core_species()` is `tier == "core"`; the new `published_species()` is
`tier in {"core", "extra"}`. `fit`, `backtest` and `publish.site` iterate
`published_species()`. The build's hard gate (`build.py` `failures`) is fed only
by `core` slugs.

Unchanged and still blocking for **every** `TARGET_SPECIES` regardless of tier:

- the red-list guard ([ADR-0005](0005-red-list-source-and-exclusion.md)) — a
  target species in `RE/CR/EN/VU/NT` still fails the build. We never point people
  at a threatened species, validated score or not.
- the `MIN_PER_SPECIES` record floor — an `extra` species with fewer than 50
  kept records has too sparse a map and histogram to be worth showing, so that
  is a build failure, not a downgrade.

`hidden` is exactly the old `core_mvp: False`: registry-only, for documenting an
exclusion. *Neoboletus praestigiator* moves to it.

The payload gains `tier` on each manifest entry and species file, plus
`score_validated: bool` (`tier == "core"`) as the flag the web reads so the wire
format, not the enum, drives the UI.

## Consequences

- Adding a broadly-recorded edible no longer risks build stability. A species
  whose model doesn't beat the calendar baseline ships as `extra` with the
  caveat instead of blocking the build or forcing another margin cut.
- The backtest report grows an `advisory_failures` list. `passed_all` and the
  build gate stay `core`-only, so the ship gate's teeth are unchanged.
- The "promote to `core`" step is a one-line tier change in a later PR, once a
  species has enough test-period finds and clears the gate on a real build. That
  promotion is where the backtest numbers get reviewed.
- `extra` species are still scored by `rankHere` (they have model files); the
  panel just doesn't place them in the ranked list. The detail sheet still
  computes and shows their gauge, under the caveat.
- New `group` values (wood-rotters, jelly fungi, tooth fungi) are now
  low-risk to introduce as `extra` first; `test_species_shape`'s group
  allow-list is widened as each is added.
- A high-`lookalike_risk` species may be `extra` by the type rules, but the
  spirit of ADR-0003's risk gate stands: nothing that needs experience to tell
  from a toxic twin goes in front of beginners. *Neoboletus* stays `hidden`.
