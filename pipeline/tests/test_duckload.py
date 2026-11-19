from datetime import date
from pathlib import Path

import duckdb

from pipeline.duckload import copy_rows


def test_copy_rows_types_and_nulls(tmp_path: Path):
    db = tmp_path / "t.duckdb"
    con = duckdb.connect(str(db))
    try:
        con.execute("CREATE TABLE t (name TEXT, day DATE, amount DOUBLE, flag BOOLEAN, note TEXT)")
        n = copy_rows(
            con,
            "t",
            ("name", "day", "amount", "flag", "note"),
            [
                ("a", date(2021, 8, 15), 1.5, True, "hello"),
                ("b", date(2020, 1, 1), None, False, None),
                ("c", date(2019, 12, 31), 0.0, True, ""),
            ],
        )
        assert n == 3
        rows = con.execute("SELECT * FROM t ORDER BY name").fetchall()
    finally:
        con.close()

    assert rows[0] == ("a", date(2021, 8, 15), 1.5, True, "hello")
    assert rows[1] == ("b", date(2020, 1, 1), None, False, None)
    assert rows[2][2] == 0.0
    assert rows[2][3] is True
    assert rows[2][4] is None  # empty string loads as NULL


def test_copy_rows_quoted_fields_past_the_detection_sample(tmp_path: Path):
    """A field needing quotes (comma, embedded quote, newline) must load correctly
    even when the first such row appears well past DuckDB's dialect-sniff sample."""
    db = tmp_path / "t.duckdb"
    con = duckdb.connect(str(db))
    tricky = [
        ("comma", "Mads Helmer Nielsen, MSc Biologi"),
        ("quote", 'she said "hi" then left'),
        ("newline", "line one\nline two"),
    ]
    try:
        con.execute("CREATE TABLE t (id TEXT, note TEXT)")
        plain = [(f"r{i}", f"note {i}") for i in range(21000)]  # > sample_size (20480)
        n = copy_rows(con, "t", ("id", "note"), plain + tricky)
        assert n == len(plain) + len(tricky)
        got = dict(
            con.execute("SELECT id, note FROM t WHERE id IN ('comma','quote','newline')").fetchall()
        )
    finally:
        con.close()
    assert got == dict(tricky)


def test_copy_rows_respects_primary_key(tmp_path: Path):
    db = tmp_path / "t.duckdb"
    con = duckdb.connect(str(db))
    try:
        con.execute("CREATE TABLE t (id TEXT PRIMARY KEY, v INTEGER)")
        copy_rows(con, "t", ("id", "v"), [("x", 1), ("y", 2)])
        count = con.execute("SELECT count(*) FROM t").fetchone()[0]
    finally:
        con.close()
    assert count == 2
