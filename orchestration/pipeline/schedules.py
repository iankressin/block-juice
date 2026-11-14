import dagster as dg
from dagster_dbt import build_dbt_asset_selection

from pipeline.assets.dbt import transformation_assets

PIPELINES = {
    "balances": "0 6 * * *",
    "transfers": "0 6 * * *",
    "dex": "0 6 * * *",
    "labels": "0 6 * * *",
    "bridges": "0 6 * * *",
    "prices": "0 6 * * *",
    "tokens": "0 6 * * *",
    "polymarket": "0 6 * * *",
    "accounts": "0 6 * * *",
    "deployments": "0 6 * * *",
    "cow": "0 6 * * *",
}

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
schedules.append(dg.ScheduleDefinition(job=daily, cron_schedule="0 6 * * *"))
