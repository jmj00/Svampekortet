"""Read the core file of a Darwin Core Archive (a zip with a `meta.xml` descriptor).

    with DwcArchive(path) as archive:
        for record in archive.iter_core():
            record["scientificName"]  # -> str

Only the core file is read; extensions are ignored. Values are returned as strings
exactly as they appear in the archive.
"""

from __future__ import annotations

import csv
import zipfile
from collections.abc import Iterator
from pathlib import Path
from types import TracebackType
from xml.etree import ElementTree as ET

_DWC_NS = {"d": "http://rs.tdwg.org/dwc/text/"}


class DwcArchive:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._zip: zipfile.ZipFile | None = None
        self._core_location = ""
        self._fields: dict[int, str] = {}
        self._delimiter = "\t"
        self._skip_lines = 0

    def __enter__(self) -> DwcArchive:
        self._zip = zipfile.ZipFile(self.path)
        self._read_descriptor()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        if self._zip is not None:
            self._zip.close()
            self._zip = None

    def _read_descriptor(self) -> None:
        assert self._zip is not None
        core = ET.fromstring(self._zip.read("meta.xml")).find("d:core", _DWC_NS)
        if core is None:
            raise ValueError(f"{self.path.name}: meta.xml has no <core> element")

        location_el = core.find("d:files/d:location", _DWC_NS)
        if location_el is None or not location_el.text:
            raise ValueError(f"{self.path.name}: <core> has no file location")
        self._core_location = location_el.text.strip()

        id_el = core.find("d:id", _DWC_NS)
        if id_el is not None and id_el.get("index") is not None:
            self._fields[int(id_el.get("index"))] = "_id"
        for field in core.findall("d:field", _DWC_NS):
            index = field.get("index")
            if index is not None:
                self._fields[int(index)] = field.get("term", "").rsplit("/", 1)[-1]

        raw_delim = core.get("fieldsTerminatedBy", "\\t")
        self._delimiter = raw_delim.encode().decode("unicode_escape") or "\t"
        self._skip_lines = int(core.get("ignoreHeaderLines", "0"))

    @property
    def core_location(self) -> str:
        return self._core_location

    @property
    def fields(self) -> dict[int, str]:
        return dict(self._fields)

    def iter_core(self) -> Iterator[dict[str, str]]:
        if self._zip is None:
            raise RuntimeError("use DwcArchive as a context manager")
        with self._zip.open(self._core_location) as raw:
            reader = csv.reader(
                (line.decode("utf-8", "replace") for line in raw),
                delimiter=self._delimiter,
            )
            for _ in range(self._skip_lines):
                next(reader, None)
            for row in reader:
                yield {self._fields[i]: value for i, value in enumerate(row) if i in self._fields}
