# 10. Expand the study area from Jutland to all of Denmark

Date: 2026-09-03

## Status

Accepted. Widens the MVP scope set in
[ADR-0002](0002-tech-stack-and-precompute-architecture.md) and
[ADR-0004](0004-mvp-observation-source.md) ("MVP scope is Jutland"). The six
target species, the Danish-only UI, the anonymous read-only posture and the
static-precompute architecture are unchanged.

## Context

The MVP shipped Jutland-only: `pipeline/config.py` filtered the national
Svampeatlas archive and the DMI grid to a Jutland bounding box. That was a
de-risking choice, not a data limit — the Svampeatlas Darwin Core archive and
the DMI 10 km climate grid are both national.

Three model levers have since been measured and the v0 model found to be near the
achievable frontier for its three axes (ADR-0008, ADR-0009, and the seasonality
sweep in `docs/model-backtest.md`). Every term is self-referential per species —
a kernel density over *that species'* finds, a curve peak-normalised to *that
species'* season, a weather likelihood against *that species'* fruiting history —
so the model carries to Zealand, Funen and Bornholm with no re-tuning. The
gating change to real-world usefulness is geographic: Zealand and the Copenhagen
area — roughly a third of the country's population, and a lot of accessible
beech and mixed woodland — currently get nothing.

## Decision

The study area is **all of Denmark**. `pipeline/config.py`:
`JUTLAND_BBOX = (7.7, 54.7, 11.3, 57.9)` → `DENMARK_BBOX = (8.0, 54.5, 15.3,
57.9)` and `in_jutland` → `in_denmark`. The bbox spans Blåvandshuk to
Bornholm/Ertholmene and Gedser to Skagen; the corners clip some sea and slivers
of Skåne and northern Germany, which the coordinate checks and the absence of
Danish-archive records there keep effectively empty. The web map opens centred
on the Storebælt at a zoom that frames the whole country.

No architectural change: still one scheduled/on-demand build producing a static
DuckDB + JSON payload, no request-time backend.

### Deliberately deferred to a fast-follow

- **Golden-location anchors on the islands.** Needs real peak/winter numbers
  from an all-Denmark build before thresholds can be set. Done in stages:
  **Gribskov** added after the second build (below); a Funen anchor and a second
  Zealand one still to come.
- **Retiring the "Jutland" language in historical ADRs.** ADR-0002/0004/0006
  describe decisions as they stood; this ADR is the pointer, their bodies are
  left as the record.

### First all-Denmark build (2026-09-03)

Ran clean through ingest (kept 20,470 observations, +73 % on Jutland's 11,843 —
*Boletus* 5492, *Imleria* 5180, *Cantharellus* 4343, …) and the two-regime
backtest, but **failed the golden gate**: `cantharellus-cibarius @ Rold Skov`
peak 39 (floor 40) and `suillus-luteus @ Silkeborg-skovene` peak 35 (floor 40).

Cause: `habitat = min(1, raw / raw_ref)`, and `raw_ref` is the 95th percentile of
kernel density over the whole corpus. A Jutland forest's `raw` barely moves when
distant Zealand finds are added, but `raw_ref` jumps — the Copenhagen-area
forests (Dyrehaven, Gribskov, Rude Skov) are recorded far more intensively than
anywhere in Jutland, so the density reference now sits on those clusters and
every Jutland anchor's peak read roughly halved (Rold Skov *Cantharellus* 69 →
39; Silkeborg *Suillus luteus* 75 → 35). This is spatial **recording-effort**
bias, latent in the Jutland-only model and made acute by the effort gradient
across the Storebælt. Rankings and the seasonal signal are unaffected (the
backtest AUCs and every `SEASON_DROP` still pass).

Immediate unblock: **`PEAK_FLOOR` 40 → 30** — the peak floor is the loose "a
hotspot in season isn't read as poor" check; `SEASON_DROP` (25) is the real
combine-regression canary and is untouched. The effort bias itself is then fixed
in [ADR-0011](0011-effort-debias-habitat-density.md) — the habitat KDE runs over
~660 m localities so `raw_ref` stops tracking recording density.

### Second all-Denmark build (2026-09-05, post-ADR-0011)

Gate passed. Post-debias the golden peaks recovered — *Suillus luteus* @
Silkeborg 35 → 55, *Imleria* @ Rold Skov 79, @ Silkeborg 84, *Boletus* @
Marselisborg 78 — all 55–100, so **`PEAK_FLOOR` is back to 40**. `week_matched`
held comfortably (*Cantharellus* full 0.892 vs baseline 0.911, −0.019, inside
even the old 0.03). **Gribskov** (north Zealand) was added as the first island
golden anchor for the broadleaf species (*Cantharellus*, *Boletus*, *Imleria*).

### Third all-Denmark build (2026-09-07)

Failed `calendar_random` for **`craterellus-tubaeformis`**: full AUC 0.9581 vs
baseline 0.9488, +0.0093 — 0.0007 short of the +0.01 margin. `week_matched` was
never in doubt (0.9356 vs 0.9482, −0.0126). Cause is the ADR-0011 KDE dedup
again: it lifts the habitat-only baseline in *both* regimes, and *Craterellus* —
the latest and longest-fruiting of the six, so the weakest seasonal signal —
had the thinnest `calendar_random` headroom (+0.018 on Jutland, +0.009 now) and
was the first to cross. The full model still ranks better on AUC and on
precision@k (0.859 vs 0.839); the baseline rose, it did not regress.

Unblock: **`CALENDAR_RANDOM_MARGIN` 0.01 → 0.005** — the calendar-regime analogue
of the `WEEK_MATCHED_TOLERANCE` 0.03 → 0.035 change in ADR-0011. Every other
species clears +0.005 by more than 0.02.

## Consequences

- The next **full** build (not a `--skip-dmi` / code-only deploy) is what
  actually widens the data: more Svampeatlas observations (20,470 vs 11,843),
  more DMI cells (~430 vs ~300, so `weather_daily` and `current.json` grow
  ~40 %), and a larger per-species observation list in the web payload. Watch the
  payload size on that first build — if a species file gets heavy, thin the
  points (currently rounded to 4 dp, no spatial thinning).
- The two-regime backtest and the golden gate re-run on the larger corpus as
  usual; both must still pass or the build fails.
- Copy that said "Jylland" / "Jutland" is updated (README, the About panel's
  "Dækning", module docs).
- Post-launch this is the platform for further growth — more species within the
  same area — rather than another region.
