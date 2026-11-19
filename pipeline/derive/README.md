# pipeline/derive

Transforms the ingested tables (`observations`, `weather_daily`) into the tables
the model reads. Pure DuckDB SQL (in `sql/`), no network. Run after the ingest steps.

## observation_weather

```sh
python -m pipeline.derive.observation_weather --report build\observation_weather_report.json
```

Builds:

- **`observation_cell`** — each observation's nearest DMI grid cell + distance (km).
- **`observation_weather`** — per observation, weather summarised over the 30 days
  *before* it fruited: `precip_{7,14,30}d_mm`, `mean_temp_{7,14,30}d_c`,
  `dry_days_30d` (days with < 1 mm — the drought proxy), and `precip_days_covered`
  (0–30; features are NULL when the window predates the loaded weather).
