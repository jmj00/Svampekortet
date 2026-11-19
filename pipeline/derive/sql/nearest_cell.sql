-- observation_id -> nearest DMI grid cell (great-circle distance to the centroid).
CREATE OR REPLACE TABLE observation_cell AS
WITH pairs AS (
    SELECT
        o.observation_id,
        w.cell_id,
        6371.0088 * 2 * asin(sqrt(
            pow(sin(radians(w.cell_lat - o.lat) / 2), 2)
            + cos(radians(o.lat)) * cos(radians(w.cell_lat))
              * pow(sin(radians(w.cell_lon - o.lon) / 2), 2)
        )) AS dist_km
    FROM observations o
    CROSS JOIN (SELECT DISTINCT cell_id, cell_lon, cell_lat FROM weather_daily) w
)
SELECT observation_id, cell_id, dist_km
FROM pairs
QUALIFY row_number() OVER (PARTITION BY observation_id ORDER BY dist_km) = 1;
