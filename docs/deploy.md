# Deploy

The web app is a static site on **Cloudflare Pages**. The
`.github/workflows/deploy.yml` job rebuilds the database + payload from the live
sources (`pipeline.build`), builds the web app with that payload baked in, and
runs `wrangler pages deploy`. It runs weekly (Mondays 05:00 UTC) and on demand
(Actions → **deploy** → Run workflow).

A second workflow, `.github/workflows/deploy-weather-daily.yml`, tops up just
the weather-driven "current conditions" data every day (03:00 UTC — 4am in
Denmark during winter, 5am during summer; cron is UTC-only and can't track
DST). It's deliberately lean: no observation/red-list re-ingest, no
forests/biotope/host-tree refresh, no backtest gate (the slow part of a
normal deploy) — just this year's weather, a fast model re-fit, the cheap
golden-location sanity check, and a redeploy. Habitat and seasonality don't
need refreshing more than weekly, so everything else stays on `deploy.yml`'s
schedule. Both workflows share the same cached DuckDB and the same
Cloudflare Pages secrets below.

Cloudflare Pages is used rather than GitHub Pages because it works with a private
repo on the free plan.

## One-time setup

### 1. Cloudflare

1. Create a free account at <https://dash.cloudflare.com>.
2. **Workers & Pages → Create → Pages → Direct Upload**. Name the project
   **`svampekortet`** (must match `--project-name` in the workflow). Skip the
   sample upload; the first real deploy comes from CI.
3. Copy your **Account ID** (Workers & Pages → right sidebar, or the dashboard URL
   `dash.cloudflare.com/<account-id>`).
4. **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers"** template
   (or a custom token with **Account → Cloudflare Pages → Edit**). Copy it.

### 2. GitHub repo secrets and variables

Repo → **Settings → Secrets and variables → Actions**.

**Secrets** (New repository secret):

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from step 1.4 |
| `CLOUDFLARE_ACCOUNT_ID` | the account ID from step 1.3 |
| `VITE_DATAFORDELER_API_KEY` | *(optional)* a plain API-Key (not an OAuth Shared Secret) from a Datafordeler IT-system, for the basemap and address search; without it the map uses OpenStreetMap and address search returns nothing |
| `SENTRY_AUTH_TOKEN` | *(optional)* Sentry org auth token, only used to upload source maps at build time |
| `DATAFORDELER_CLIENT_ID` / `DATAFORDELER_CLIENT_SECRET` | *(optional)* an OAuth Shared Secret from a Datafordeler IT-system (portal.datafordeler.dk/hjem → your IT-system → "OAuth Shared Secret"); only read when a manual run sets **Named-forest refresh** to `refresh` (docs/adr/0014). Without it, or on a routine deploy, the map's "forests near me" feature just reuses whatever forest data is already cached, or ships with none. |

**Variables** (New repository variable — not sensitive):

| Variable | Value |
|---|---|
| `VITE_SENTRY_DSN` | *(optional)* the Sentry project DSN; blank → the error-monitoring SDK is a no-op |
| `SENTRY_ORG` | *(optional)* Sentry organisation slug (only needed with `SENTRY_AUTH_TOKEN`) |
| `SENTRY_PROJECT` | *(optional)* Sentry project slug, e.g. `svampekortet-web` |

The Sentry org should be created in the **EU region** (`de.sentry.io`); the DSN
then contains `ingest.de.sentry.io`. Errors only — no tracing or session replay.

### 3. First deploy

Actions → **deploy** → **Run workflow**. When it finishes the site is live at
`https://svampekortet.pages.dev`. A custom domain can be added later in the Pages
project settings.

## Notes

- **Timing.** The `weather_daily` DuckDB is cached between runs (`actions/cache`).
  The DMI pull dominates the runtime; **Run workflow** takes a **Weather refresh
  scope** input:
  - `auto` (default) — incremental (last two years, ~5 min of weather), unless
    the cache is cold or it's the monthly-hygiene window **on the scheduled
    run** (ISO week divisible by 4) → full.
  - `skip` — `--skip-dmi`: reuse the cached weather untouched. **Use this for
    frontend / model-code deploys that don't touch data** — the whole run is
    ~12 min instead of ~65.
  - `incremental` / `full` — force that scope.
  A **cold cache** (first run, or a cache evicted after 7 idle days) always does
  the full ~55 min pull. Weekly runs stay well inside the 2,000-minute
  private-repo Actions allowance.
- **Force a full rebuild:** run **Run workflow** with scope `full` (or delete the
  repo's caches under Settings → Actions → Caches and re-run).
- The observation, species and red-list tables are rebuilt from scratch every
  run regardless (unless a step is skipped); only the weather is incremental.
- The backtest (ship gate) runs inside `pipeline.build` and adds ~5–10 min on a
  CI runner — a `skip`-scope run still pays this.
- **Biotope grid refresh** (docs/adr/0016) — the advisory forest-/soil-type
  card on a pin's conditions view. Manual-only, like named forests: **Run
  workflow**'s **Biotope grid refresh** input defaults to `skip` (reuse
  whatever's cached, or ship with none — the card just doesn't show); `refresh`
  re-fetches CORINE + GEUS (a few minutes, no credentials needed, both are
  public no-auth services). It changes on a geological timescale, not weekly.
- Cloudflare Pages gives a preview URL for every deploy; the `--branch=main`
  deploy is the production one.
- **Daily weather top-up cost.** `deploy-weather-daily.yml` pulls only the
  current year (not deploy.yml's "last two years" incremental scope) and
  skips the backtest entirely, so each run should land well under the
  weekly `incremental` run's ~5 min of weather alone — expect a few minutes
  total, not measured yet against a real month of runs. Combined with
  `deploy.yml`'s own weekly cost this should stay comfortably inside the
  2,000-minute private-repo Actions allowance, but worth checking Settings →
  Actions usage after the first few weeks rather than assuming.
