from datetime import datetime, timezone

import dagster as dg
from dagster_dbt import DbtCliResource, dbt_assets

from pipeline.project import dbt_project
from pipeline.run_log import record_dbt_build


# Without `project`, a dbt `path:` selector resolves against the working directory, not the dbt project.
# The factory's reference seeds and tests are fixtures, not pipeline assets (transformation/dbt_project.yml).
@dbt_assets(manifest=dbt_project.manifest_path, project=dbt_project, exclude="tag:reference")
def transformation_assets(context: dg.AssetExecutionContext, dbt: DbtCliResource):
    started_at = datetime.now(timezone.utc)
    # A subset run replaces the decorator's selection with the run's own, so the exclusion rides on the
    # command as well, or dbt's eager test selection pulls a reference test in through a selected mart.
    invocation = dbt.cli(["build", "--exclude", "tag:reference"], context=context, raise_on_error=False)
    try:
        yield from invocation.stream()
    finally:
        record_dbt_build(context.log, context.run_id, invocation, started_at)
    error = invocation.get_error()
    if error:
        raise error
