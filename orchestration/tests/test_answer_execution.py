"""Answer refreshes preserve the prior generation and never mix full and evaluation outputs."""

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from pipeline.cli import BadInput, answer, main, report
from pipeline.cli.answer import Result


def result(value):
    return Result("total", f"select {value}", ["total"], [(value,)])


def document(value):
    return {
        "value": value,
        "results": [{"analysis": "total", "path": "results/total.csv"}],
        "checks": [],
    }


def saved_answer(folder):
    folder.mkdir(parents=True)
    (folder / "question.yaml").write_text("question: How much?\n")
    answer.write_answer(folder, [result(100)], document(100))
    (folder / "answer.md").write_text("The total is 100.")
    (folder / "reports").mkdir()
    (folder / "reports" / "total.pdf").write_bytes(b"previous report")
    (folder / "reports" / "total.gdoc.json").write_text('{"id": "existing-document"}')


def files(folder):
    return {p.relative_to(folder): p.read_bytes() for p in folder.rglob("*") if p.is_file()}


def test_refresh_archives_the_previous_answer_and_requires_a_new_narrative(tmp_path):
    folder = tmp_path / "total"
    saved_answer(folder)
    answer.write_answer(folder, [result(200)], document(200))

    assert json.loads((folder / "answer.json").read_text())["value"] == 200
    assert (folder / "results" / "total.csv").read_text() == "total\n200\n"
    assert not (folder / "answer.md").exists()
    assert not (folder / "reports" / "total.pdf").exists()
    previous = folder / "previous"
    assert report.load(previous, "total").text == "The total is 100."
    assert report.load(previous, "total").tables[0].rows == [["100"]]
    assert (previous / "reports" / "total.pdf").read_bytes() == b"previous report"
    assert (folder / "question.yaml").read_text() == "question: How much?\n"
    # A later publication updates the same Google Doc, rather than orphaning its identity.
    assert (folder / "reports" / "total.gdoc.json").read_text() == '{"id": "existing-document"}'
    with pytest.raises(BadInput, match="answer.md does not exist"):
        report.load(folder, "total")
    (folder / "answer.md").write_text("The total is 200.")
    assert report.load(folder, "total").text == "The total is 200."


def test_serialization_failure_preserves_every_existing_artifact(tmp_path):
    folder = tmp_path / "total"
    saved_answer(folder)
    before = files(folder)
    with pytest.raises(TypeError):
        answer.write_answer(folder, [result(200)], {**document(200), "invalid": object()})
    assert files(folder) == before


def test_publication_failure_restores_the_previous_generation(tmp_path, monkeypatch):
    folder = tmp_path / "total"
    saved_answer(folder)
    answer.write_answer(folder, [result(150)], document(150))
    (folder / "answer.md").write_text("The total is 150.")
    before = files(folder)
    original = Path.replace
    failed = False

    def fail_new_json(self, target):
        nonlocal failed
        if Path(target) == folder / "answer.json" and not failed:
            failed = True
            raise OSError("disk unavailable")
        return original(self, target)

    monkeypatch.setattr(Path, "replace", fail_new_json)
    with pytest.raises(OSError, match="disk unavailable"):
        answer.write_answer(folder, [result(200)], document(200))
    assert failed
    assert files(folder) == before


def test_compile_reads_only_its_own_invocations_manifest(tmp_path, monkeypatch):
    shared = tmp_path / "target"
    shared.mkdir()
    (shared / "manifest.json").write_text('{"unrelated": true}')
    targets = []

    def compile(project, *args):
        target = Path(args[args.index("--target-path") + 1])
        targets.append(target)
        target.mkdir(parents=True, exist_ok=True)
        manifest = {"nodes": {"analysis.t.total": {"name": "total", "resource_type": "analysis",
                    "compiled_code": f"select {len(targets)}"}}, "sources": {}}
        (target / "manifest.json").write_text(json.dumps(manifest))
        return SimpleNamespace(success=True)

    monkeypatch.setattr(answer, "dbt", compile)
    first, _ = answer.compile_analyses(tmp_path, ["total"], {})
    second, _ = answer.compile_analyses(tmp_path, ["total"], {})
    assert first["nodes"]["analysis.t.total"]["compiled_code"] == "select 1"
    assert second["nodes"]["analysis.t.total"]["compiled_code"] == "select 2"
    assert targets[0] != targets[1]
    assert all(not target.exists() for target in targets)
    assert (shared / "manifest.json").read_text() == '{"unrelated": true}'


def test_provenance_includes_tracked_question_changes_but_ignores_generated_answers(tmp_path):
    def git(*args):
        return subprocess.run(["git", "-C", str(tmp_path), *args], check=True, capture_output=True)

    git("init")
    folder = tmp_path / "answers" / "total"
    folder.mkdir(parents=True)
    question = folder / "question.yaml"
    question.write_text("question: How much?\n")
    git("add", ".")
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture")
    (folder / "answer.md").write_text("A generated narrative.")
    assert answer.provenance(tmp_path)["git_dirty"] is False
    question.write_text("question: How much changed?\n")
    assert answer.provenance(tmp_path)["git_dirty"] is True


def test_check_eval_records_the_factory_verdict_without_changing_the_full_answer(tmp_path, monkeypatch):
    folder = tmp_path / "answers" / "total"
    saved_answer(folder)
    (folder / "eval").mkdir()
    answer.write_answer(folder / "eval", [result(20)], {**document(20), "eval": True})
    monkeypatch.setattr("pipeline.cli.REPO_ROOT", tmp_path)
    before = (folder / "answer.json").read_bytes()
    assert main(["check", "total", "--eval", "reference_match", "passed", "matches oracle"]) == 0
    assert (folder / "answer.json").read_bytes() == before
    assert json.loads((folder / "eval" / "answer.json").read_text())["checks"] == [
        {"name": "reference_match", "status": "passed", "detail": "matches oracle"}
    ]


def test_missing_eval_check_never_falls_back_to_the_full_answer(tmp_path, monkeypatch, capsys):
    folder = tmp_path / "answers" / "total"
    saved_answer(folder)
    monkeypatch.setattr("pipeline.cli.REPO_ROOT", tmp_path)
    before = files(folder)
    assert main(["check", "total", "--eval", "reference_match", "passed", "matches oracle"]) == 2
    assert "eval/answer.json does not exist: run `bj answer total --eval` first" in capsys.readouterr().err
    assert files(folder) == before
