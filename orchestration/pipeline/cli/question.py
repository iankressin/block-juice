"""answers/<slug>/question.yaml, parsed in one place for bj answer and bj report."""

import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

import yaml

from pipeline.cli import BadInput

SLUG = re.compile(r"^[a-z0-9][a-z0-9-]*$")
# A dbt node name, and nothing a dbt selector would read as a method, graph operator or path.
ANALYSIS = re.compile(r"^[A-Za-z0-9_]+$")


@dataclass(frozen=True)
class Question:
    slug: str
    question: str
    asked: str | None
    definitions: dict[str, str]
    alternatives: tuple[str, ...]
    window: dict[str, Any]
    inputs: tuple[dict[str, Any], ...]
    marts: tuple[str, ...]
    analyses: tuple[str, ...]


def _strings(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def _string_map(value: Any) -> bool:
    return isinstance(value, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in value.items())


def _analyses(value: Any) -> bool:
    return _strings(value) and len(value) > 0 and all(ANALYSIS.match(name) for name in value)


# Every key question.yaml may have, the check its value must pass, and the type the error names.
FIELDS: dict[str, tuple[Callable[[Any], bool], str]] = {
    "question": (lambda v: isinstance(v, str) and v.strip() != "", "a non-empty string"),
    "asked": (lambda v: isinstance(v, (date, str)), "a date or a string"),
    "definitions": (_string_map, "a map of strings to strings"),
    "alternatives": (_strings, "a list of strings"),
    "window": (lambda v: isinstance(v, dict), "a map"),
    "inputs": (lambda v: isinstance(v, list) and all(isinstance(item, dict) for item in v), "a list of maps"),
    "marts": (_strings, "a list of strings"),
    "analyses": (_analyses, f"a non-empty list of dbt analysis names matching {ANALYSIS.pattern}"),
}


def answer_dir(repo_root: Path, slug: str) -> Path:
    if not SLUG.match(slug):
        raise BadInput(f"slug {slug!r} must match {SLUG.pattern}")
    folder = repo_root / "answers" / slug
    if not folder.is_dir():
        raise BadInput(f"answers/{slug}/ does not exist")
    return folder


def load_question(repo_root: Path, slug: str) -> Question:
    path = answer_dir(repo_root, slug) / "question.yaml"
    label = f"answers/{slug}/question.yaml"
    if not path.is_file():
        raise BadInput(f"{label} does not exist")
    try:
        raw = yaml.safe_load(path.read_text())
    except yaml.YAMLError as error:
        raise BadInput(f"{label} is not valid YAML: {' '.join(str(error).split())}") from None
    if not isinstance(raw, dict):
        raise BadInput(f"{label} must be a map with a 'question' key")
    for key, value in raw.items():
        if key not in FIELDS:
            raise BadInput(f"{label}: unknown key {key!r}; allowed keys: {', '.join(FIELDS)}")
        check, kind = FIELDS[key]
        if not check(value):
            raise BadInput(f"{label}: {key!r} must be {kind}")
    if "question" not in raw:
        raise BadInput(f"{label}: 'question' is required")
    asked = raw.get("asked")
    return Question(
        slug=slug,
        question=raw["question"],
        asked=asked.isoformat() if isinstance(asked, date) else asked,
        definitions=raw.get("definitions", {}),
        alternatives=tuple(raw.get("alternatives", [])),
        window=raw.get("window", {}),
        inputs=tuple(raw.get("inputs", [])),
        marts=tuple(raw.get("marts", [])),
        analyses=tuple(raw.get("analyses", [slug.replace("-", "_")])),
    )
