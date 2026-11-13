"""Exercise PostgreSQL-specific state/aggregation rules on transaction-local fixtures.

These models must retain historical corrections, inclusive bridge finality boundaries and
complementary Polymarket prices. Tables are temporary; no warehouse relations are changed.
"""

import os
from pathlib import Path

import psycopg2
import pytest
from jinja2 import Environment


MODELS = Path(__file__).resolve().parents[2] / "transformation" / "models"


def model_sql(path):
    return Environment().from_string((MODELS / path).read_text()).render(
        ref=lambda name: name, source=lambda chain, table: f"raw_{chain}_{table}",
        config=lambda **kwargs: ""
    )


@pytest.fixture
def postgres():
    keys = ("WAREHOUSE_HOST", "WAREHOUSE_PORT", "WAREHOUSE_USER", "WAREHOUSE_PASSWORD")
    if not all(os.environ.get(key) for key in keys):
        pytest.skip("set WAREHOUSE_HOST/PORT/USER/PASSWORD to run PostgreSQL model fixtures")
    settings = dict(zip(("host", "port", "user", "password"), (os.environ[key] for key in keys)))
    connection = psycopg2.connect(**settings, dbname=os.environ.get("WAREHOUSE_DB", "warehouse"))
    try:
        with connection.cursor() as cursor:
            yield cursor
    finally:
        connection.rollback()
        connection.close()


def test_bridge_candidates_include_ready_ties_and_exclude_same_chain(postgres):
    postgres.execute("""
        create temp table bridge_transfers (
            id text, chain text, ethereum_address text, ethereum_token text, amount numeric,
            block_timestamp timestamptz, direction text, l2_address text, tx_hash text
        );
        insert into bridge_transfers values
            ('b1', 'base', 'wallet', 'token', 10, '2026-01-01', 'to_ethereum', 'b', 'b1'),
            ('b2', 'base', 'wallet', 'token', 10, '2026-01-01', 'to_ethereum', 'b', 'b2'),
            ('b3', 'base', 'wallet', 'token', 10, '2026-01-05', 'to_ethereum', 'b', 'b3'),
            ('a1', 'arbitrum', 'wallet', 'token', 10, '2025-12-01', 'to_ethereum', 'a', 'a1'),
            ('d1', 'arbitrum', 'wallet', 'token', 10, '2026-01-02', 'from_ethereum', 'a', 'd1'),
            ('d2', 'arbitrum', 'wallet', 'token', 10, '2026-01-02', 'from_ethereum', 'a', 'd2'),
            ('d3', 'arbitrum', 'wallet', 'token', 10, '2026-01-05', 'from_ethereum', 'a', 'd3'),
            ('other', 'base', 'wallet', 'different', 10, '2025-01-01', 'to_ethereum', 'b', 'x');
    """)
    query = model_sql("marts/bridges/bridge_pairs.sql")
    postgres.execute(f"select withdrawal_id, deposit_id, candidates from ({query}) q order by 1")
    assert postgres.fetchall() == [("b1", "d1", 2), ("b2", "d2", 2)]
    # A late correction changes eligibility and must affect the already-existing deposit.
    postgres.execute("update bridge_transfers set block_timestamp='2026-01-03' where id='b2'")
    postgres.execute(f"select withdrawal_id, deposit_id, candidates from ({query}) q order by 1")
    assert postgres.fetchall() == [("b1", "d1", 1)]


def test_candles_preserve_order_complements_null_prices_and_own_volumes(postgres):
    postgres.execute("""
        create temp table polymarket_trades (
            token_id numeric, block_timestamp timestamptz, block_number bigint, log_index int,
            price numeric, shares numeric, usdc numeric
        );
        create temp table int_polymarket_outcome_tokens (
            token_id numeric, condition_id text, outcome text, complement_token_id numeric
        );
        insert into int_polymarket_outcome_tokens values
            (1, 'condition', 'yes', 2), (2, 'condition', 'no', 1), (3, 'null', 'null', null);
        insert into polymarket_trades values
            (1, '2026-01-01', 10, 4, .2, 5, 1),
            (2, '2026-01-01', 10, 2, .6, 10, 6),
            (1, '2026-01-01', 11, 0, .3, 10, 3),
            (1, '2026-01-01 00:01', 12, 0, .7, 10, 7),
            (3, '2026-01-01', 1, 0, null, 0, 0),
            (3, '2026-01-01', 2, 0, .8, 1, .8);
    """)
    query = model_sql("marts/polymarket/polymarket_price_candles.sql")
    postgres.execute(f"""
        select token_id::int, minute::text, open::float, high::float, low::float, close::float,
               trades, shares_volume::float, usdc_volume::float from ({query}) q order by 1, 2
    """)
    rows = postgres.fetchall()
    assert [row[2:] for row in rows] == [
        (.4, .4, .2, .3, 2, 15., 4.), (.7, .7, .7, .7, 1, 10., 7.),
        (.6, .8, .6, .7, 1, 10., 6.), (.3, .3, .3, .3, 0, 0., 0.),
        (None, .8, .8, .8, 2, 1., .8),
    ]
    postgres.execute("update polymarket_trades set price=null where token_id=3 and block_number=2")
    postgres.execute(f"select open, close from ({query}) q where token_id=3")
    assert postgres.fetchone() == (None, None)
    postgres.execute("update polymarket_trades set price=.9 where token_id=1 and block_number=11")
    postgres.execute(f"select close::float from ({query}) q where token_id=2 order by minute limit 1")
    assert postgres.fetchone()[0] == .1


