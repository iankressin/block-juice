import subprocess

import pytest

from pipeline import cli
from pipeline.cli import BadInput, affected

MANIFEST = {
    "nodes": {
        "analysis.transformation.headline": {
            "resource_type": "analysis", "name": "headline",
            "original_file_path": "../answers/flows/analyses/headline.sql",
            "depends_on": {"nodes": ["model.transformation.flows"],
                           "macros": ["macro.transformation.in_window", "macro.dbt.run_query"]}},
        "model.transformation.flows": {
            "resource_type": "model", "name": "flows", "original_file_path": "models/marts/transfers/flows.sql",
            "depends_on": {"nodes": ["seed.transformation.labels", "source.transformation.ethereum.erc20_transfers"],
                           "macros": ["macro.transformation.token_transfers"]}},
        "seed.transformation.labels": {
            "resource_type": "seed", "name": "labels", "original_file_path": "seeds/labels.csv",
            "depends_on": {"nodes": [], "macros": []}},
    },
    "sources": {"source.transformation.ethereum.erc20_transfers": {
        "source_name": "ethereum", "name": "erc20_transfers",
        "original_file_path": "models/staging/ethereum/_ethereum__sources.yml"}},
    "macros": {
        "macro.transformation.in_window": {"package_name": "transformation", "original_file_path": "macros/window.sql",
                                           "depends_on": {"macros": ["macro.transformation.window_start"]}},
        "macro.transformation.window_start": {"package_name": "transformation", "original_file_path": "macros/bounds.sql",
                                              "depends_on": {"macros": []}},
        "macro.transformation.token_transfers": {"package_name": "transformation", "original_file_path": "macros/token_transfers.sql",
                                                 "depends_on": {"macros": []}},
        "macro.dbt.run_query": {"package_name": "dbt", "original_file_path": "macros/etc/statement.sql",
                                "depends_on": {"macros": []}},
    },
}


def test_upstream_files_are_every_file_an_answer_is_built_from():
    packages = {("ethereum", "erc20_transfers"): "evm-erc20-transfers"}
    assert affected.upstream_files(MANIFEST, ["analysis.transformation.headline"], packages) == {
        "answers/flows/analyses/headline.sql",
        "transformation/models/marts/transfers/flows.sql",
        "transformation/seeds/labels.csv",
        "transformation/models/staging/ethereum/_ethereum__sources.yml",
        "transformation/macros/window.sql",
        "transformation/macros/bounds.sql",
        "transformation/macros/token_transfers.sql",
        "ingestion/sources/evm-erc20-transfers/",
    }


def question(root, slug, extra=""):
    folder = root / "answers" / slug
    folder.mkdir(parents=True)
    (folder / "question.yaml").write_text(f"question: A sample?\n{extra}")


REFERENCE = ("eval_window: {chain: ethereum, blocks: [1, 2]}\n"
             "reference: {analysis: headline, key: [day], value: amount, tolerance: {kind: absolute, value: 0}}\n")


def test_a_changed_file_lists_each_answer_built_from_it(tmp_path, monkeypatch, capsys):
    question(tmp_path, "flows", REFERENCE)
    (tmp_path / "answers" / "flows" / "reference.csv").write_text("day,amount\n")
    question(tmp_path, "prices")
    files = {"flows": {"answers/flows/", "transformation/models/marts/transfers/flows.sql", "ingestion/sources/evm-erc20-transfers/"},
             "prices": {"answers/prices/", "transformation/models/marts/prices/prices.sql"}}
    monkeypatch.setattr(affected, "answer_files", lambda root, q: files[q.slug])
    monkeypatch.setattr(affected, "changed_files", lambda root, ref: [
        "transformation/models/marts/transfers/flows.sql", "ingestion/sources/evm-erc20-transfers/src/source.ts",
        "answers/prices/question.yaml", "docs/architecture.md"])
    assert affected.run(tmp_path, "origin/main") == 0
    assert capsys.readouterr().out == (
        "answers/prices/question.yaml\n"
        "  prices  no reference\n"
        "ingestion/sources/evm-erc20-transfers/src/source.ts\n"
        "  flows   has a reference: run bj answer flows --eval\n"
        "transformation/models/marts/transfers/flows.sql\n"
        "  flows   has a reference: run bj answer flows --eval\n"
    )


def test_no_answer_reads_the_changed_files(tmp_path, monkeypatch, capsys):
    question(tmp_path, "prices")
    monkeypatch.setattr(affected, "answer_files", lambda root, q: {"answers/prices/"})
    monkeypatch.setattr(affected, "changed_files", lambda root, ref: ["docs/architecture.md"])
    assert affected.run(tmp_path, "origin/main") == 0
    assert capsys.readouterr().out == "no answer is built from a changed file\n"


def git(root, *args):
    subprocess.run(["git", "-C", str(root), "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
                   check=True, capture_output=True)


def test_changed_files_fall_back_to_the_ref_and_refuse_an_unknown_one(tmp_path):
    git(tmp_path, "init", "-q", "-b", "main")
    (tmp_path / "a.sql").write_text("select 1")
    git(tmp_path, "add", "a.sql")
    git(tmp_path, "commit", "-q", "-m", "one")
    git(tmp_path, "checkout", "-q", "-b", "work")
    (tmp_path / "a.sql").write_text("select 2")
    assert affected.changed_files(tmp_path, "main") == ["a.sql"]
    # An orphan branch shares no history with main, as a shallow CI checkout shares none with its base.
    git(tmp_path, "checkout", "-q", "--orphan", "alone")
    git(tmp_path, "commit", "-q", "-m", "two")
    assert affected.changed_files(tmp_path, "main") == ["a.sql"]
    with pytest.raises(BadInput, match="git knows no ref nowhere"):
        affected.changed_files(tmp_path, "nowhere")


def test_cli_passes_the_ref(tmp_path, monkeypatch):
    monkeypatch.setattr(cli, "REPO_ROOT", tmp_path)
    seen = []
    monkeypatch.setattr(affected, "run", lambda root, ref: seen.append((root, ref)) or 0)
    assert cli.main(["questions", "--affected", "origin/main"]) == 0
    assert seen == [(tmp_path, "origin/main")]
