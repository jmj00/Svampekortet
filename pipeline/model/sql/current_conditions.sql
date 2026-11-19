-- Antecedent weather per DMI grid cell as of :anchor (bound twice via CROSS
-- JOIN -- once per CTE). Same windows and dry-day rule as
-- pipeline/derive/sql/weather_features.sql, so the "current" vector is
-- directly comparable to the historic per-species distributions the weather
-- term is fitted on. Two CTEs for the same fan-out reason: `recent` and
-- `prior_summer` never overlap in time, and aggregating both against the same
-- cell in one query would multiply each other's sums.
WITH recent AS (
    SELECT
        w.cell_id,
        any_value(w.cell_lon) AS cell_lon,
        any_value(w.cell_lat) AS cell_lat,
        sum(w.value) FILTER (
            WHERE w.parameter = 'acc_precip' AND w.date >= ref.anchor - 7
        ) AS precip_7d_mm,
        sum(w.value) FILTER (
            WHERE w.parameter = 'acc_precip' AND w.date >= ref.anchor - 14
        ) AS precip_14d_mm,
        sum(w.value) FILTER (
            WHERE w.parameter = 'acc_precip' AND w.date >= ref.anchor - 30
        ) AS precip_30d_mm,
        sum(w.value) FILTER (WHERE w.parameter = 'acc_precip') AS precip_60d_mm,
        avg(w.value) FILTER (
            WHERE w.parameter = 'mean_temp' AND w.date >= ref.anchor - 7
        ) AS mean_temp_7d_c,
        avg(w.value) FILTER (
            WHERE w.parameter = 'mean_temp' AND w.date >= ref.anchor - 14
        ) AS mean_temp_14d_c,
        avg(w.value) FILTER (
            WHERE w.parameter = 'mean_temp' AND w.date >= ref.anchor - 30
        ) AS mean_temp_30d_c,
        count(*) FILTER (
            WHERE w.parameter = 'acc_precip' AND w.date >= ref.anchor - 30 AND w.value < 1.0
        ) AS dry_days_30d,
        count(DISTINCT w.date) FILTER (
            WHERE w.parameter = 'acc_precip' AND w.date >= ref.anchor - 30
        ) AS precip_days_covered,
        count(DISTINCT w.date) FILTER (WHERE w.parameter = 'acc_precip')
            AS precip_60d_days_covered
    FROM weather_daily w
    CROSS JOIN (SELECT CAST(? AS DATE) AS anchor) ref
    WHERE w.date BETWEEN ref.anchor - 60 AND ref.anchor - 1
    GROUP BY w.cell_id
),
prior_summer AS (
    SELECT
        ws.cell_id,
        sum(ws.value) FILTER (WHERE ws.parameter = 'acc_precip') AS prior_summer_precip_mm,
        count(DISTINCT ws.date) FILTER (WHERE ws.parameter = 'acc_precip')
            AS prior_summer_days_covered
    FROM weather_daily ws
    CROSS JOIN (SELECT CAST(? AS DATE) AS anchor) ref
    WHERE ws.date BETWEEN make_date(year(ref.anchor) - 1, 6, 1)
                       AND make_date(year(ref.anchor) - 1, 8, 31)
    GROUP BY ws.cell_id
)
SELECT
    recent.cell_id,
    recent.cell_lon,
    recent.cell_lat,
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
FROM recent
LEFT JOIN prior_summer USING (cell_id)
ORDER BY recent.cell_id;
