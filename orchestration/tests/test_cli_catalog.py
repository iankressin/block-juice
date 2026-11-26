import json
from copy import deepcopy
from pathlib import Path

import pytest
import yaml

from pipeline import cli
from pipeline.cli import BadInput
from pipeline.cli.catalog import catalog, run


def make_question(root, slug="sample", analyses="[sample]"):
    folder = root / "answers" / slug
    folder.mkdir(parents=True)
    (folder / "question.yaml").write_text(
        f"question: A sample question?\nmarts: [latest_balances]\nanalyses: {analyses}\n"
    )


def write_analysis(root, slug, name, sql="select 1"):
    path = root / "answers" / slug / "analyses" / f"{name}.sql"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(sql)
    return path


def test_lists_question_and_its_authored_queries_without_warehouse(tmp_path, capsys):
    make_question(tmp_path)
    write_analysis(tmp_path, "sample", "nested/sample")
    assert run(tmp_path, None, as_json=True) == 0
    document = json.loads(capsys.readouterr().out)
    assert document[0]["slug"] == "sample"
    assert document[0]["analyses"] == [
        {"name": "sample", "path": "answers/sample/analyses/nested/sample.sql"}
    ]
    assert document[0]["marts"] == ["latest_balances"]


def test_rejects_missing_and_ambiguous_queries(tmp_path):
    make_question(tmp_path)
    with pytest.raises(BadInput, match="no SQL analysis named sample in answers/sample/analyses"):
        catalog(tmp_path)
    write_analysis(tmp_path, "sample", "sample")
    write_analysis(tmp_path, "sample", "other/sample", "select 2")
    with pytest.raises(BadInput, match="duplicate SQL analysis name sample"):
        catalog(tmp_path)


def test_check_catches_an_analysis_its_question_does_not_name(tmp_path, capsys):
    make_question(tmp_path)
    write_analysis(tmp_path, "sample", "sample")
    write_analysis(tmp_path, "sample", "orphan")
    assert run(tmp_path, None, check=True) == 1
    assert "answers/sample/analyses/orphan.sql" in capsys.readouterr().out


def test_check_catches_an_analysis_left_in_the_dbt_project(tmp_path, capsys):
    make_question(tmp_path)
    write_analysis(tmp_path, "sample", "sample")
    old = tmp_path / "transformation" / "analyses" / "old.sql"
    old.parent.mkdir(parents=True)
    old.write_text("select 1")
    assert run(tmp_path, None, check=True) == 1
    assert "transformation/analyses/old.sql" in capsys.readouterr().out


def test_check_catches_analyses_in_a_folder_with_no_question(tmp_path, capsys):
    make_question(tmp_path)
    write_analysis(tmp_path, "sample", "sample")
    write_analysis(tmp_path, "stray", "headline")
    assert run(tmp_path, None, check=True) == 1
    assert "answers/stray/analyses/headline.sql: answers/stray/ has no question.yaml that names it" in capsys.readouterr().out


def test_a_question_whose_analysis_is_still_in_the_dbt_project_names_the_file_to_move(tmp_path):
    make_question(tmp_path, analyses="[old]")
    old = tmp_path / "transformation" / "analyses" / "old.sql"
    old.parent.mkdir(parents=True)
    old.write_text("select 1")
    with pytest.raises(BadInput, match="transformation/analyses/old.sql"):
        catalog(tmp_path)


def test_two_answers_may_use_the_same_analysis_name(tmp_path):
    for slug in ("one", "two"):
        make_question(tmp_path, slug, "[headline]")
        write_analysis(tmp_path, slug, "headline")
    assert run(tmp_path, None, check=True) == 0


def test_unknown_slug_is_bad_input(tmp_path):
    with pytest.raises(BadInput, match="unknown question missing"):
        run(tmp_path, "missing")


