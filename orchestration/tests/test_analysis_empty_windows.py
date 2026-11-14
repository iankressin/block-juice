"""Execute the authored SQL on temporary PostgreSQL relations, including empty ROLLUP totals."""

import os
from contextlib import closing
from decimal import Decimal
from pathlib import Path

import psycopg2
import pytest
from jinja2 import Environment

ROOT = Path(__file__).resolve().parents[2]
WALLET = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea"
TOKEN = "0x0000000000000000000000000000000000000001"


@pytest.fixture
def warehouse():
    names = ("WAREHOUSE_HOST", "WAREHOUSE_PORT", "WAREHOUSE_USER", "WAREHOUSE_PASSWORD", "WAREHOUSE_DB")
    if not all(os.environ.get(name) for name in names):
        pytest.skip("requires the disposable PostgreSQL WAREHOUSE_* settings")
    settings = dict(zip(("host", "port", "user", "password", "dbname"), (os.environ[n] for n in names)))
    with closing(psycopg2.connect(**settings)) as connection, connection, connection.cursor() as cursor:
        cursor.execute("""
            create temporary table polymarket_wallet_fills (
                condition_id text, wallet text, complement_token_id numeric, outcome_index integer,
                block_number bigint, log_index integer, block_timestamp timestamptz,
                side text, role text, shares numeric, usdc numeric, fee_usdc numeric
            );
            create temporary table polymarket_markets (
                condition_id text, is_sports boolean, game_start_time timestamptz
            );
            create temporary table classified_transfers (
                chain text, token text, block_number bigint, category text, value numeric
            );
        """)
        yield cursor


def query(cursor, name):
    variables = {
        "window": {"polygon": [100, 200]},
        "token": {"windows": [{"chain": "arbitrum", "token": TOKEN, "blocks": [100, 200]}]},
    }
    # Include the real scope macros so the fixtures exercise the same predicates as bj answer.
    text = "\n".join((ROOT / "transformation" / path).read_text() for path in (
        "macros/window.sql", "macros/token_transfers.sql", f"analyses/{name}.sql"
    ))
    statement = Environment().from_string(text).render(
        ref=lambda table: f'pg_temp."{table}"', var=lambda name, default=None: variables.get(name, default)
    )
    cursor.execute(statement)
    columns = [column.name for column in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def fills(cursor, zero=False):
    cursor.execute("insert into polymarket_markets values ('market', true, '2026-01-01 00:01+00')")
    for block, outcome, role, amount, paid, when in (
        (100, 0, "maker", 10, "4", "2026-01-01 00:00+00"),
        (101, 1, "taker", 5, "2.5", "2026-01-01 00:02+00"),
        (300, 0, "maker", 1000, "999", "2026-01-02 00:00+00"),
    ):
        cursor.execute(
            "insert into polymarket_wallet_fills values ('market', %s, 1, %s, %s, 0, %s, 'buy', %s, %s, %s, %s)",
            (WALLET, outcome, block, when, role, 0 if zero else amount,
             0 if zero else Decimal(paid), 0 if zero else Decimal("0.1")),
        )


@pytest.mark.parametrize("name, count, percentage", [
    ("rn1_polymarket_fills_2026_11_08_by_phase", "fills", "maker_fill_pct"),
    ("rn1_polymarket_fills_2026_11_08_pairs", "markets", "markets_bought_both_pct"),
])
def test_empty_rollup_window_has_zero_count_and_undefined_percentage(warehouse, name, count, percentage):
    result = query(warehouse, name)
    assert len(result) == 1
    assert result[0][count] == 0
    assert result[0][percentage] is None


@pytest.mark.parametrize("zero", [False, True])
def test_fill_percentages_preserve_nonempty_and_zero_amount_windows(warehouse, zero):
    fills(warehouse, zero)
    phases = query(warehouse, "rn1_polymarket_fills_2026_11_08_by_phase")
    total = next(row for row in phases if row["phase"] is None)
    assert total["fills"] == 2  # The fixture beyond the declared window is excluded.
    assert total["maker_fill_pct"] == Decimal("50.00")
    assert total["avg_price"] == (None if zero else Decimal("0.433333"))
    pairs = query(warehouse, "rn1_polymarket_fills_2026_11_08_pairs")
    total = next(row for row in pairs if row["kind"] is None)
    assert total["markets"] == 1
    assert total["markets_bought_both_pct"] == (Decimal("0.00") if zero else Decimal("100.00"))
    assert total["pair_cost_usdc"] == (None if zero else Decimal("4.650000"))
    assert total["pair_edge_usdc"] == (None if zero else Decimal("0.350000"))


@pytest.mark.parametrize("amounts, expected", [([], None), ([0, 0], None), ([25, 75], Decimal("25.00"))])
def test_exchange_share_handles_empty_and_zero_value_transfers(warehouse, amounts, expected):
    for category, value in zip(("exchange", "p2p"), amounts):
        warehouse.execute("insert into classified_transfers values ('arbitrum', %s, 100, %s, %s)",
                          (TOKEN, category, value))
    assert query(warehouse, "token_categories") == [{"exchange_share_pct": expected}]
