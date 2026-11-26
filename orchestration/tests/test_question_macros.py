"""An answer's analyses compile from its own folder, and read their subject from question.yaml."""
import json
from pathlib import Path

from dbt.cli.main import dbtRunner

from pipeline.analysis.specification import input_filters
from pipeline.cli import answer
from pipeline.cli.question import load_question

ROOT = Path(__file__).resolve().parents[2]
PROJECT = ROOT / "transformation"
PROFILE = {"WAREHOUSE_HOST": "localhost", "WAREHOUSE_PORT": "1", "WAREHOUSE_USER": "x",
           "WAREHOUSE_PASSWORD": "x", "WAREHOUSE_DB": "warehouse", "DBT_SCHEMA": "analytics"}
SLUG = "rn1-polymarket-fills-2026-11-08"
WALLET = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea"


def compiled(tmp_path, monkeypatch, variables):
    for name, value in PROFILE.items():
        monkeypatch.setenv(name, value)
    with answer.question_paths(PROJECT, ROOT / "answers" / SLUG):
        result = dbtRunner().invoke([
            "compile", "--select", "by_role", "--vars", json.dumps(variables),
            "--project-dir", str(PROJECT), "--profiles-dir", str(PROJECT), "--target-path", str(tmp_path),
            "--log-path", str(tmp_path), "--no-populate-cache", *answer.DBT_FLAGS])
    assert result.success, result.exception
    return result.result.results[0].node.compiled_code


def test_an_analysis_reads_its_subject_from_question_yaml(tmp_path, monkeypatch):
    question = load_question(ROOT, SLUG)
    sql = compiled(tmp_path, monkeypatch, {"window": {"polygon": [1, 2]}, "inputs": input_filters(question)})
    assert f"f.wallet in ('{WALLET}')" in sql


def test_without_bj_answer_the_analysis_compiles_to_sql_that_fails(tmp_path, monkeypatch):
    sql = compiled(tmp_path, monkeypatch, {"window": {"polygon": [1, 2]}})
    assert "'no values for wallet_fills.wallets: run bj answer'::bigint)" in sql