def test_cli_questions_is_available_without_environment(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(cli, "REPO_ROOT", tmp_path)
    for name in cli.REQUIRED_ENV:
        monkeypatch.delenv(name, raising=False)
    assert cli.main(["questions", "--json"]) == 0
    assert json.loads(capsys.readouterr().out) == []


def test_every_shipped_analysis_is_named_by_its_question():
    root = Path(__file__).resolve().parents[2]
    folders = sorted(path for path in (root / "answers").glob("*/analyses") if path.is_dir())
    assert folders
    named = {entry["slug"]: sorted(q["name"] for q in entry["analyses"]) for entry in catalog(root)}
    for folder in folders:
        slug = folder.parent.name
        assert slug in named, f"answers/{slug}/ has analyses and no question.yaml"
        assert named[slug] == sorted(p.stem for p in folder.rglob("*.sql"))
    assert list((root / "transformation" / "analyses").glob("**/*.sql")) == []


def test_shipped_contracts_cover_every_query_and_token_default_window():
    from pipeline.cli.question import load_question

    root = Path(__file__).resolve().parents[2]
    for manifest in (root / "answers").glob("*/question.yaml"):
        question = load_question(root, manifest.parent.name)
        assert set(question.expected_columns) == set(question.analyses)
        if not question.slug.startswith("token-"):
            continue
        windows = question.parameters["token"]["windows"]
        assert {window["chain"]: tuple(window["blocks"]) for window in windows} == question.blocks
        filters = {source.source: source.filter for source in question.sources}
        for window in windows:
            assert filters[f"{window['chain']}.erc20_transfers"]["tokens"] == [window["token"]]


def token_question(root):
    repo = Path(__file__).resolve().parents[2]
    slug = "token-flow-map"
    document = yaml.safe_load((repo / "answers" / slug / "question.yaml").read_text())
    folder = root / "answers" / slug
    folder.mkdir(parents=True)
    return document, folder / "question.yaml"


@pytest.mark.parametrize("change", ["blocks", "token", "ethereum"])
def test_changed_token_values_cannot_run_with_old_coverage(tmp_path, monkeypatch, change):
    from pipeline.cli import answer

    document, path = token_question(tmp_path)
    token = deepcopy(document["parameters"]["token"]["default"])
    if change == "blocks":
        token["windows"][0]["blocks"] = [1, 2]
    elif change == "token":
        token["windows"][0]["token"] = "0x0000000000000000000000000000000000000001"
    else:
        token["ethereum"] = "0x0000000000000000000000000000000000000001"
    document["values"] = {"token": token}
    path.write_text(yaml.safe_dump(document, sort_keys=False))
    monkeypatch.setattr(answer, "compile_analyses", lambda *a, **k: pytest.fail("must reject before compile"))
    with pytest.raises(BadInput, match="token"):
        answer.run(tmp_path, "token-flow-map")


def test_aligned_token_override_and_separate_eval_values(tmp_path):
    from pipeline.cli.question import load_question

    document, path = token_question(tmp_path)
    token = deepcopy(document["parameters"]["token"]["default"])
    for window in token["windows"]:
        window["blocks"] = [100, 200]
        document["window"]["blocks"][window["chain"]] = [100, 200]
    token["windows"][0]["token"] = "0x0000000000000000000000000000000000000001"
    for source in document["inputs"]:
        if source["source"] == "arbitrum.erc20_transfers":
            source["filter"]["tokens"] = [token["windows"][0]["token"]]
    document["values"] = {"token": token}
    document["eval_window"] = {"blocks": {w["chain"]: [100, 110] for w in token["windows"]}}
    path.write_text(yaml.safe_dump(document, sort_keys=False))
    assert load_question(tmp_path, "token-flow-map").parameters["token"] == token
    with pytest.raises(BadInput, match="token"):
        load_question(tmp_path, "token-flow-map", "eval_window")
    for name in document["analyses"]:
        write_analysis(tmp_path, "token-flow-map", name)
    with pytest.raises(BadInput, match="eval_window"):
        run(tmp_path, None, check=True)
    evaluation = deepcopy(token)
    for window in evaluation["windows"]:
        window["blocks"] = [100, 110]
    document["eval_values"] = {"token": evaluation}
    path.write_text(yaml.safe_dump(document, sort_keys=False))
    assert load_question(tmp_path, "token-flow-map", "eval_window").parameters["token"] == evaluation
    assert load_question(tmp_path, "token-flow-map").parameters["token"] == token
    assert run(tmp_path, None, check=True) == 0
