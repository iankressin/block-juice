from pathlib import Path

import dagster as dg
from dagster_dbt import build_dbt_asset_selection

from pipeline.assets.dbt import transformation_assets
from pipeline.project import REPO_ROOT

MARTS_DIR = REPO_ROOT / "transformation" / "models" / "marts"
DEFAULT_CRON = "0 6 * * *"
# A pipeline that runs at another time gets an entry here: {"prices": "0 * * * *"}.
CRON_OVERRIDES: dict[str, str] = {}


def pipelines(marts_dir: Path, overrides: dict[str, str]) -> dict[str, str]:
    # A job selects path:models/marts/<name>, which dbt reads recursively, so a model
    # at any depth makes the folder a pipeline.
    names = sorted(
        folder.name for folder in marts_dir.iterdir() if folder.is_dir() and any(folder.rglob("*.sql"))
    )
    for name in overrides:
        if name not in names:
            raise ValueError(f"CRON_OVERRIDES names {name}, which is no folder of marts")
    return {name: overrides.get(name, DEFAULT_CRON) for name in names}


PIPELINES = pipelines(MARTS_DIR, CRON_OVERRIDES)

jobs = [
    dg.define_asset_job(
        name,
        selection=build_dbt_asset_selection(
            [transformation_assets], dbt_select=f"path:models/marts/{name}"
        ).upstream(),
    )
    for name in PIPELINES
]

schedules = [dg.ScheduleDefinition(job=job, cron_schedule=PIPELINES[job.name]) for job in jobs]

# A single graph shares upstream ingestion and dbt models across every mart. Keep the existing
# individual jobs and schedules for installations that only run a subset of the project.
daily = dg.define_asset_job(
    "daily",
    selection=build_dbt_asset_selection(
        [transformation_assets], dbt_select="path:models/marts"
    ).upstream(),
    description="Build all pipelines with each shared source and model selected once.",
)
jobs.append(daily)
schedules.append(dg.ScheduleDefinition(job=daily, cron_schedule=DEFAULT_CRON))
