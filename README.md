# Svampekortet

A mobile-first map for Danish mushroom foraging: where an edible species has been
recorded before in Denmark, and how favourable current conditions are for looking
now. Danish-only, anonymous, read-only. Built on open data from Svampeatlas /
Atlas of Danish Fungi, DMI and the Danish Red List (DCE / Aarhus University), on
an OpenStreetMap basemap (vector tiles from OpenFreeMap).

> **Not an identification tool.** The app never asserts a mushroom is safe to eat.
> It shows where a *named* species has been observed and a 0–100 *conditions
> score* — a relative favourability, not a probability. Always verify edibility
> with an expert. Poisoning: Giftlinjen 82 12 12 12.

Live at <https://svampekortet.pages.dev>.

## Scope

All of Denmark, Danish UI. **48 edible species** across seven morphological
groups (chanterelles, boletes, wood / shelf fungi, tooth fungi, ink caps,
puffballs, morels), in two tiers
([ADR-0012](docs/adr/0012-species-tiers-core-and-extra.md)):

- **core** (15) — the 0–100 conditions score is validated by the temporal
  backtest ([ADR-0007](docs/adr/0007-backtest-gate-two-negative-regimes.md)); a
  gate failure blocks the build. Shown in the pin-ranked list.
- **extra** (33) — common, safe, well-recorded species whose score is not yet
  gate-validated. Shown separately under "Flere arter" with a caveat; a gate
  failure is advisory only.

Started Jutland-only with six species
([ADR-0010](docs/adr/0010-expand-study-area-to-denmark.md)); the founding core is
*Cantharellus cibarius*, *Craterellus tubaeformis*, *Boletus edulis*, *Imleria
badia*, *Suillus luteus*, *Suillus variegatus*.

## Architecture

Static precompute ([ADR-0002](docs/adr/0002-tech-stack-and-precompute-architecture.md)).
A scheduled / on-demand GitHub Actions job rebuilds a DuckDB database and a static
JSON payload from the live sources; the web app is a pure static site that loads
that payload. There is no backend at request time.

```
sources ──► pipeline/ (Python) ──► DuckDB + build/publish/*.json ──► web/ (static) ──► Cloudflare Pages
```

## Layout

| Path | Contents |
|---|---|
| `pipeline/ingest/` | source → rows in DuckDB: `svampeatlas`, `dmi` (weather), `redlist` |
| `pipeline/derive/` | `observation_weather` — antecedent weather per observation |
| `pipeline/model/` | the conditions model: `habitat`, `seasonality`, `weather` terms, `fit`, plus the `backtest` and `golden` ship gates |
| `pipeline/publish/` | `site.py` — writes `manifest.json` + per-species files for the web app |
| `pipeline/build.py` | one command: ingest → derive → model → publish |
| `pipeline/{config,species,http,dmi,dwca,duckload,redlist,contracts}.py` | shared config, the target-species list, HTTP/DuckDB helpers, live API contract checks |
| `pipeline/spikes/` | the original Phase-0 data de-risking probes, kept for reference |
| `web/` | the client — vanilla TypeScript + Vite + MapLibre GL, no framework (see `web/README.md`) |
| `docs/` | `data-sources.md`, `deploy.md`, `model-backtest.md`, architecture decision records in `adr/` |
| `.github/workflows/` | `ci` (lint / type-check / test / build), `contracts` (weekly API-drift check), `deploy` |
| `build/` | generated DuckDB + reports (git-ignored) |

## The model

`value = round(100 × geometric_mean(habitat, seasonality, weather))`, each term
in `[0, 1]`:

- **habitat** — a Gaussian kernel-density surface over the species' past finds
  (thinned to a ~660 m grid so recording effort doesn't skew it), with a
  per-species bandwidth from the local spacing between find localities;
- **seasonality** — a wrapped-Gaussian day-of-year curve, peak-normalised;
- **weather** — how typical the query cell's recent precipitation and temperature
  are for this species' historic fruitings; neutral when weather is unavailable.

It ships **uncalibrated** — the geometric mean spreads the 0–100 scale without
changing any ranking, and three calibration routes were
[measured against the backtest and none adopted](docs/adr/0009-calibration-measured-and-not-adopted.md).
Every build runs a temporal **backtest** (fit ≤ 2021, score 2022–25 against two
negative-sampling regimes) and a set of **golden-location** checks; for a
`core`-tier species either failing fails the build, for an `extra`-tier species
it is advisory ([ADR-0012](docs/adr/0012-species-tiers-core-and-extra.md)). See
[ADR-0006](docs/adr/0006-v0-probability-model.md) …
[ADR-0009](docs/adr/0009-calibration-measured-and-not-adopted.md) and
[`docs/model-backtest.md`](docs/model-backtest.md).

## Quick start

### Rebuild the database + payload

```sh
py -m pipeline.build --archive path/to/dwcarchive.zip --report build/build_report.json
# code / model-only rebuild that reuses the loaded weather:
py -m pipeline.build --archive path/to/dwcarchive.zip --skip-dmi
```

Writes `build/svampekortet.duckdb` and `build/publish/`. The DMI step is the slow
one (~25 min for 2011–now, all network); `--skip-dmi` reuses whatever
`weather_daily` is already loaded. The build exits non-zero if any guard trips: a
published species too thin, a target species on the Red List hide-set
([ADR-0005](docs/adr/0005-red-list-source-and-exclusion.md)), or — for a
`core`-tier species — the model not beating the habitat-only baseline or a golden
location out of band. `extra`-tier gate failures are advisory
([ADR-0012](docs/adr/0012-species-tiers-core-and-extra.md)).

### Python tooling (3.10+, only `duckdb` + `truststore` at runtime)

```sh
py -m pip install -e ".[dev]"
ruff check . && ruff format --check .
pytest
pre-commit install
py -m pipeline.contracts        # live check: do the external APIs still match our parsers?
```

`pytest` runs the contract checks against recorded fixtures; `pipeline.contracts`
runs them live (also weekly via `.github/workflows/contracts.yml`).

### Web (Node.js 22 LTS)

```sh
cd web
npm install
npm run dev            # http://localhost:5173
npm run lint && npm run test && npm run build
```

`web/public/data/` holds a committed sample payload for local development.

## Deploy

The `deploy` workflow rebuilds from the live sources and publishes `web/dist` to
Cloudflare Pages. It runs weekly and on demand (**Actions → deploy → Run
workflow**), with a *weather refresh scope* input — `skip` for a code-only deploy
(~12 min), up to `full` for a 2011-present weather rebuild. Setup, secrets and
variables: [`docs/deploy.md`](docs/deploy.md).

## Licence

Code: [PolyForm Strict 1.0.0](https://polyformproject.org/licenses/strict/1.0.0)
(`LICENSE`). You may read the code and run it for noncommercial purposes; you
may not distribute it or make changes or new works based on it. This is not an
open-source licence. Svampekortet is a free, noncommercial project and is meant
to stay one.

Data: upstream per-record licences apply — see
[`docs/data-sources.md`](docs/data-sources.md).
