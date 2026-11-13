"""Discover authored question bundles without connecting to a warehouse or compiling dbt."""

import json
from pathlib import Path

from pipeline.cli import BadInput
from pipeline.cli.question import load_question


def analysis_paths(repo_root: Path) -> dict[str, str]:
    paths = {}
    for path in sorted((repo_root / "transformation" / "analyses").rglob("*.sql")):
        if path.stem in paths:
            raise BadInput(f"duplicate SQL analysis name {path.stem}: {paths[path.stem]} and {path}")
        paths[path.stem] = path.relative_to(repo_root).as_posix()
    return paths


def catalog(repo_root: Path) -> list[dict]:
    paths = analysis_paths(repo_root)
    entries = []
    for manifest in sorted((repo_root / "answers").glob("*/question.yaml")):
        question = load_question(repo_root, manifest.parent.name)
        for name in question.analyses:
            if name not in paths:
                raise BadInput(f"{manifest.relative_to(repo_root)}: no SQL analysis named {name}")
        entries.append({
            "slug": question.slug,
            "question": question.question,
            "manifest": manifest.relative_to(repo_root).as_posix(),
            "marts": list(question.marts),
            "analyses": [{"name": name, "path": paths[name]} for name in question.analyses],
        })
    return entries


def run(repo_root: Path, slug: str | None, *, as_json: bool = False, check: bool = False) -> int:
    if check and slug is not None:
        raise BadInput("bj questions --check validates the whole catalog; omit the slug")
    entries = catalog(repo_root)
    if slug is not None:
        entries = [entry for entry in entries if entry["slug"] == slug]
        if not entries:
            raise BadInput(f"unknown question {slug}; run bj questions to list available questions")
    if check:
        ownership: dict[str, list[str]] = {}
        for entry in entries:
            for query in entry["analyses"]:
                ownership.setdefault(query["name"], []).append(entry["slug"])
        missing = sorted(set(analysis_paths(repo_root)) - ownership.keys())
        duplicated = {name: owners for name, owners in ownership.items() if len(owners) > 1}
        if missing:
            print("Analyses without a question: " + ", ".join(missing))
        for name, owners in duplicated.items():
            print(f"Analysis {name} belongs to multiple questions: {', '.join(owners)}")
        if missing or duplicated:
            return 1
        print(f"Validated {len(entries)} questions covering {len(ownership)} SQL analyses.")
        return 0
    if as_json:
        print(json.dumps(entries, indent=2))
    else:
        for entry in entries:
            print(f"{entry['slug']}: {entry['question']}")
            print(f"  {entry['manifest']}")
            print(f"  marts: {', '.join(entry['marts']) or '(none declared)'}")
            for query in entry["analyses"]:
                print(f"  {query['path']}")
    return 0
