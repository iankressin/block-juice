"""Compares an analysis's rows with an answer's reference rows. `mismatches` is pure; `reference_check` reads the
answer folder's reference.csv and the analysis's rows, and touches no warehouse."""

import csv
import re
from dataclasses import dataclass
from decimal import Context, Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Literal, Sequence

from pipeline.analysis.domain import Check, Result, cell_text
from pipeline.cli import BadInput

NUMBER = re.compile(r"^-?\d+(\.\d+)?$")
HEX = re.compile(r"^0x[0-9a-fA-F]+$")

# How many mismatches the check's detail names; the rest are in the count.
MISMATCHES_SHOWN = 5

REFERENCE_KEYS = ("analysis", "key", "value", "tolerance", "oracle")

# Wide enough that no subtraction or product of two wei-sized amounts rounds.
EXACT = Context(prec=200)

# A normalized key cell is (0, number) or (1, text), so a column that mixes both still sorts.
Cell = tuple[int, Decimal | str]


@dataclass(frozen=True)
class Reference:
    analysis: str
    key: tuple[str, ...]
    value: str
    kind: Literal["absolute", "relative"]
    tolerance: Decimal
    oracle: str = ""


@dataclass(frozen=True)
class Mismatch:
    key: tuple[str, ...]
    expected: str | None
    actual: str | None
    reason: str


def normalize(cell: str) -> Cell:
    if NUMBER.match(cell):
        return (0, Decimal(cell))
    if HEX.match(cell):
        return (1, cell.lower())
    return (1, cell)


def index(
    rows: Sequence[dict[str, str]], reference: Reference, who: str, lacks: str
) -> dict[tuple[Cell, ...], list[tuple[tuple[str, ...], Decimal | None]]]:
    """Group rows by normalized key. Each entry keeps the key as written and the parsed value."""
    grouped: dict[tuple[Cell, ...], list[tuple[tuple[str, ...], Decimal | None]]] = {}
    for row in rows:
        for column in (*reference.key, reference.value):
            if column not in row:
                raise BadInput(f"{who} {lacks} {column}")
        cell = row[reference.value]
        value = None
        if cell != "":
            try:
                value = Decimal(cell)
            except InvalidOperation:
                value = None
            if value is None or not value.is_finite():
                raise BadInput(f"{who}: column {reference.value} holds {cell!r}, not a number")
        written = tuple(row[column] for column in reference.key)
        grouped.setdefault(tuple(normalize(c) for c in written), []).append((written, value))
    return grouped


def differs(expected: Decimal | None, actual: Decimal | None, reference: Reference) -> bool:
    if expected is None or actual is None:
        return (expected is None) != (actual is None)
    limit = reference.tolerance
    if reference.kind == "relative" and expected != 0:
        limit = EXACT.multiply(limit, expected.copy_abs())
    return EXACT.subtract(actual, expected).copy_abs() > limit


def mismatches(
    expected: Sequence[dict[str, str]], actual: Sequence[dict[str, str]], reference: Reference
) -> list[Mismatch]:
    """The keys where the analysis disagrees with the reference, sorted by key. Per key, the first
    reason that applies: a key twice in expected, twice in actual, only in expected, only in actual,
    or a value over the tolerance."""
    want = index(expected, reference, "reference.csv", "has no column")
    got = index(actual, reference, f"the analysis {reference.analysis}", "returns no column")
    found: list[tuple[tuple[Cell, ...], Mismatch]] = []
    for key in want.keys() | got.keys():
        e_rows, a_rows = want.get(key, []), got.get(key, [])
        written = (e_rows or a_rows)[0][0]
        e_value = e_rows[0][1] if e_rows else None
        a_value = a_rows[0][1] if a_rows else None
        if len(e_rows) > 1:
            reason = "duplicate_in_expected"
        elif len(a_rows) > 1:
            reason = "duplicate_in_actual"
        elif not a_rows:
            reason = "missing_in_actual"
        elif not e_rows:
            reason = "missing_in_expected"
        elif differs(e_value, a_value, reference):
            reason = "over_tolerance"
        else:
            continue
        found.append((key, Mismatch(written, _text(e_value), _text(a_value), reason)))
    return [m for _, m in sorted(found, key=lambda pair: pair[0])]


