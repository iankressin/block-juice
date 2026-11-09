"""bj run: materialize one pipeline's Dagster job. Steps that do not depend on each other run side by
side, each in a process of its own, as in scheduled runs."""

import importlib
from collections.abc import Collection
from pathlib import Path

import dagster as dg

from pipeline.cli import BadInput
from pipeline.cli.answer import dbt, dbt_error


def parse_project(project: Path) -> None:
    """Writes target/manifest.json, which pipeline.definitions needs on import. On a fresh clone only
    `dagster dev` would write it otherwise."""
    result = dbt(project, "parse")
    if not result.success:
        raise BadInput(f"dbt parse failed: {dbt_error(result)}")


def load_pipelines() -> tuple[str, Collection[str]]:
    """The module that holds the Dagster definitions, and the pipeline names. pipeline.schedules needs
    the manifest that parse_project writes, so it is imported here, not at the top."""
    from pipeline.schedules import PIPELINES

    return "pipeline.definitions", PIPELINES


def job_def(module: str, name: str) -> dg.JobDefinition:
    """The pipeline's job, from the module's `defs`. Each step's process calls it to rebuild the job."""
    return importlib.import_module(module).defs.resolve_job_def(name)


def first_line(text: str) -> str:
    return text.strip().splitlines()[0] if text.strip() else ""


def root_cause(error):
    """Dagster wraps an asset's own error in its execution error; the asset's error says what went wrong."""
    while error.cause is not None:
        error = error.cause
    return error


def materialize(module: str, pipelines: Collection[str], name: str) -> int:
    if name not in pipelines:
        raise BadInput(f"no pipeline named {name!r}; pipelines: {', '.join(pipelines)}")
    # execute_in_process runs one step at a time. A job that each step's process can rebuild by name
    # runs on the job's own executor, the multiprocess one.
    job = dg.build_reconstructable_job("pipeline.cli.run", "job_def", reconstructable_args=(module, name))
    # Not `with`: entering the result starts the job's resources again and logs that to the finished run.
    result = dg.execute_job(job, instance=dg.DagsterInstance.get(), raise_on_error=False)
    if result.success:
        print(f"{name}: run {result.run_id} succeeded")
        return 0
    print(f"{name}: run {result.run_id} failed")
    failures = [event for event in result.all_events if event.is_step_failure]
    for event in failures:
        print(f"  step {event.step_key} failed: {first_line(root_cause(event.step_failure_data.error).message)}")
    if not failures:
        run_failure = next((event for event in result.all_events if event.is_run_failure), None)
        print(f"  no step failed: {first_line(run_failure.message) if run_failure else 'the run did not finish'}")
    return 1


def run(repo_root: Path, name: str) -> int:
    parse_project(repo_root / "transformation")
    module, pipelines = load_pipelines()
    return materialize(module, pipelines, name)
