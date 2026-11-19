# Phase 0 spikes

Throwaway probes, no API keys. Run from the repo root. Delete them once P1
replaces each with a real, tested ingest module.

Standard library only, with one optional exception: `truststore` (in the `dev`
extra). It is auto-used if installed and lets Python trust the OS certificate
store — needed on machines/networks that do TLS inspection. Install it with
`py -m pip install -e ".[dev]"`.

| Spike | Question it answers | Command |
|---|---|---|
| `gbif_counts.py` | Are there enough georeferenced Jutland records per target species to model? | `py -m pipeline.spikes.gbif_counts` |
| `dwca_inspect.py` | What do the Darwin Core archives actually contain — licence mix, sensitive-taxa flags, coordinate precision, Danish names? | `py -m pipeline.spikes.dwca_inspect <archive.zip>` |
| `dmi_climate_pull.py` | Is DMI reachable without a key, which parameters exist, what does the 10 km grid `cellId` look like? | `py -m pipeline.spikes.dmi_climate_pull` |

The Red List spike was replaced by `pipeline.ingest.redlist` (real module + guard).

Output goes to `pipeline/spikes/out/` (git-ignored).

Paste findings into `docs/data-sources.md` and check off the questions there.
The go/no-go call for the current species list comes from `gbif_counts`.
