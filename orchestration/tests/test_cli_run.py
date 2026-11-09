import dagster as dg
import pytest

from pipeline.cli import main
from pipeline.cli import run as run_command


@dg.asset
def loaded():
    return 1


@dg.asset(deps=[loaded])
def transformed():
    raise RuntimeError("relation raw.ethereum_eth_balances does not exist")


STUB = dg.Definitions(
    assets=[loaded, transformed],
    jobs=[dg.define_asset_job("balances", selection="*"), dg.define_asset_job("loads", selection=[loaded])],
)


@pytest.fixture
def stubbed(monkeypatch):
    parsed = []
    monkeypatch.setattr(run_command, "parse_project", parsed.append)
    monkeypatch.setattr(run_command, "load_definitions", lambda: (STUB, ["balances", "loads"]))
    return parsed


def test_unknown_pipeline_exits_2_listing_the_pipelines(stubbed, capsys):
    assert main(["run", "prices"]) == 2
    err = capsys.readouterr().err
    assert "no pipeline named 'prices'; pipelines: balances, loads" in err
    assert err.count("\n") == 1


def test_parses_the_dbt_project_then_runs_the_job(stubbed, capsys):
    assert main(["run", "loads"]) == 0
    assert [path.name for path in stubbed] == ["transformation"]
    assert "loads: run " in capsys.readouterr().out


def test_runs_land_in_the_checkouts_dagster_home(stubbed, monkeypatch, tmp_path):
    monkeypatch.delenv("DAGSTER_HOME")
    monkeypatch.setattr("pipeline.cli.REPO_ROOT", tmp_path)

    assert main(["run", "loads"]) == 0

    runs = dg.DagsterInstance.from_config(str(tmp_path / "orchestration" / ".dagster_home")).get_runs()
    assert [run.job_name for run in runs] == ["loads"]


def test_a_dagster_home_already_set_wins(stubbed, monkeypatch, tmp_path):
    monkeypatch.setenv("DAGSTER_HOME", str(tmp_path / "home"))
    (tmp_path / "home").mkdir()
    monkeypatch.setattr("pipeline.cli.REPO_ROOT", tmp_path / "repo")

    assert main(["run", "loads"]) == 0

    runs = dg.DagsterInstance.from_config(str(tmp_path / "home")).get_runs()
    assert [run.job_name for run in runs] == ["loads"]
    assert not (tmp_path / "repo").exists()


def test_failed_run_exits_1_naming_the_failed_step(stubbed, capsys):
    assert main(["run", "balances"]) == 1
    out = capsys.readouterr().out
    assert "step transformed failed: RuntimeError: relation raw.ethereum_eth_balances does not exist" in out
    assert "step loaded" not in out
