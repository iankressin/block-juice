import dagster as dg

from pipeline.cli.run import load_pipelines
from pipeline.definitions import defs
from pipeline.schedules import PIPELINES


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


def test_legacy_jobs_and_schedule_times_are_preserved():
    expected = {"balances", "transfers", "dex", "labels", "bridges", "prices", "tokens",
                "polymarket", "accounts", "deployments", "cow"}
    assert set(PIPELINES) == expected
    schedules = {schedule.job_name: schedule for schedule in defs.schedules}
    for name in expected | {"daily"}:
        assert schedules[name].cron_schedule == "0 6 * * *"
        assert schedules[name].default_status == dg.DefaultScheduleStatus.STOPPED
    assert set(load_pipelines()[1]) == expected | {"daily"}
