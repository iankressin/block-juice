# Add a pipeline

A pipeline is the marts in `transformation/models/marts/<pipeline>/` and everything upstream of them. Dagster runs each pipeline as its own job, on its own schedule. `balances` is the example.

1. Make each mart hold one kind of fact for every chain and asset it covers, such as `latest_balances`. Never build a mart for one question; the question's filter belongs in its analysis.
2. Put models that only this pipeline reads in `models/intermediate/<pipeline>/`. This is where joins and rules go, per [../references/layers.md](../references/layers.md). Staging models stay in `models/staging/<source>/`, since any pipeline can read them, and only cast and rename.
3. When a mart stacks chains, give each chain one intermediate model that brings its rows into the mart's shape, as `int_<chain>_balances` does.
4. Test the mart in `_<pipeline>__models.yml`: `not_null` on keys, `unique` on the grain, `accepted_values` on columns with a fixed set of values.
5. Add the pipeline and its cron schedule to `PIPELINES` in `orchestration/pipeline/schedules.py`. Use a daily schedule unless the user asks for another.
6. Build and test it:

   ```sh
   set -a && . ./.env && set +a && cd transformation && uv run --project ../orchestration dbt build --select +path:models/marts/<pipeline>
   set -a && . ./.env && set +a && cd orchestration && uv run pytest
   ```

   The orchestration tests check that each source feeds its staging model and that every asset runs in a scheduled pipeline.

7. Load it end to end, sources included, with `uv run --project orchestration bj run <pipeline>`.

Start each mart's SQL with a comment that says what one row is and which units it uses, as `latest_balances.sql` does.