def test_deployments_reject_failed_ancestors_and_count_distinct_new_slots(postgres):
    postgres.execute("""
        create temp table stg_ethereum__contract_deployments (
            id text, block_number bigint, transaction_index int, trace_address int[],
            trace_type text, error text, create_from text, create_address text, create_code text
        );
        create temp table stg_ethereum__contract_deployments_transactions (
            block_number bigint, block_timestamp timestamptz, transaction_index int, hash text,
            from_address text, to_address text, sighash text, transaction_type int, status int
        );
        create temp table stg_ethereum__contract_deployments_state_diffs (
            block_number bigint, transaction_index int, address text, key text,
            is_storage boolean, diff_kind text, prev text, next text
        );
        insert into stg_ethereum__contract_deployments_transactions values
            (1, '2026-01-01', 0, 'tx1', 'sender', null, null, 2, 1),
            (1, '2026-01-01', 1, 'tx2', 'sender', null, null, 2, 0),
            (1, '2026-01-01', 2, 'tx3', 'sender', null, null, 2, 1);
        insert into stg_ethereum__contract_deployments values
            ('root', 1, 0, '{}', 'call', null, null, null, null),
            ('failed', 1, 0, '{0}', 'call', 'revert', null, null, null),
            ('hidden', 1, 0, '{0,0}', 'create', null, 'deployer', 'hidden', '0xaaaa'),
            ('ok', 1, 0, '{1}', 'create', null, 'deployer', 'new', '0xaabbcc'),
            ('old', 1, 0, '{2}', 'create', null, 'deployer', 'existing', '0xaa'),
            ('self-failed', 1, 0, '{3}', 'create', 'revert', 'deployer', 'bad', '0xaa'),
            ('bad-transaction', 1, 1, '{}', 'create', null, 'deployer', 'bad', '0xaa'),
            ('bad-root', 1, 2, '{}', 'call', 'revert', null, null, null),
            ('bad-root-child', 1, 2, '{0}', 'create', null, 'deployer', 'bad', '0xaa');
        insert into stg_ethereum__contract_deployments_state_diffs values
            (1, 0, 'existing', 'balance', false, '*', '0x01', '0x02'),
            (1, 0, 'existing', 'nonce', false, '*', '0x01', '0x02'),
            (1, 0, 'new', '0x01', true, '+', null, '0x01'),
            (1, 0, 'new', '0x01', true, '*', '0x00', '0x02'),
            (1, 0, 'new', '0x02', true, '*', '0x0000', '0x0001'),
            (1, 0, 'new', '0x03', true, '*', '0x01', '0x02'),
            (1, 0, 'new', '0x04', true, '-', '0x01', null);
    """)
    query = model_sql("intermediate/deployments/int_ethereum_deployment_state_gas.sql")
    postgres.execute(f"select tx_hash, creates, new_accounts, code_bytes, new_slots, state_gas from ({query}) q")
    assert postgres.fetchall() == [("tx1", 2, 1, 4, 2, 385560)]
    # A corrected ancestor must restore an old create; new slots retain their distinct semantics.
    postgres.execute("update stg_ethereum__contract_deployments set error=null where id='failed'")
    postgres.execute(f"select creates, new_accounts, code_bytes, new_slots from ({query}) q")
    assert postgres.fetchall() == [(3, 2, 6, 2)]


