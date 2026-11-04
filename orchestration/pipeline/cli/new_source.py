"""bj new-source: add a source by copying a source package, with its dbt source and Dagster asset."""

import ast
import json
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

import yaml

from pipeline.cli import BadInput

NAME = re.compile(r"^[a-z][a-z0-9_]*$")
SOURCES_FILE = Path("orchestration/pipeline/assets/ingestion.py")


@dataclass(frozen=True)
class Plan:
    """Everything the command writes, worked out before it writes any of it."""

    template: Path
    package: Path
    files: dict[Path, str]


def package_name(source: str, table: str) -> str:
    # The rule of package_dir in assets/ingestion.py, which this module cannot import without loading Dagster.
    return f"{source}-{table.replace('_', '-')}"


def read_sources(text: str) -> tuple[list[tuple[str, str]], int]:
    """SOURCES from assets/ingestion.py, and the line of its closing bracket."""
    for node in ast.parse(text).body:
        if isinstance(node, ast.Assign) and [getattr(t, "id", None) for t in node.targets] == ["SOURCES"]:
            return [tuple(pair) for pair in ast.literal_eval(node.value)], node.end_lineno
    raise BadInput(f"{SOURCES_FILE} has no SOURCES list")


def add_to_sources(text: str, source: str, table: str) -> str:
    sources, closing_line = read_sources(text)
    lines = text.splitlines(keepends=True)
    indent = re.match(r"\s*", lines[closing_line - 2]).group() if sources else "    "
    lines.insert(closing_line - 1, f'{indent}("{source}", "{table}"),\n')
    updated = "".join(lines)
    if read_sources(updated)[0] != [*sources, (source, table)]:
        raise BadInput(f"could not add ({source!r}, {table!r}) to SOURCES in {SOURCES_FILE}; add it by hand")
    return updated


def source_tables(text: str, source: str, path: Path) -> list[str]:
    """The tables of `source` in a dbt sources yml."""
    try:
        document = yaml.safe_load(text)
        matches = [s for s in document["sources"] if s["name"] == source]
        return [t["name"] for m in matches for t in m.get("tables") or []]
    except (yaml.YAMLError, KeyError, TypeError) as error:
        raise BadInput(f"{path} is not a dbt sources file this command can read: {error}") from None


def table_yaml(source: str, table: str) -> str:
    return (
        f"      - name: {table}\n"
        f"        identifier: {source}_{table}\n"
        "        columns:\n"
        "          - name: id\n"
        "            data_tests: [unique, not_null]\n"
    )


def sources_yaml(source: str, table: str) -> str:
    return (
        "version: 2\n"
        "\n"
        "# Source name + table name must match the ingestion Source's `name` + `table`.\n"
        "sources:\n"
        f"  - name: {source}\n"
        "    schema: \"{{ env_var('RAW_SCHEMA', 'raw') }}\"\n"
        "    tables:\n" + table_yaml(source, table)
    )


def staging_model(source: str, table: str) -> str:
    return f"select\n    id,\n    data,\n    _loaded_at\nfrom {{{{ source('{source}', '{table}') }}}}\n"


def replace_once(text: str, old: str, new: str, path: Path) -> str:
    if text.count(old) != 1:
        raise BadInput(f"{path} must contain {old} exactly once to rename it, found {text.count(old)}")
    return text.replace(old, new)


def plan(repo_root: Path, source: str, table: str, like: str) -> Plan:
    for value, label in ((source, "<source>"), (table, "<table>")):
        if not NAME.match(value):
            raise BadInput(f"{label} {value!r} must match {NAME.pattern}")
    sources_root = repo_root / "ingestion" / "sources"
    template = sources_root / like
    if "/" in like or like.startswith(".") or not template.is_dir():
        raise BadInput(f"no source package {like!r} in ingestion/sources/")

    ingestion_py = repo_root / SOURCES_FILE
    ingestion_text = ingestion_py.read_text()
    sources, _ = read_sources(ingestion_text)
    old = [pair for pair in sources if package_name(*pair) == like]
    if not old:
        raise BadInput(f"{like} is in no SOURCES entry of {SOURCES_FILE}, so it is not a source to copy")
    old_source, old_table = old[0]
    if (source, table) in sources:
        raise BadInput(f"({source!r}, {table!r}) is already in SOURCES")
    package = sources_root / package_name(source, table)
    if package.exists():
        raise BadInput(f"{package.relative_to(repo_root)} already exists")

    source_ts = template / "src" / "source.ts"
    for needed in (source_ts, template / "package.json"):
        if not needed.is_file():
            raise BadInput(f"{needed.relative_to(repo_root)} is missing, so {like} cannot be copied")
    renamed = replace_once(source_ts.read_text(), f'name: "{old_source}"', f'name: "{source}"', source_ts)
    renamed = replace_once(renamed, f'table: "{old_table}"', f'table: "{table}"', source_ts)
    package_json = json.loads((template / "package.json").read_text())
    package_json["name"] = f"@ingestion/{package.name}"

    staging = repo_root / "transformation" / "models" / "staging" / source
    model = staging / f"stg_{source}__{table}.sql"
    if model.exists():
        raise BadInput(f"{model.relative_to(repo_root)} already exists")
    sources_yml = staging / f"_{source}__sources.yml"
    if sources_yml.exists():
        current = sources_yml.read_text()
        if table in source_tables(current, source, sources_yml):
            raise BadInput(f"{sources_yml.relative_to(repo_root)} already has table {table!r}")
        yml = current + ("" if current.endswith("\n") else "\n") + table_yaml(source, table)
    else:
        yml = sources_yaml(source, table)
    if table not in source_tables(yml, source, sources_yml):
        raise BadInput(f"could not add {table!r} under {source!r} in {sources_yml.relative_to(repo_root)}")

    return Plan(
        template=template,
        package=package,
        files={
            package / "package.json": json.dumps(package_json, indent=2) + "\n",
            package / "src" / "source.ts": renamed,
            sources_yml: yml,
            model: staging_model(source, table),
            ingestion_py: add_to_sources(ingestion_text, source, table),
        },
    )


def run(repo_root: Path, source: str, table: str, like: str) -> int:
    planned = plan(repo_root, source, table, like)
    existed = {path for path in planned.files if path.exists()}
    shutil.copytree(planned.template, planned.package, ignore=shutil.ignore_patterns("node_modules", ".env"))
    for path, text in planned.files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    package = planned.package.relative_to(repo_root)
    model = f"transformation/models/staging/{source}/stg_{source}__{table}.sql"
    print(f"created {package}/ (a copy of {like})")
    for path in planned.files:
        print(f"{'changed' if path in existed else 'created'} {path.relative_to(repo_root)}")
    print(
        "\nNext steps:\n"
        "1. Run `pnpm install` in ingestion/.\n"
        f"2. Edit the copied code in {package}/src/ and {package}/addresses.json to read the new data.\n"
        f"3. Shape {model}: turn `data` into the columns you need.\n"
        "4. Read the new source from a mart in transformation/models/marts/<pipeline>/. Until one does,"
        " the orchestration tests fail, because the new asset belongs to no scheduled pipeline."
    )
    return 0
