"""bj coverage: the blocks each stream source has loaded, from its START_BLOCK to the cursor Pipes keeps.

Pipes resumes a stream after its cursor and never reads a block twice. Coverage assumes the effective
START_BLOCK and addresses.json still describe the history loaded under that cursor. The cursor does
not retain their old values: after changing either, follow the documented source reset/backfill
procedure before trusting coverage. This command never resets a source or changes its data.
"""

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import psycopg2
from dotenv import dotenv_values

from pipeline.cli import BadInput, require_env
from pipeline.sources import SOURCES_FILE, read_sources
from pipeline.warehouse import read_cursor


# Only these shipped sources define an omitted wallets key as unrestricted. A missing key on an
# unknown source remains a gap; adding a source requires confirming its extraction semantics first.
OPTIONAL_WALLET_SOURCES = {
    ("ethereum", "erc20_transfers"),
    ("arbitrum", "erc20_transfers"),
    ("base", "erc20_transfers"),
    ("polygon", "polymarket_ctf"),
    ("polygon", "polymarket_ctf_exchange_v2"),
}


@dataclass(frozen=True)
class Coverage:
    source: str
    table: str
    raw_table: str
    start_block: int
    start_block_file: str
    cursor: int | None
    filter: dict[str, list[str]]

    @property
    def name(self) -> str:
        return f"{self.source}.{self.table}"

    @property
    def covered(self) -> tuple[int, int] | None:
        return (self.start_block, self.cursor) if self.cursor is not None else None

    def gaps(self, blocks: tuple[int, int], wanted: dict[str, list[str]]) -> list[str]:
        """What the loaded data lacks for these blocks and this subset of addresses.json. Empty when it has it all."""
        first, last = blocks
        gaps = []
        if self.start_block > first:
            gaps.append(f"START_BLOCK {self.start_block} is after {first}")
        if self.cursor is None:
            gaps.append("no run has saved a cursor")
        elif self.cursor < last:
            gaps.append(f"cursor {self.cursor} is before {last}")
        for key, values in wanted.items():
            if key not in self.filter:
                if key == "wallets" and (self.source, self.table) in OPTIONAL_WALLET_SOURCES:
                    continue
                gaps.append(f"addresses.json has no {key!r}")
                continue
            loaded = {value.lower() for value in self.filter[key]}
            missing = [value for value in values if value.lower() not in loaded]
            if missing:
                gaps.append(f"{key} not in addresses.json: {', '.join(missing)}")
        return gaps

    def to_json(self) -> dict[str, Any]:
        return {
            "source": self.name,
            "raw_table": self.raw_table,
            "start_block": self.start_block,
            "start_block_file": self.start_block_file,
            "cursor": self.cursor,
            "filter": self.filter,
            "covered": list(self.covered) if self.covered else None,
        }


def folders(repo_root: Path) -> dict[str, Path]:
    """Every source in sources.json, as <source>.<table>, with the folder of its .env.example and
    addresses.json: its package, or the chain's folder in a package that loads several chains."""
    return {
        f"{entry.name}.{entry.table}": entry.folder(repo_root)
        for entry in read_sources((repo_root / SOURCES_FILE).read_text())
    }


def sources(repo_root: Path) -> list[str]:
    """Every source in sources.json, as <source>.<table>."""
    return list(folders(repo_root))


def stream_sources(repo_root: Path) -> list[str]:
    """The sources that are stream sources: those whose .env.example sets START_BLOCK.
    A stream source needs a first block; a call source reads at one block, or at the tip."""
    return [
        name
        for name, folder in folders(repo_root).items()
        if dotenv_values(folder / ".env.example").get("START_BLOCK")
    ]


def start_block(repo_root: Path, folder: Path) -> tuple[int, str]:
    """The effective START_BLOCK and its origin, including process overrides as ingestion reads them.

    A chain's files precede the package .env. Keep the example fallback for an uninstalled checkout.
    An explicitly empty value wins in dotenv, then loadEnv removes it before validating the required
    START_BLOCK. It must therefore fail here, rather than fall back and claim an earlier start.
    """
    candidates = [("environment", os.environ.get("START_BLOCK"))]
    paths = [folder / ".env", folder / ".env.example"]
    if folder.parent.name == "chains":
        paths.append(folder.parents[1] / ".env")
    candidates.extend(
        (str(path.relative_to(repo_root)), dotenv_values(path, interpolate=False).get("START_BLOCK"))
        for path in paths
    )
    for origin, value in candidates:
        if value is not None:
            return parse_start_block(value, origin), origin
    raise BadInput(f"{folder.relative_to(repo_root)} sets no START_BLOCK in .env or .env.example")


def parse_start_block(value: str, origin: str) -> int:
    """Match ingestion's Number coercion and Zod nonnegative safe-integer validation.

    Restrict the syntax before float/int: Python also accepts underscores, which Number rejects.
    loadEnv removes an empty string, but a whitespace-only value reaches Number and becomes zero.
    """
    text = value.strip()
    try:
        if not value:
            raise ValueError
        if not text:
            number = 0.0
        elif re.fullmatch(r"0(?:[xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)", text):
            number = float(int(text, 0))
        elif re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", text):
            number = float(text)
        else:
            raise ValueError
        if not number.is_integer() or not 0 <= number <= 2**53 - 1:
            raise ValueError
        return int(number)
    except (ValueError, OverflowError):
        raise BadInput(f"START_BLOCK in {origin} must be a block number, not {value!r}") from None


def address_filter(repo_root: Path, folder: Path, *, optional_wallets: bool = False) -> dict[str, list[str]]:
    path = folder / "addresses.json"
    label = path.relative_to(repo_root)
    try:
        addresses = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise BadInput(f"could not read {label}: {error}") from None
    if not isinstance(addresses, dict):
        raise BadInput(f"{label} must map each key to an address or a list of addresses")
    if optional_wallets and "wallets" in addresses:
        wallets = addresses["wallets"]
        if not isinstance(wallets, list) or not wallets or not all(isinstance(w, str) and w for w in wallets):
            raise BadInput(f"{label}: wallets must be a nonempty list of addresses; omit it to read every wallet")
    # A source may name one contract per key, such as polygon-polymarket-ctf's conditional_tokens.
    lists = {key: [values] if isinstance(values, str) else values for key, values in addresses.items()}
    if not all(isinstance(values, list) and all(isinstance(value, str) for value in values) for values in lists.values()):
        raise BadInput(f"{label} must map each key to an address or a list of addresses")
    return lists


def read(repo_root: Path, name: str) -> Coverage:
    source, table = name.split(".")
    folder = folders(repo_root)[name]
    block, block_file = start_block(repo_root, folder)
    schema = os.environ["RAW_SCHEMA"]
    try:
        cursor = read_cursor(f"{source}_{table}")
    except psycopg2.Error as error:
        raise BadInput(f"could not read the cursor in {schema}._sync: {' '.join(str(error).split())}") from None
    loaded_filter = address_filter(
        repo_root, folder, optional_wallets=(source, table) in OPTIONAL_WALLET_SOURCES
    )
    return Coverage(source, table, f"{schema}.{source}_{table}", block, block_file, cursor, loaded_filter)


def run(repo_root: Path, name: str | None) -> int:
    streams = stream_sources(repo_root)
    if name is not None and name not in streams:
        raise BadInput(f"{name!r} is not a stream source; stream sources: {', '.join(streams) or 'none'}")
    require_env()
    coverages = [read(repo_root, stream).to_json() for stream in ([name] if name else streams)]
    print(json.dumps(coverages[0] if name else coverages, indent=2))
    return 0
