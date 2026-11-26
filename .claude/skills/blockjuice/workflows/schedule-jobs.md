# Change when a pipeline runs

Dagster is the only scheduler. `orchestration/pipeline/schedules.py` reads `PIPELINES` from the folders of `transformation/models/marts/`, and builds one job and one schedule per entry. Each runs at `DEFAULT_CRON` unless `CRON_OVERRIDES` names it:

```python
DEFAULT_CRON = "0 6 * * *"
# A pipeline that runs at another time gets an entry here: {"prices": "0 * * * *"}.
CRON_OVERRIDES: dict[str, str] = {}

PIPELINES = pipelines(MARTS_DIR, CRON_OVERRIDES)
```

The job of `<name>` selects the dbt models under `models/marts/<name>` and everything upstream of them, ingestion assets included, so one tick runs the whole pipeline: sources first, then dbt. Today every pipeline runs daily at 06:00 UTC. A cron with no timezone runs in UTC.

1. Add the pipeline's cron to `CRON_OVERRIDES`. That is the whole change. Five cron fields: `0 6 * * *` is daily at 06:00, `0 */6 * * *` every six hours, `0 6 * * 1` Mondays at 06:00. Two pipelines that read the same source each run it, so two pipelines that share a source and a time load it twice.
2. Check that it loads: `cd orchestration && uv run pytest`. The tests load the definitions, and Dagster refuses a cron it cannot read, so a wrong cron fails them. Every key must be a folder of marts that holds a model, or `pipelines()` raises. Removing a marts folder removes its job, and a model that stays in no folder of marts leaves its assets with no scheduled job, which `test_every_asset_and_check_runs_in_a_scheduled_pipeline` reports.
3. Reload Dagster. `dagster dev` does not reread the file on its own: restart it (Ctrl-C, then `uv run --project orchestration bj dev`) or reload the code location in its UI at http://localhost:3000. Then open Automation there: the schedule shows the new cron and its next tick. A schedule starts stopped, so turn it on there. `bj dev` keeps that state in `orchestration/.dagster_home` (or `DAGSTER_HOME`, when set), so it outlasts a restart.
4. Prove it. After the tick, the run is under Runs in the Dagster UI, started by the schedule, and on the Grafana pipeline dashboard at http://localhost:3001/d/pipeline, whose Every run table lists each Dagster run with its id, sources, models and tests. Click the run to see its steps. To see the job run without waiting for the tick, `uv run --project orchestration bj run <pipeline>` runs the same job from the terminal, its steps side by side as the schedule runs them.

Never:

- add Airflow, a crontab, a compose service or any other scheduler. Dagster's is the only one;
- schedule one asset, model or source on its own, or give a pipeline a second job or schedule. One job and one schedule per pipeline, both from `PIPELINES`;
- edit `jobs` or `schedules` below `PIPELINES`. `CRON_OVERRIDES` is the only thing to change.
