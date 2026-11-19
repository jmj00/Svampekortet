-- Antecedent weather for a caller-populated TEMP TABLE
--   bg_samples(sample_id BIGINT, cell_id TEXT, anchor DATE)
-- Same windows and dry-day rule as pipeline/derive/sql/weather_features.sql, so
-- a background point is scored on exactly the features the model was fitted
-- on. Two CTEs for the same fan-out reason as weather_features.sql /
-- current_conditions.sql. Column order after `sample_id` is every
-- WEATHER_FEATURES value in order, then every feature's own coverage count in
-- the same order (pipeline/model/backtest.py relies on that pairing).
WITH recent AS (
    SELECT
        b.sample_id,
        sum(w.value) FILTER (
            WHERE w.parameter = 'acc_precip' AND w.date >= b.anchor - 14
        ) AS precip_14d_mm,
        sum(w.value) FILTER (
            WHERE w.parameter = 'acc_precip' AND w.date >= b.anchor - 30
        ) AS precip_30d_mm,
        avg(w.value) FILTER (
            WHERE w.parameter = 'mean_temp' AND w.date >= b.anchor - 14
        ) AS mean_temp_14d_c,
        count(*) FILTER (
            WHERE w.parameter = 'acc_precip' AND w.date >= b.anchor - 30 AND w.value < 1.0
        ) AS dry_days_30d,
        sum(w.value) FILTER (WHERE w.parameter = 'acc_precip') AS precip_60d_mm,
        count(DISTINCT w.date) FILTER (
            WHERE w.parameter = 'acc_precip' AND w.date >= b.anchor - 30
        ) AS precip_days_covered,
        count(DISTINCT w.date) FILTER (WHERE w.parameter = 'acc_precip')
            AS precip_60d_days_covered
    FROM bg_samples b
    JOIN weather_daily w
        ON w.cell_id = b.cell_id
       AND w.date BETWEEN b.anchor - 60 AND b.anchor - 1
    GROUP BY b.sample_id
),
prior_summer AS (
    SELECT
        b.sample_id,
        sum(ws.value) FILTER (WHERE ws.parameter = 'acc_precip') AS prior_summer_precip_mm,
        count(DISTINCT ws.date) FILTER (WHERE ws.parameter = 'acc_precip')
            AS prior_summer_days_covered
    FROM bg_samples b
    JOIN weather_daily ws
        ON ws.cell_id = b.cell_id
       AND ws.date BETWEEN make_date(year(b.anchor) - 1, 6, 1)
                        AND make_date(year(b.anchor) - 1, 8, 31)
    GROUP BY b.sample_id
)
SELECT
    recent.sample_id,
    -- WEATHER_FEATURES values, in WEATHER_FEATURES order
    recent.precip_14d_mm,
    recent.precip_30d_mm,
    recent.mean_temp_14d_c,
    recent.dry_days_30d,
    recent.precip_60d_mm,
    prior_summer.prior_summer_precip_mm,
    -- each feature's own coverage count, same order
    recent.precip_days_covered,
    recent.precip_days_covered,
    recent.precip_days_covered,
    recent.precip_days_covered,
    recent.precip_60d_days_covered,
    prior_summer.prior_summer_days_covered
FROM recent
LEFT JOIN prior_summer USING (sample_id)
-- fixed order: ties in precision@k and the isotonic calibrator depend on it
ORDER BY sample_id;
