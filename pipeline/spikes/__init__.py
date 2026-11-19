"""Phase 0 spikes: prove each data source is reachable and usable.

These are deliberately dependency-free (standard library only) and throwaway.
Run from the repo root, e.g. `py -m pipeline.spikes.gbif_counts`.
"""

from __future__ import annotations

import sys


def use_utf8_stdout() -> None:
    """Make the Windows console print UTF-8 (species author strings, Danish letters)."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8")
