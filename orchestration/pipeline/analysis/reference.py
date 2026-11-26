"""Compares an analysis's rows with an answer's reference rows. Pure: it reads no file and no warehouse."""

import re
from dataclasses import dataclass
from decimal import Context, Decimal, InvalidOperation
from typing import Literal, Sequence

from pipeline.cli import BadInput

NUMBER = re.compile(r"^-?\d+(\.\d+)?$")
HEX = re.compile(r"^0x[0-9a-fA-F]+$")

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
        limit = EXACT.multiply(limit, abs(expected))
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