def _text(value: Decimal | None) -> str | None:
    return None if value is None else format(value, "f")


def parse_reference(raw: dict, analyses: Sequence[str], label: str) -> Reference:
    for name in raw:
        if name not in REFERENCE_KEYS:
            raise BadInput(f"{label}: 'reference' has unknown key {name!r}; allowed keys: {', '.join(REFERENCE_KEYS)}")
    for name in ("analysis", "key", "value", "tolerance"):
        if name not in raw:
            raise BadInput(f"{label}: 'reference.{name}' is required")
    analysis, key, value = raw["analysis"], raw["key"], raw["value"]
    if analysis not in analyses:
        raise BadInput(f"{label}: 'reference.analysis' must be one of the analyses: {', '.join(analyses)}")
    if not (isinstance(key, list) and key and all(isinstance(c, str) and c for c in key) and len(set(key)) == len(key)):
        raise BadInput(f"{label}: 'reference.key' must be a non-empty list of distinct column names")
    if not isinstance(value, str) or not value or value in key:
        raise BadInput(f"{label}: 'reference.value' must be a column name that is not in 'reference.key'")
    tolerance = raw["tolerance"]
    if not isinstance(tolerance, dict) or set(tolerance) != {"kind", "value"}:
        raise BadInput(f"{label}: 'reference.tolerance' must be a map with 'kind' and 'value'")
    if tolerance["kind"] not in ("absolute", "relative"):
        raise BadInput(f"{label}: 'reference.tolerance.kind' must be absolute or relative")
    limit = tolerance["value"]
    if isinstance(limit, bool) or not isinstance(limit, (int, float)) or limit < 0 or limit != limit or limit == float("inf"):
        raise BadInput(f"{label}: 'reference.tolerance.value' must be a number of zero or more")
    oracle = raw.get("oracle", "")
    if not isinstance(oracle, str):
        raise BadInput(f"{label}: 'reference.oracle' must be a string")
    return Reference(analysis, tuple(key), value, tolerance["kind"], Decimal(str(limit)), oracle)


def reference_check(folder: Path, results: Sequence[Result], reference: Reference) -> Check:
    """Compare the reference analysis's rows with `folder`/reference.csv, where `folder` is answers/<slug>."""
    result = next((r for r in results if r.analysis == reference.analysis), None)
    if result is None:
        raise BadInput(f"the analysis {reference.analysis} did not run")
    wanted = (*reference.key, reference.value)
    with (folder / "reference.csv").open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        _need(reader.fieldnames or [], wanted, "reference.csv has no column")
        expected = []
        for row in reader:
            # DictReader fills a missing cell with None and keeps extra cells under the key None.
            if None in row or None in row.values():
                more = "more" if None in row else "fewer"
                raise BadInput(f"answers/{folder.name}/reference.csv: line {reader.line_num} has {more} cells than the header")
            expected.append(row)
    if result.csv_path is not None:
        with result.csv_path.open(encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            _need(reader.fieldnames or [], wanted, f"the analysis {reference.analysis} returns no column")
            actual: list[dict[str, Any]] = list(reader)
    else:
        _need(result.columns, wanted, f"the analysis {reference.analysis} returns no column")
        actual = [dict(zip(result.columns, map(cell_text, row))) for row in result.rows]
    found = mismatches(expected, actual, reference)
    detail = f"{len(found)} mismatches over tolerance"
    if found:
        shown = ", ".join(f"({', '.join(m.key)}) {m.reason}" for m in found[:MISMATCHES_SHOWN])
        detail += f"; first: {shown}"
    return Check("reference_match", not found, detail)


def _need(columns: Sequence[str], wanted: Sequence[str], message: str) -> None:
    for column in wanted:
        if column not in columns:
            raise BadInput(f"{message} {column}")
