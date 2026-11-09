"""Stub pipelines for the bj run tests. bj run starts a process for each step, and each process imports
this module by name to rebuild the job, so the stubs live here and not in the test file."""

import os
import time
from pathlib import Path

import dagster as dg


@dg.asset
def loaded():
    return 1


@dg.asset(deps=[loaded])
def transformed():
    raise RuntimeError("relation raw.ethereum_eth_balances does not exist")


def waits_for(me: str, other: str) -> dg.AssetsDefinition:
    """An asset that marks that it started, then waits for `other` to start too."""

    @dg.asset(name=me)
    def _asset():
        barrier = Path(os.environ["STUB_BARRIER_DIR"])
        (barrier / me).touch()
        deadline = time.monotonic() + 20
        while not (barrier / other).exists():
            if time.monotonic() > deadline:
                raise RuntimeError(f"{me} ran alone: {other} never started")
            time.sleep(0.1)

    return _asset


a = waits_for("a", "b")
b = waits_for("b", "a")


@dg.asset
def fails():
    raise RuntimeError("source broke")


@dg.asset
def sibling():
    time.sleep(2)
    (Path(os.environ["STUB_BARRIER_DIR"]) / "sibling").touch()


@dg.asset(deps=[fails, sibling])
def after_both():
    """Stands in for the dbt step, which needs every load."""
    (Path(os.environ["STUB_BARRIER_DIR"]) / "after_both").touch()


defs = dg.Definitions(
    assets=[loaded, transformed, a, b, fails, sibling, after_both],
    jobs=[
        dg.define_asset_job("balances", selection=[loaded, transformed]),
        dg.define_asset_job("loads", selection=[loaded]),
        dg.define_asset_job("side_by_side", selection=[a, b]),
        dg.define_asset_job("one_fails", selection=[fails, sibling, after_both]),
    ],
)