def test_existing_polymarket_holdings_revalue_on_resolution_metadata_and_redemption(postgres):
    postgres.execute("""
        create temp table int_polymarket_wallet_ledger (
            condition_id text, wallet text, token_id numeric, shares_delta numeric,
            usdc_delta numeric, fee_usdc numeric, kind text, block_number bigint,
            log_index int, zeroes_position boolean, block_timestamp timestamptz
        );
        create temp table polymarket_markets (
            condition_id text, resolved_at timestamptz, payout_fractions numeric[], history_complete boolean
        );
        create temp table int_polymarket_outcome_tokens (token_id numeric, outcome_index int);
        create temp table polymarket_price_candles (token_id numeric, minute timestamptz, close numeric);
        insert into int_polymarket_wallet_ledger values
            ('condition', 'wallet', 1, 10, -4, 0, 'trade', 100, 1, false, '2026-01-01');
        insert into polymarket_markets values ('condition', null, null, true);
        insert into int_polymarket_outcome_tokens values (1, 0);
        insert into polymarket_price_candles values (1, '2026-01-01', .6);
    """)
    query = model_sql("marts/polymarket/polymarket_market_participants.sql")

    def position():
        postgres.execute(f"select open_shares, position_value_usdc, pnl_usdc from ({query}) q")
        return postgres.fetchone()

    assert position() == (10, 6, 2)
    postgres.execute("update polymarket_markets set resolved_at='2026-01-02', payout_fractions=array[1,0]")
    assert position() == (10, 10, 6)
    # A metadata correction affects an old holding even with no new ledger row.
    postgres.execute("update int_polymarket_outcome_tokens set outcome_index=1")
    assert position() == (10, 0, -4)
    postgres.execute("""
        insert into int_polymarket_wallet_ledger values
            ('condition', 'wallet', 1, null, null, null, 'redemption', 110, 1, true, '2026-01-03'),
            ('condition', 'wallet', null, null, 10, null, 'redemption', 110, 1, false, '2026-01-03');
    """)
    assert position() == (0, 0, 6)
    postgres.execute("delete from int_polymarket_wallet_ledger where block_number=110")
    assert position() == (10, 0, -4)


def test_gamma_shared_projection_preserves_distinct_token_and_name_winners(postgres):
    postgres.execute("""
        create temp table raw_polymarket_markets (data jsonb, _loaded_at timestamptz);
        insert into raw_polymarket_markets values
            (jsonb_build_object('id','1','version','v1','conditionId','condition','question','old name','outcomes','["yes","no"]'), now()),
            (jsonb_build_object('id','2','version','v1','conditionId','condition','clobTokenIds','["101","102"]','outcomes','["yes","no"]'), now()),
            ('{"id":"3","version":"v1","conditionId":"empty","clobTokenIds":"[]"}', now()),
            (jsonb_build_object('id','4','version','v1','conditionId','empty','clobTokenIds','["201"]'), now()),
            (jsonb_build_object('id','5','version','v2','conditionId','v2','clobTokenIds','["301"]'), now());
        create temp table int_polygon_polymarket_ctf_conditions (
            condition_id text, prepared_block bigint, history_complete boolean
        );
        create temp table int_polygon_polymarket_ctf_resolutions (
            condition_id text, resolved_at timestamptz, payout_fraction numeric, outcome_index int
        );
    """)
    postgres.execute("create temp view stg_polymarket__markets as " + model_sql("staging/polymarket/stg_polymarket__markets.sql"))
    for name in ("int_polymarket_markets", "int_polymarket_outcome_tokens"):
        postgres.execute(f"create temp view {name} as " + model_sql(f"intermediate/polymarket/{name}.sql"))
    query = model_sql("marts/polymarket/polymarket_markets.sql")
    postgres.execute(f"select condition_id, market_id, question, protocol from ({query}) q order by condition_id")
    # Staging's array_agg maps a JSON empty array to SQL NULL, so token eligibility falls through
    # to id=4 while the independently chosen Gamma name still comes from id=3.
    rows = postgres.fetchall()
    assert rows == [("condition", "1", "old name", "ctf"), ("empty", "3", None, "ctf")]
    # Keep the query-local shared selection equivalent to both public projection contracts.
    postgres.execute("""
        select t.condition_id, g.market_id, g.question, t.protocol
        from (select distinct condition_id, protocol from int_polymarket_outcome_tokens) t
        left join int_polymarket_markets g on g.condition_id=t.condition_id
        order by t.condition_id
    """)
    assert postgres.fetchall() == rows
    postgres.execute("""
        update raw_polymarket_markets set data=jsonb_set(data, '{question}', '"corrected"')
        where data->>'id'='1'
    """)
    postgres.execute(f"select question from ({query}) q where condition_id='condition'")
    assert postgres.fetchone()[0] == "corrected"


