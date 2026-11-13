"""bj check: add a check the agent ran itself, such as cross_check, to an answer's answer.json.

`bj answer` writes answer.json from scratch, so a new run drops these checks: new results void them.
"""

import json
import re
from pathlib import Path

from pipeline.cli import BadInput
from pipeline.cli.question import answer_dir
from pipeline.analysis.store import answer_lock, RunStore, atomic_json

NAME = re.compile(r"^[a-z][a-z0-9_]*$")
# The checks bj answer runs. A check the agent runs must not replace one of them.
ANSWER_CHECKS = ("dbt_tests", "dead_letters", "freshness", "coverage")


def _run(repo_root: Path, slug: str, name: str, status: str, detail: str, *, evaluation: bool = False) -> int:
    folder = answer_dir(repo_root, slug)
    if evaluation:
        folder = folder / "eval"
    path = folder / "answer.json"
    label = path.relative_to(repo_root)
    command = f"bj answer {slug}" + (" --eval" if evaluation else "")
    if not path.is_file():
        raise BadInput(f"{label} does not exist: run `{command}` first")
    if not NAME.match(name):
        raise BadInput(f"check name {name!r} must match {NAME.pattern}")
    if name in (*ANSWER_CHECKS, "lineage"):
        raise BadInput(f"{name} is a check bj answer runs; give the check you ran its own name, such as cross_check")
    if not detail.strip():
        raise BadInput("say what the check compared, and what it found, in <detail>")
    try:
        answer = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise BadInput(f"{label} is not valid JSON ({error}): run `{command}` again") from None
    checks = answer.get("checks") if isinstance(answer, dict) else None
    if not isinstance(checks, list) or not all(isinstance(c, dict) and isinstance(c.get("name"), str) for c in checks):
        raise BadInput(f"{label} has no checks list as bj answer writes it: run `{command}` again")

    check = {"name": name, "status": status, "detail": detail.strip()}
    names = [c["name"] for c in checks]
    if name in names:
        checks[names.index(name)] = check
    else:
        checks.append(check)
    atomic_json(path, answer)
    RunStore(folder).record_edition(kind="check")
    print(f"{name}: {'passed' if status == 'passed' else 'FAILED'} ({check['detail']})")
    return 0 if status == "passed" else 1


def run(repo_root: Path, slug: str, name: str, status: str, detail: str, *, evaluation: bool = False) -> int:
    folder = answer_dir(repo_root, slug)
    if evaluation:
        folder = folder / "eval"
    # A missing eval answer must not create an eval directory.
    if not (folder / "answer.json").is_file():
        return _run(repo_root, slug, name, status, detail, evaluation=evaluation)
    with answer_lock(folder):
        return _run(repo_root, slug, name, status, detail, evaluation=evaluation)
