-- Antecedent-weather features per observation. Two CTEs, not one join:
-- `recent`'s window (up to 60 days before the observation) and `prior_summer`'s
-- (Jun-Aug of the *previous* calendar year) never overlap, and joining +
-- aggregating both against the same observation in one query would fan out --
-- each one-to-many join multiplies the other's sums. See docs/adr/0017.
CREATE OR REPLACE TABLE observation_weather AS
WITH recent AS (
    SELECT
        o.observation_id,
        sum(w.value) FILTER (
            WHERE w.parameter = 'acc_precip' AND w.date >= o.observed_on - 7
        ) AS precip_7d_mm,
        sum(w.value) FILTER (
            WHERE w.parameter = 'acc_precip' AND w.date >= o.observed_on - 14
        ) AS precip_14d_mm,
        sum(w.value) FILTER (
            WHERE w.parameter = 'acc_precip' AND w.date >= o.observed_on - 30
        ) AS precip_30d_mm,
        sum(w.value) FILTER (WHERE w.parameter = 'acc_precip') AS precip_60d_mm,
        avg(w.value) FILTER (
            WHERE w.parameter = 'mean_temp' AND w.date >= o.observed_on - 7
        ) AS mean_temp_7d_c,
        avg(w.value) FILTER (
            WHERE w.parameter = 'mean_temp' AND w.date >= o.observed_on - 14
        ) AS mean_temp_14d_c,
        avg(w.value) FILTER (
            WHERE w.parameter = 'mean_temp' AND w.date >= o.observed_on - 30
        ) AS mean_temp_30d_c,
        count(*) FILTER (
            WHERE w.parameter = 'acc_precip' AND w.date >= o.observed_on - 30 AND w.value < 1.0
        ) AS dry_days_30d,
        coalesce(
            count(DISTINCT w.date) FILTER (
                WHERE w.parameter = 'acc_precip' AND w.date >= o.observed_on - 30
            ), 0
        ) AS precip_days_covered,
        coalesce(count(DISTINCT w.date) FILTER (WHERE w.parameter = 'acc_precip'), 0)
            AS precip_60d_days_covered
    FROM observations o
    LEFT JOIN observation_cell oc USING (observation_id)
    LEFT JOIN weather_daily w
        ON w.cell_id = oc.cell_id
       AND w.date BETWEEN o.observed_on - 60 AND o.observed_on - 1
    GROUP BY o.observation_id
),
prior_summer AS (
    -- Prior-year legacy signal (ADR-0017): meteorological summer (Jun-Aug) of
    -- the year *before* the fruiting date, at the same cell -- the literature's
    -- best-reported multi-year predictor of mushroom yield.
    SELECT
        o.observation_id,
        sum(ws.value) FILTER (WHERE ws.parameter = 'acc_precip') AS prior_summer_precip_mm,
        coalesce(count(DISTINCT ws.date) FILTER (WHERE ws.parameter = 'acc_precip'), 0)
            AS prior_summer_days_covered
    FROM observations o
    LEFT JOIN observation_cell oc USING (observation_id)
    LEFT JOIN weather_daily ws
        ON ws.cell_id = oc.cell_id
       AND ws.date BETWEEN make_date(year(o.observed_on) - 1, 6, 1)
                        AND make_date(year(o.observed_on) - 1, 8, 31)
    GROUP BY o.observation_id
)
SELECT
    o.observation_id,
    oc.cell_id,
    oc.dist_km,
    recent.precip_7d_mm,
    recent.precip_14d_mm,
    recent.precip_30d_mm,
    recent.precip_60d_mm,
    recent.mean_temp_7d_c,
    recent.mean_temp_14d_c,
    recent.mean_temp_30d_c,
    recent.dry_days_30d,
    recent.precip_days_covered,
    recent.precip_60d_days_covered,
    prior_summer.prior_summer_precip_mm,
    prior_summer.prior_summer_days_covered
FROM observations o
LEFT JOIN observation_cell oc USING (observation_id)
LEFT JOIN recent USING (observation_id)
LEFT JOIN prior_summer USING (observation_id);