def test_latest_balances_keep_highest_block_then_latest_observation(postgres):
    postgres.execute("""
        create temp table int_ethereum_balances (
            chain text, wallet text, asset_type text, asset text, block_number bigint,
            balance numeric, _loaded_at timestamptz
        );
        create temp table int_solana_balances (like int_ethereum_balances);
        create temp table int_bitcoin_balances (like int_ethereum_balances);
        insert into int_ethereum_balances values
            ('ethereum', 'wallet', 'native', 'eth', 100, 10, '2026-01-01'),
            ('ethereum', 'wallet', 'native', 'eth', 100, 20, '2026-01-02'),
            ('ethereum', 'wallet', 'native', 'eth', 90, 99, '2026-01-03');
    """)
    query = model_sql("marts/balances/latest_balances.sql")
    postgres.execute(f"select block_number, balance from ({query}) q")
    assert postgres.fetchone() == (100, 20)
    postgres.execute("update int_ethereum_balances set balance=30, _loaded_at='2026-01-04' where balance=10")
    postgres.execute(f"select block_number, balance from ({query}) q")
    assert postgres.fetchone() == (100, 30)


def test_cow_late_traces_trades_and_receipt_corrections_update_old_orders(postgres):
    postgres.execute("""
        create temp table int_ethereum_cow_ethflow_orders as select
            'ethereum'::text as chain, null::text as order_uid, 100::bigint as block_number,
            '2026-01-01'::timestamptz as block_timestamp, 0 as transaction_index, 'placement'::text as tx_hash,
            'wallet'::text as owner, 'ethflow'::text as eth_flow, 100::numeric as eth_value_wei,
            'weth'::text as sell_token, 'stablecoin'::text as buy_token, 'wallet'::text as receiver,
            100::numeric as sell_amount, 200::numeric as buy_amount, 0::numeric as fee_amount,
            false as partially_fillable;
        create temp table int_ethereum_cow_trades (
            chain text, order_uid text, tx_hash text, block_number bigint, block_timestamp timestamptz,
            transaction_index int, log_index int, settlement text, sell_amount numeric,
            buy_amount numeric, fee_amount numeric
        );
        create temp table int_ethereum_cow_wallet_transfers (
            chain text, tx_hash text, from_address text, to_address text, token text, amount numeric
        );
        insert into int_ethereum_cow_trades values
            ('ethereum', 'uid', 'settlement-tx', 200, '2026-01-02', 0, 1, 'settlement', 100, 210, 1);
        insert into int_ethereum_cow_wallet_transfers values
            ('ethereum', 'settlement-tx', 'settlement', 'wallet', 'stablecoin', 209);
    """)
    query = model_sql("marts/cow/cow_ethflow_orders.sql")

    def order():
        postgres.execute(f"select settled, trades, executed_buy_amount, received_amount from ({query}) q")
        return postgres.fetchone()

    assert order() == (False, 0, None, None)
    postgres.execute("update int_ethereum_cow_ethflow_orders set order_uid='uid'")
    assert order() == (True, 1, 210, 209)
    postgres.execute("update int_ethereum_cow_wallet_transfers set amount=208")
    assert order() == (True, 1, 210, 208)
    postgres.execute("delete from int_ethereum_cow_trades")
    assert order() == (False, 0, None, None)


def test_late_labels_and_other_token_transfers_reclassify_historical_deposits(postgres):
    postgres.execute("""
        create temp table erc20_transfers (
            chain text, id text, block_number bigint, block_timestamp timestamptz, tx_hash text,
            log_index int, token text, from_address text, to_address text, value numeric
        );
        create temp table address_labels (chain text, address text, kind text, exchange text);
        insert into erc20_transfers values
            ('base', 'old', 100, '2026-01-01', 'tx1', 1, 'token', 'depositor', 'destination', 10);
        insert into address_labels values ('base', 'depositor', 'eoa', null);
    """)
    query = model_sql("marts/transfers/classified_transfers.sql")

    def old_transfer():
        postgres.execute(f"select from_kind, to_kind, category from ({query}) q where id='old'")
        return postgres.fetchone()

    assert old_transfer() == ("eoa", "unknown", "unknown")
    postgres.execute("insert into address_labels values ('base','destination','exchange','CEX')")
    assert old_transfer() == ("deposit", "exchange", "exchange")
    postgres.execute("""
        insert into erc20_transfers values
            ('base', 'new', 200, '2026-01-02', 'tx2', 1, 'other-token', 'depositor', 'elsewhere', 1)
    """)
    assert old_transfer() == ("eoa", "exchange", "exchange")
