"""Typed, optional contracts for authored analyses; legacy questions need no migration."""
from dataclasses import dataclass
from datetime import date
import math
import re
from typing import Any

from pipeline.cli import BadInput

NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
RESERVED = {"window", "coverage"}


@dataclass(frozen=True)
class ExecutionPolicy:
    statement_timeout_ms: int = 900_000
    lock_timeout_ms: int = 10_000
    fetch_size: int = 1_000
    # Zero permits a complete disk-spooled export without keeping it in memory.
    max_rows: int = 0


def execution_policy(raw: dict) -> ExecutionPolicy:
    allowed = set(ExecutionPolicy.__dataclass_fields__)
    if set(raw) - allowed:
        raise BadInput(f"execution: unknown settings {', '.join(sorted(set(raw) - allowed))}")
    for key, value in raw.items():
        if not isinstance(value, int) or isinstance(value, bool) or value < (1 if key == "fetch_size" else 0):
            raise BadInput(f"execution.{key} must be a {'positive' if key == 'fetch_size' else 'non-negative'} integer")
    if raw.get("fetch_size", 1000) > 100_000:
        raise BadInput("execution.fetch_size must be at most 100000")
    return ExecutionPolicy(**raw)


def typed_value(value: Any, schema: dict, label: str) -> Any:
    kind = schema.get("type")
    valid = False
    if kind == "string":
        valid = isinstance(value, str)
    elif kind == "integer":
        valid = isinstance(value, int) and not isinstance(value, bool)
    elif kind == "number":
        valid = isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    elif kind == "boolean":
        valid = isinstance(value, bool)
    elif kind == "date":
        try:
            value = date.fromisoformat(str(value)).isoformat()
            valid = True
        except ValueError:
            pass
    elif kind == "array":
        item = schema.get("items", {"type": "string"})
        item = {"type": item} if isinstance(item, str) else item
        if not isinstance(item, dict):
            raise BadInput(f"{label}.items must be a type or schema")
        if isinstance(value, list):
            return [typed_value(v, item, f"{label}[{i}]") for i, v in enumerate(value)]
    elif kind == "object":
        properties = schema.get("properties", {})
        if not isinstance(properties, dict) or not all(isinstance(s, dict) for s in properties.values()):
            raise BadInput(f"{label}.properties must map names to schemas")
        if isinstance(value, dict):
            if set(value) - set(properties):
                raise BadInput(f"{label}: unknown properties {', '.join(sorted(set(value) - set(properties)))}")
            result = {}
            for key, prop in properties.items():
                if key in value or "default" in prop:
                    result[key] = typed_value(value.get(key, prop.get("default")), prop, f"{label}.{key}")
                elif prop.get("required", False):
                    raise BadInput(f"{label}.{key} is required")
            return result
    else:
        raise BadInput(f"{label}: unknown parameter type {kind!r}")
    if not valid:
        raise BadInput(f"{label} must be {kind}")
    if "enum" in schema and value not in schema["enum"]:
        raise BadInput(f"{label} must be one of {schema['enum']}")
    return value


def parameters(schemas: dict, values: dict) -> dict:
    if set(values) - set(schemas):
        raise BadInput(f"values: undeclared parameters {', '.join(sorted(set(values) - set(schemas)))}")
    result = {}
    for name, schema in schemas.items():
        if not isinstance(name, str) or not NAME.fullmatch(name) or name in RESERVED:
            raise BadInput(f"invalid or reserved parameter name {name!r}")
        if not isinstance(schema, dict):
            raise BadInput(f"parameters.{name} must be a schema")
        if name in values or "default" in schema:
            result[name] = typed_value(values.get(name, schema.get("default")), schema, f"parameters.{name}")
        elif schema.get("required", True):
            raise BadInput(f"parameters.{name} needs a value or default")
    return result


def validate_contracts(raw: dict) -> tuple[dict, ExecutionPolicy]:
    resolved = parameters(raw.get("parameters", {}), raw.get("values", {}))
    for name, columns in raw.get("expected_columns", {}).items():
        if not isinstance(name, str) or not isinstance(columns, list) or not all(isinstance(c, str) or (isinstance(c, dict) and isinstance(c.get("name"), str) and isinstance(c.get("type"), str) and set(c) == {"name", "type"}) for c in columns):
            raise BadInput("expected_columns must map each analysis to an ordered list of column names")
    for name, keys in raw.get("grain", {}).items():
        if not isinstance(name, str) or not isinstance(keys, list) or not keys or not all(isinstance(k, str) for k in keys):
            raise BadInput("grain must map each analysis to a non-empty list of unique-key columns")
    freshness = raw.get("freshness", {})
    if set(freshness) - {"max_age_hours", "require_model_build"}:
        raise BadInput("freshness allows max_age_hours and require_model_build")
    age = freshness.get("max_age_hours")
    if age is not None and (isinstance(age, bool) or not isinstance(age, (int, float)) or not math.isfinite(age) or age <= 0):
        raise BadInput("freshness.max_age_hours must be a positive number")
    if "require_model_build" in freshness and not isinstance(freshness["require_model_build"], bool):
        raise BadInput("freshness.require_model_build must be boolean")
    return resolved, execution_policy(raw.get("execution", {}))
