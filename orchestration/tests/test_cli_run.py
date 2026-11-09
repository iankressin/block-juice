import dagster as dg
import pytest

from pipeline.cli import main
from pipeline.cli import run as run_command


@pytest.fixture
def barrier(monkeypatch, tmp_path):
    path = tmp_path / "barrier"
    path.mkdir()
    monkeypatch.setenv("STUB_BARRIER_DIR", str(path))
    return path


@pytest.fixture
def stubbed(monkeypatch, barrier):
    parsed = []
    monkeypatch.setattr(run_command, "parse_project", parsed.append)
    # Each step's process imports stub_pipelines by name. It finds it because pytest puts this
    # directory on sys.path, and Dagster starts step processes with spawn, which copies sys.path.
    monkeypatch.setattr(run_command, "load_pipelines", lambda: ("stub_pipelines", ["balances", "loads", "side_by_side", "one_fails"]))
    return parsed


def test_unknown_pipeline_exits_2_listing_the_pipelines(stubbed, capsys):
    assert main(["run", "prices"]) == 2
    err = capsys.readouterr().err
    assert "no pipeline named 'prices'; pipelines: balances, loads, side_by_side, one_fails" in err
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


def test_runs_a_pipelines_steps_side_by_side(stubbed, capsys):
    assert main(["run", "side_by_side"]) == 0
    assert "side_by_side: run " in capsys.readouterr().out


def test_a_failed_step_lets_the_others_finish_and_skips_what_needs_it(stubbed, barrier, capsys):
    assert main(["run", "one_fails"]) == 1
    assert "step fails failed: RuntimeError: source broke" in capsys.readouterr().out
    assert (barrier / "sibling").exists()
    assert not (barrier / "after_both").exists()


def test_nothing_is_logged_to_a_run_after_it_ends(stubbed, capsys):
    assert main(["run", "loads"]) == 0
    run_id = capsys.readouterr().out.split("loads: run ")[1].split()[0]
    events = dg.DagsterInstance.get().all_logs(run_id)
    types = [event.dagster_event.event_type for event in events if event.dagster_event]
    assert types[types.index(dg.DagsterEventType.RUN_SUCCESS) + 1 :] == []
