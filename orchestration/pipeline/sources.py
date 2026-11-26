"""The sources in ingestion/sources.json: each package's exported `name` and `table`, and its folder.

`pnpm generate-sources` in ingestion/ writes the file from every package's src/source.ts, and
`bj new-source` runs it after scaffolding. Dagster builds its SOURCES from the file, so no list of
sources is kept by hand. The orchestration tests fail when the file falls behind the packages.
"""

import json
import re
from dataclasses import dataclass
from pathlib import Path

from pipeline.cli import BadInput

SOURCES_FILE = Path("ingestion/sources.json")

# A load scope's folder name. It reaches a path and the SOURCE_SCOPE variable, so no space, slash or `..`.
SCOPE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


@dataclass(frozen=True)
class SourceEntry:
    name: str
    table: str
    package: str
    # For a package that loads one table on several chains: the chain's folder in the package,
    # chains/<name>, which holds its .env.example and addresses.json. Empty for any other package.
    settings: str = ""
    coverage: dict | None = None

    def folder(self, repo_root: Path) -> Path:
        """The folder with this source's .env, .env.example and addresses.json."""
        return repo_root / "ingestion" / "sources" / self.package / self.settings

    def scopes(self, repo_root: Path) -> list[str]:
        """The load scopes of this source, by name: each folder of scopes/ that holds an addresses.json."""
        folder = self.folder(repo_root) / "scopes"
        if not folder.is_dir():
            return []
        names = sorted(path.name for path in folder.iterdir() if (path / "addresses.json").is_file())
        for name in names:
            if not SCOPE.match(name):
                raise BadInput(f"scope name {name!r} in {folder} must match {SCOPE.pattern}")
        return names


def read_sources(text: str) -> list[SourceEntry]:
    """The entries of sources.json, in file order: sorted by name, then table."""
    try:
        entries = [SourceEntry(**entry) for entry in json.loads(text)]
    except (json.JSONDecodeError, TypeError) as error:
        raise BadInput(f"{SOURCES_FILE} must be a list of {{name, table, package[, settings, coverage]}} objects: {error}") from None
    for entry in entries:
        if not all(isinstance(value, str) and value for value in (entry.name, entry.table, entry.package)):
            raise BadInput(f"{SOURCES_FILE} has an entry whose name, table or package is not a string: {entry}")
        if not isinstance(entry.settings, str):
            raise BadInput(f"{SOURCES_FILE} has an entry whose settings is not a string: {entry}")
        if entry.coverage is not None:
            contract = entry.coverage
            if (not isinstance(contract, dict) or not isinstance(contract.get("unrestricted"), list)
                    or not all(isinstance(key, str) for key in contract["unrestricted"])
                    or not isinstance(contract.get("filters"), list)
                    or not all(isinstance(key, str) for key in contract["filters"])
                    or not set(contract["unrestricted"]) <= set(contract["filters"])
                    or not isinstance(contract.get("defaultPortalUrl", ""), str)
                    or not isinstance(contract.get("defaults", {}), dict)
                    or not all(isinstance(value, int) and not isinstance(value, bool) and value >= 0
                               for value in contract.get("defaults", {}).values())):
                raise BadInput(f"{SOURCES_FILE} has an invalid coverage contract for {entry.name}.{entry.table}")
            invalid = f"{SOURCES_FILE} has an invalid coverage contract for {entry.name}.{entry.table}: caseSensitive"
            case_sensitive = contract.get("caseSensitive", [])
            if not isinstance(case_sensitive, list):
                raise BadInput(f"{invalid} must be a list")
            if not all(isinstance(key, str) for key in case_sensitive):
                raise BadInput(f"{invalid} must contain filter names")
            if not set(case_sensitive) <= set(contract["filters"]):
                raise BadInput(f"{invalid} names {sorted(set(case_sensitive) - set(contract['filters']))}, which are not filters")
    pairs = [(entry.name, entry.table) for entry in entries]
    repeated = sorted({pair for pair in pairs if pairs.count(pair) > 1})
    if repeated:
        raise BadInput(f"{SOURCES_FILE} lists {', '.join(f'{name}.{table}' for name, table in repeated)} more than once")
    return entries
