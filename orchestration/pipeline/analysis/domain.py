"""Analysis values shared by execution, persisted results and renderers."""
import json
import math
from dataclasses import dataclass
from collections.abc import Sequence
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any
from pipeline.cli import utc_iso

MAX_SAFE_INTEGER = 2**53 - 1

@dataclass(frozen=True, order=True)
class Input:
    """A raw table an answer reads, found through the dbt sources its analyses depend on."""

    source: str
    table: str
    raw_table: str

    @property
    def name(self) -> str:
        return f"{self.source}.{self.table}"

    @property
    def source_table(self) -> str:
        """The key of the input's dead letters."""
        return f"{self.source}_{self.table}"

@dataclass(frozen=True)
class LastRun:
    finished_at: datetime
    records_written: int
    dagster_run_id: str | None

@dataclass(frozen=True)
class Result:
    analysis: str
    sql: str
    columns: list[str]
    rows: list[tuple]
    csv_path: Path | None = None
    row_count: int | None = None

@dataclass(frozen=True)
class Check:
    name: str
    passed: bool
    detail: str

def jsonable(value: Any) -> Any:
    """A value JSON can hold without losing precision: big integers and decimals become strings."""
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return value if abs(value) <= MAX_SAFE_INTEGER else str(value)
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, datetime):
        return utc_iso(value)
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(item) for item in value]
    return str(value)

def cell_text(value: Any) -> str:
    """A warehouse value as CSV text, written exactly: no float conversion, None as empty."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (dict, list)):
        return json.dumps(jsonable(value))
    converted = jsonable(value)
    return converted if isinstance(converted, str) else str(converted)

def headline(results: Sequence[Result]) -> Any:
    """The first analysis's only cell, when it returns exactly one row of one column."""
    first = results[0]
    if len(first.columns) == 1 and (first.row_count if first.row_count is not None else len(first.rows)) == 1:
        return first.rows[0][0]
    return None
