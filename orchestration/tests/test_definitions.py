import logging

import dagster as dg
import pytest

from pipeline.assets.ingestion import SOURCES, package_dir, parse_log_line
from pipeline.definitions import defs


@pytest.mark.parametrize("source, table", SOURCES)
def test_ingestion_feeds_its_staging_model(source, table):
    graph = defs.resolve_asset_graph()
    upstream = graph.get(dg.AssetKey(f"stg_{source}__{table}")).parent_keys
    assert dg.AssetKey([source, table]) in upstream


@pytest.mark.parametrize("source, table", SOURCES)
def test_ingestion_package_exists(source, table):
    assert (package_dir(source, table) / "package.json").is_file()


@pytest.mark.parametrize("source, table", SOURCES)
def test_ingestion_assets_have_dead_letter_check(source, table):
    check = dg.AssetCheckKey(dg.AssetKey([source, table]), "no_dead_letters")
    assert check in defs.resolve_asset_graph().asset_check_keys


def test_mart_reads_each_chain_through_its_union():
    graph = defs.resolve_asset_graph()
    assert graph.get(dg.AssetKey("latest_balances")).parent_keys == {
        dg.AssetKey("int_ethereum_balances_unioned"),
        dg.AssetKey("int_solana_balances_unioned"),
    }
    assert graph.get(dg.AssetKey("int_ethereum_balances_unioned")).parent_keys == {
        dg.AssetKey("stg_ethereum__eth_balances"),
        dg.AssetKey("stg_ethereum__erc20_balances"),
    }
    assert graph.get(dg.AssetKey("int_solana_balances_unioned")).parent_keys == {
        dg.AssetKey("stg_solana__sol_balances"),
        dg.AssetKey("stg_solana__spl_balances"),
    }


def test_every_asset_and_check_runs_in_a_scheduled_pipeline():
    graph = defs.resolve_asset_graph()
    scheduled = {schedule.job_name for schedule in defs.schedules}
    jobs = [job for job in defs.jobs if job.name in scheduled]
    assert {key for job in jobs for key in job.selection.resolve(graph)} == graph.get_all_asset_keys()
    assert {key for job in jobs for key in job.selection.resolve_checks(graph)} == graph.asset_check_keys


def test_pino_line_logs_at_its_level_with_its_fields():
    line = '{"level":40,"time":1,"pid":2,"hostname":"h","source":"ethereum","table":"eth_balances","failedCalls":3,"msg":"Some calls failed"}'
    assert parse_log_line(line) == (logging.WARNING, "Some calls failed failedCalls=3")


def test_pino_fatal_line_carries_the_stack():
    line = '{"level":60,"msg":"Run failed","err":{"type":"Error","message":"boom","stack":"Error: boom\\n    at run"}}'
    assert parse_log_line(line) == (logging.CRITICAL, "Run failed\nError: boom\n    at run")


def test_other_output_logs_as_info():
    assert parse_log_line("not json") == (logging.INFO, "not json")
    assert parse_log_line("42") == (logging.INFO, "42")
