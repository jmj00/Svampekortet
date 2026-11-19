"""Fast bulk-insert into DuckDB.

DuckDB's `executemany` is ~1000x slower than a `COPY` from CSV on this platform
(a 50k-row `executemany` did not finish in 100s; the equivalent `COPY` took 0.1s).
So every bulk load goes through a throwaway CSV.
"""

from __future__ import annotations

import csv
import tempfile
from collections.abc import Iterable, Sequence
from pathlib import Path

import duckdb


def _cell(value: object) -> object:
    if value is None:
        return ""
    if isinstance(value, bool):  # DuckDB CSV wants 0/1, not "True"/"False"
        return int(value)
    return value


def copy_rows(
    con: duckdb.DuckDBPyConnection,
    table: str,
    columns: Sequence[str],
    rows: Iterable[Sequence[object]],
) -> int:
    """Bulk-insert `rows` (tuples in `columns` order) into `table`; return the count.

    Values are written as CSV: `None` and empty strings both load as SQL NULL, and
    DATE columns want ISO `YYYY-MM-DD` strings or `datetime.date`. Callers already
    normalise "" to None, so the NULL collapsing is intended.
    """
    handle, name = tempfile.mkstemp(suffix=".csv", prefix="duckload-")
    path = Path(name)
    count = 0
    try:
        with open(handle, "w", newline="", encoding="utf-8") as fh:
            writer = csv.writer(fh)  # default dialect: ',' delim, '"' quote, '""' escape
            writer.writerow(columns)
            for row in rows:
                writer.writerow([_cell(value) for value in row])
                count += 1
        column_list = ", ".join(columns)
        # Pin the dialect to what csv.writer emitted. DuckDB otherwise auto-detects
        # it from a sample of the first rows, and a quoted field that first appears
        # past that sample (e.g. a `recordedBy` with a comma) is then mis-split.
        con.execute(
            f"COPY {table} ({column_list}) FROM '{path.as_posix()}' "
            "(FORMAT CSV, HEADER, DELIMITER ',', QUOTE '\"', ESCAPE '\"')"
        )
    finally:
        path.unlink(missing_ok=True)
    return count
