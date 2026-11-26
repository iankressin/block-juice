from pathlib import Path

import dagster as dg
import pytest

from pipeline.cli.run import load_pipelines
from pipeline.definitions import defs
from pipeline.schedules import DEFAULT_CRON, PIPELINES, pipelines


def test_daily_runs_each_shared_asset_and_check_once():
    graph = defs.resolve_asset_graph()
    legacy = [job for job in defs.jobs if job.name in PIPELINES]
    daily = next(job for job in defs.jobs if job.name == "daily")
    expected = {key for job in legacy for key in job.selection.resolve(graph)}
    assert daily.selection.resolve(graph) == expected
    assert daily.selection.resolve_checks(graph) == {
        key for job in legacy for key in job.selection.resolve_checks(graph)
    }
    assert len(expected) < sum(len(job.selection.resolve(graph)) for job in legacy)
    # Dagster creates one step for a shared source within the combined graph.
    job = defs.resolve_job_def("daily")
    names = [node.name for node in job.nodes]
    assert len(names) == len(set(names))


def test_registered_pipelines_have_jobs_schedules_and_cli_names():
    legacy = {
        "balances", "transfers", "dex", "labels", "bridges", "prices", "tokens",
        "polymarket", "accounts", "deployments", "cow",
    }
    assert legacy <= PIPELINES.keys()
    expected = {**PIPELINES, "daily": "0 6 * * *"}
    assert {job.name for job in defs.jobs} == expected.keys()
    schedules = {schedule.job_name: schedule for schedule in defs.schedules}
    for name, cron in expected.items():
        assert schedules[name].cron_schedule == cron
        assert schedules[name].default_status == dg.DefaultScheduleStatus.STOPPED
    assert set(load_pipelines()[1]) == expected.keys()


def test_each_marts_folder_with_a_model_is_a_pipeline(tmp_path):
    (tmp_path / "balances").mkdir()
    (tmp_path / "balances" / "balances.sql").write_text("select 1")
    (tmp_path / "dex" / "v2").mkdir(parents=True)
    (tmp_path / "dex" / "v2" / "dex.sql").write_text("select 1")
    (tmp_path / "empty").mkdir()
    (tmp_path / ".DS_Store").write_text("")
    assert pipelines(tmp_path, {"dex": "0 * * * *"}) == {"balances": DEFAULT_CRON, "dex": "0 * * * *"}


def test_an_override_for_no_pipeline_is_an_error(tmp_path):
    with pytest.raises(ValueError, match="CRON_OVERRIDES names bridges"):
        pipelines(tmp_path, {"bridges": "0 * * * *"})


def test_the_shipped_pipelines_are_the_marts_folders():
    marts = Path(__file__).resolve().parents[2] / "transformation" / "models" / "marts"
    assert PIPELINES.keys() == {folder.name for folder in marts.iterdir() if folder.is_dir()}
