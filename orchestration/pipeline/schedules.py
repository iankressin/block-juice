import dagster as dg

elt_job = dg.define_asset_job("elt", selection=dg.AssetSelection.all())

daily_elt = dg.ScheduleDefinition(job=elt_job, cron_schedule="0 6 * * *")
