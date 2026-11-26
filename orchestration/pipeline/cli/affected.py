"""List the answers that a changed file can move: `bj questions --affected <ref>`. No warehouse needed."""

import json
import posixpath
import subprocess
from collections.abc import Sequence
from pathlib import Path
from tempfile import TemporaryDirectory

from pipeline.cli import BadInput
from pipeline.cli.answer import dbt, dbt_error, question_paths
from pipeline.cli.question import load_question
from pipeline.sources import SOURCES_FILE, read_sources

GIT_TIMEOUT_SECONDS = 60


def upstream_files(manifest: dict, analysis_ids: Sequence[str], packages: dict[tuple[str, str], str]) -> set[str]:
    """Every file the analyses are built from, as POSIX paths from the repo root.

    An entry that ends in `/` is a folder: a source's ingestion package. `packages` maps a source's
    (name, table) to that package's folder name."""
    project = analysis_ids[0].split(".")[1] if analysis_ids else ""
    nodes, sources, macros = manifest.get("nodes", {}), manifest.get("sources", {}), manifest.get("macros", {})
    files: set[str] = set()

    def add(node: dict) -> None:
        files.add(posixpath.normpath(posixpath.join("transformation", node["original_file_path"])))

    seen, stack = set(), list(analysis_ids)
    while stack:
        uid = stack.pop()
        if uid in seen:
            continue
        seen.add(uid)
        if uid in sources:
            source = sources[uid]
            add(source)
            package = packages.get((source["source_name"], source["name"]))
            if package:
                files.add(f"ingestion/sources/{package}/")
            continue
        node = nodes.get(uid, {})
        if node:
            add(node)
        stack.extend(node.get("depends_on", {}).get("nodes", []))
        stack.extend(node.get("depends_on", {}).get("macros", []))
        if uid in macros:
            stack.extend(macros[uid].get("depends_on", {}).get("macros", []))
    for uid in seen & macros.keys():
        if macros[uid].get("package_name") == project:
            add(macros[uid])
    return files


def answer_files(repo_root: Path, question) -> set[str]:
    """The files one answer is built from: its folder, dbt_project.yml, and what dbt parse finds upstream of its analyses."""
    project = repo_root / "transformation"
    folder = repo_root / "answers" / question.slug
    with TemporaryDirectory(prefix="bj-affected-") as target, question_paths(project, folder):
        result = dbt(project, "parse", "--target-path", target, "--log-path", str(Path(target) / "logs"))
        if not result.success:
            raise BadInput(f"dbt parse failed for answers/{question.slug}: {dbt_error(result)}")
        manifest = json.loads((Path(target) / "manifest.json").read_text())
    ids = [uid for uid, node in manifest["nodes"].items()
           if node["resource_type"] == "analysis" and node["name"] in question.analyses]
    entries = read_sources((repo_root / SOURCES_FILE).read_text())
    packages = {(entry.name, entry.table): entry.package for entry in entries}
    return upstream_files(manifest, ids, packages) | {f"answers/{question.slug}/", "transformation/dbt_project.yml"}


def git(repo_root: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(repo_root), *args], capture_output=True, text=True,
                          timeout=GIT_TIMEOUT_SECONDS)


def changed_files(repo_root: Path, ref: str) -> list[str]:
    """The files that differ from where this branch left `ref`, or from `ref` itself when git finds no
    merge base, as in a shallow CI checkout."""
    if git(repo_root, "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}").returncode != 0:
        raise BadInput(f"git knows no ref {ref}")
    base = git(repo_root, "merge-base", ref, "HEAD")
    start = base.stdout.strip() if base.returncode == 0 else ref
    diff = git(repo_root, "diff", "--name-only", start)
    if diff.returncode != 0:
        raise BadInput(f"git diff {start} failed: {' '.join(diff.stderr.split())}")
    return diff.stdout.splitlines()


def built_from(entry: str, path: str) -> bool:
    return path.startswith(entry) if entry.endswith("/") else path == entry


def run(repo_root: Path, ref: str) -> int:
    changed = changed_files(repo_root, ref)
    questions = [load_question(repo_root, path.parent.name)
                 for path in sorted((repo_root / "answers").glob("*/question.yaml"))]
    files = {question.slug: answer_files(repo_root, question) for question in questions}
    hits = {}
    for path in sorted(changed):
        slugs = [q for q in questions if any(built_from(entry, path) for entry in files[q.slug])]
        if slugs:
            hits[path] = slugs
    if not hits:
        print("no answer is built from a changed file")
        return 0
    width = max(len(q.slug) for slugs in hits.values() for q in slugs) + 2
    for path, slugs in hits.items():
        print(path)
        for q in slugs:
            note = f"has a reference: run bj answer {q.slug} --eval" if q.reference else "no reference"
            print(f"  {q.slug:<{width}}{note}")
    return 0
