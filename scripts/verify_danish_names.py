"""Check each target species' `danish_name` against the `vernacularName` carried
in the Svampeatlas Darwin Core archive — the canonical source for the Danish name
(see docs/adr/0003-species-name-resolution.md).

    py scripts/verify_danish_names.py path/to/dwcarchive.zip             # report only
    py scripts/verify_danish_names.py path/to/dwcarchive.zip --apply     # + flip matched flags
    py scripts/verify_danish_names.py path/to/dwcarchive.zip --adopt     # + overwrite names

For every kept record the archive's `vernacularName` is tallied per species. A
species is **verified** when its `danish_name` equals the archive's most-common
Danish name ignoring case and hyphen/space style. `--apply` flips
`danish_name_verified` to `True` for those in `pipeline/species.py`. `--adopt`
additionally overwrites `danish_name` with the Title-cased archive name for the
mismatches and verifies them too — the archive is the source of truth
(ADR-0003), so a mismatch means our name is wrong.
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

from pipeline.dwca import DwcArchive
from pipeline.ingest.svampeatlas import match_species
from pipeline.species import TARGET_SPECIES

SPECIES_PY = Path(__file__).resolve().parent.parent / "pipeline" / "species.py"


def _norm(name: str) -> str:
    """Lower-case, trim, collapse runs of space/hyphen to a single space."""
    return re.sub(r"[\s-]+", " ", name.strip().lower())


def scan(archive_path: Path) -> dict[str, Counter[str]]:
    names: dict[str, Counter[str]] = defaultdict(Counter)
    scanned = 0
    with DwcArchive(archive_path) as archive:
        for record in archive.iter_core():
            scanned += 1
            if scanned % 200_000 == 0:
                print(f"  ...{scanned:,} rows", file=sys.stderr)
            species = match_species(record.get("scientificName", ""))
            if species is None:
                continue
            vernacular = (record.get("vernacularName") or "").strip()
            if vernacular:
                names[species["scientific_name"]][vernacular] += 1
    return names


def _titlecase_da(name: str) -> str:
    """Capitalise the first letter of every space- or hyphen-separated token."""
    return re.sub(r"(^|[\s-])([a-zæøå])", lambda m: m.group(1) + m.group(2).upper(), name.strip())


def rewrite(names: dict[str, str], *, verify_only: set[str]) -> int:
    """`names`: scientific_name -> new danish_name (already Title-cased). Every key
    also has its `danish_name_verified` set to True. `verify_only` species keep
    their name and only get the flag flipped. Anchored on `"scientific_name"`,
    which sits directly after the two name fields in `pipeline/species.py`."""
    text = SPECIES_PY.read_text(encoding="utf-8")
    changed = 0
    for sci in names.keys() | verify_only:
        new_name = names.get(sci)
        block = re.compile(
            r'("danish_name":\s*")(?P<old>[^"]*)("\s*,\s*\n\s*"danish_name_verified":\s*)'
            r"(?:True|False)"
            r'(\s*,\s*\n\s*"scientific_name":\s*"' + re.escape(sci) + r'",)'
        )

        def repl(m: re.Match[str], new_name: str | None = new_name) -> str:
            name = new_name if new_name is not None else m.group("old")
            return m.group(1) + name + m.group(3) + "True" + m.group(4)

        text, n = block.subn(repl, text, count=1)
        changed += n
    if changed:
        SPECIES_PY.write_text(text, encoding="utf-8")
    return changed


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("archive", type=Path, help="Svampeatlas dwcarchive.zip")
    ap.add_argument("--apply", action="store_true", help="flip danish_name_verified for matches")
    ap.add_argument(
        "--adopt", action="store_true", help="also overwrite mismatched names with the archive's"
    )
    args = ap.parse_args()

    found = scan(args.archive)

    verify_only: set[str] = set()
    adopt: dict[str, str] = {}
    print(f"\n{'scientific name':32} {'our danish_name':26} {'archive (top)':26} verdict")
    print("-" * 100)
    for s in TARGET_SPECIES:
        sci = s["scientific_name"]
        ours = s["danish_name"]
        counter = found.get(sci)
        if not counter:
            print(f"{sci:32} {ours:26} {'—':26} NO ARCHIVE NAME")
            continue
        # some cells carry alternates: "spiselig rørhat; Karl Johan"
        alts = {a for name, _ in counter.most_common() for a in re.split(r"[;,]", name)}
        top = counter.most_common(1)[0][0]
        if any(_norm(a) == _norm(ours) for a in alts):
            verdict = "MATCH" + ("" if s["danish_name_verified"] else "  -> verify")
            if not s["danish_name_verified"]:
                verify_only.add(sci)
        else:
            adopt[sci] = _titlecase_da(top)
            verdict = f"DIFFERS -> {adopt[sci]}"
        print(f"{sci:32} {ours:26} {top:26} {verdict}")

    print(f"\n{len(verify_only)} newly matched, {len(adopt)} mismatched.")
    if args.adopt:
        n = rewrite(adopt, verify_only=verify_only)
        print(
            f"adopted {len(adopt)} archive names + flipped {len(verify_only)} flags "
            f"({n} entries touched) in {SPECIES_PY.name}"
        )
    elif args.apply and verify_only:
        n = rewrite({}, verify_only=verify_only)
        print(f"flipped danish_name_verified -> True for {n} species in {SPECIES_PY.name}")
    else:
        print("re-run with --apply (flags only) or --adopt (names + flags).")


if __name__ == "__main__":
    main()
