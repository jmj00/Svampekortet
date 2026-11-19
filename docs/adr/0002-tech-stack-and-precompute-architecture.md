# 2. Tech stack and precompute-first architecture

Date: 2026-09-01

## Status

Accepted. The "Jutland" scope below was widened to all of Denmark by
[ADR-0010](0010-expand-study-area-to-denmark.md); the architecture is unchanged.

## Context

Solo project, no budget, no fixed schedule. MVP scope is Jutland plus roughly six
edible species. The app must work well on a phone and be reachable from a desktop.
Offline use and user accounts are explicitly out of scope for the MVP.

For that scope the entire prediction surface (per-species habitat grids + fruiting
curves + current weather) is small — kilobytes to a few megabytes. A running
backend would add cost, ops burden and a failure mode for no MVP benefit.

## Decision

**Client:** a responsive PWA — React + Vite + TypeScript, MapLibre GL for the map,
Danish public basemaps (SDFI / Datafordeler) with OpenStreetMap as fallback. One
codebase for mobile and desktop, deployed as static files. No app store, no native
build chain.

**Pipeline:** Python, run on a schedule by GitHub Actions (weekly for observations,
daily for current weather). Processing uses DuckDB with the spatial extension —
file-based, nothing to host. A local Docker PostGIS is available if a query needs
it.

**Delivery:** the pipeline publishes static artifacts (per-species JSON grids,
observation vector tiles as PMTiles, a small current-conditions file). The client
reads them directly and does the final weather adjustment for a pin in the browser.

**Hosting:** Cloudflare Pages (static, free) for the app; GitHub Actions free
minutes for the pipeline; Cloudflare R2 free tier if artifacts outgrow the repo.

**Deferred:** a real backend (FastAPI + PostgreSQL/PostGIS on a Hetzner EU VPS,
~EUR 4.5/month, or managed Postgres on Supabase Frankfurt / Neon EU) arrives only
with Phase 3 features that need it — user submissions, arbitrary-point live
queries, accounts, push notifications.

## Consequences

- Near-zero running cost and no server to operate for the MVP.
- "Prediction" is a lookup into a precomputed grid plus a small client-side step;
  arbitrary-point precision is limited by grid resolution until the backend lands.
- The static-precompute path stays useful later as a cache layer in front of the API.
- Cloudflare is US-headquartered; acceptable while the MVP collects no personal
  data. Revisit against GDPR when accounts are added.
