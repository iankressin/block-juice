"""The sources in ingestion/sources.json: each package's exported `name` and `table`, and its folder.

`pnpm generate-sources` in ingestion/ writes the file from every package's src/source.ts, and
`bj new-source` runs it after scaffolding. Dagster builds its SOURCES from the file, so no list of
sources is kept by hand. The orchestration tests fail when the file falls behind the packages.
"""

import json
from dataclasses import dataclass
from pathlib import Path

from pipeline.cli import BadInput

SOURCES_FILE = Path("ingestion/sources.json")


@dataclass(frozen=True)
class SourceEntry:
    name: str
    table: str
    package: str


def read_sources(text: str) -> list[SourceEntry]:
    """The entries of sources.json, in file order: sorted by name, then table."""
    try:
        entries = [SourceEntry(**entry) for entry in json.loads(text)]
    except (json.JSONDecodeError, TypeError) as error:
        raise BadInput(f"{SOURCES_FILE} must be a list of {{name, table, package}} objects: {error}") from None
    for entry in entries:
        if not all(isinstance(value, str) and value for value in (entry.name, entry.table, entry.package)):
            raise BadInput(f"{SOURCES_FILE} has an entry whose name, table or package is not a string: {entry}")
    pairs = [(entry.name, entry.table) for entry in entries]
    repeated = sorted({pair for pair in pairs if pairs.count(pair) > 1})
    if repeated:
        raise BadInput(f"{SOURCES_FILE} lists {', '.join(f'{name}.{table}' for name, table in repeated)} more than once")
    return entries
