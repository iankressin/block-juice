"""Synthetic PostgreSQL model benchmarks. Only temporary relations are created.

Run from an environment with psycopg2 and Jinja2 (the orchestration uv environment).
WAREHOUSE_HOST/PORT/USER/PASSWORD/DB choose the test server. --baseline-ref must exist locally.
Results include all three timings and the last EXPLAIN ANALYZE plan; compare medians, not one run.
"""
import argparse
import json
import os
import statistics
import subprocess
from pathlib import Path
import psycopg2
from jinja2 import Environment
ROOT = Path(__file__).resolve().parents[2]

def render(path, old=False):
    relative = 'transformation/models/' + path
    text = subprocess.check_output(['git', 'show', args.baseline_ref + ':' + relative], cwd=ROOT, text=True) if old else (ROOT / relative).read_text()
    return Environment().from_string(text).render(ref=lambda name: name, config=lambda **kwargs: '')

def measure(path):
    results = {}
    for old in (True, False):
        timings = []
        for _ in range(3):
            q.execute('explain (analyze, buffers, format json) ' + render(path, old))
            plan = q.fetchone()[0][0]
            timings.append(plan['Execution Time'])
        results['baseline' if old else 'changed'] = {'ms': timings, 'median_ms': statistics.median(timings), 'plan': plan}
    print(json.dumps({'model': path, **results}), flush=True)

def bridge():
    q.execute('create temp table bridge_transfers(id text,chain text,ethereum_address text,ethereum_token text,amount numeric,block_timestamp timestamptz,direction text,l2_address text,tx_hash text)')
    for n in [1000, 5000]:
        q.execute('truncate bridge_transfers')
        q.execute("insert into bridge_transfers select 'w'||i,'base','wallet','token',10,'2026-01-01'::timestamptz+i*interval '1 second','to_ethereum','wallet','tx'||i from generate_series(1,%s)i union all select 'd'||i,'arbitrum','wallet','token',10,'2026-01-02'::timestamptz+i*interval '1 second','from_ethereum','wallet','tx'||i from generate_series(1,%s)i; analyze bridge_transfers", (n, n))
        print(json.dumps({'bridge_pairs_per_side': n}), flush=True)
        measure('marts/bridges/bridge_pairs.sql')

def candles():
    q.execute('set local enable_nestloop=off')
    q.execute("create temp table polymarket_trades(token_id numeric,block_timestamp timestamptz,block_number bigint,log_index int,price numeric,shares numeric,usdc numeric); create temp table int_polymarket_outcome_tokens(token_id numeric,condition_id text,outcome text,complement_token_id numeric); insert into int_polymarket_outcome_tokens values (1,'condition','yes',2),(2,'condition','no',1);")
    for n in [10000, 100000]:
        q.execute('truncate polymarket_trades')
        q.execute("insert into polymarket_trades select 1,'2026-01-01'::timestamptz,i,0,(i%%100)::numeric/100,1,(i%%100)::numeric/100 from generate_series(1,%s)i; analyze polymarket_trades; analyze int_polymarket_outcome_tokens", (n,))
        print(json.dumps({'candle_fills': n}), flush=True)
        measure('marts/polymarket/polymarket_price_candles.sql')

def gamma():
    q.execute('set enable_nestloop=off')
    q.execute('create temp table raw_markets(data jsonb,_loaded_at timestamptz); create temp table int_polygon_polymarket_ctf_conditions(condition_id text,prepared_block bigint,history_complete boolean); create temp table int_polygon_polymarket_ctf_resolutions(condition_id text,resolved_at timestamptz,payout_fraction numeric,outcome_index int)')
    q.execute('create temp view stg_polymarket__markets as ' + Environment().from_string((ROOT / 'transformation/models/staging/polymarket/stg_polymarket__markets.sql').read_text()).render(source=lambda *a: 'raw_markets'))
    for name in ['int_polymarket_markets', 'int_polymarket_outcome_tokens']:
        q.execute('create temp view ' + name + ' as ' + render('intermediate/polymarket/' + name + '.sql'))
    for n in [1000, 10000]:
        q.execute('truncate raw_markets')
        q.execute('insert into raw_markets select jsonb_build_object(\'id\',i::text,\'version\',\'v1\',\'conditionId\',\'condition\'||i,\'question\',\'Question \'||i,\'outcomes\',\'["Yes","No"]\',\'clobTokenIds\',jsonb_build_array(i*2,i*2+1)::text,\'events\',jsonb_build_array(jsonb_build_object(\'id\',i::text,\'title\',\'Event\'))),now() from generate_series(1,%s)i; analyze raw_markets', (n,))
        print(json.dumps({'markets': n}), flush=True)
        measure('marts/polymarket/polymarket_markets.sql')

def deployments():
    q.execute('set enable_nestloop=off')
    q.execute('create temp table raw_deployments(id text, data jsonb, _loaded_at timestamptz default now())')
    for name in ['contract_deployments', 'contract_deployments_transactions', 'contract_deployments_state_diffs']:
        path = ROOT / 'transformation/models/staging/ethereum' / ('stg_ethereum__' + name + '.sql')
        query = Environment().from_string(path.read_text()).render(source=lambda *a: 'raw_deployments')
        q.execute('create temp view stg_ethereum__' + name + ' as ' + query)
    for n in [100, 1000]:
        q.execute('truncate raw_deployments')
        q.execute("insert into raw_deployments select 'tx'||i,jsonb_build_object('kind','transaction','block_number',i,'timestamp','2026-01-01','transactionIndex',0,'hash','tx'||i,'from','sender','type',2,'status',1),now() from generate_series(1,%s)i; insert into raw_deployments select i||'-'||j,jsonb_build_object('kind','trace','block_number',i,'transaction_index',0,'trace_address',array[j],'trace_type',case when j%%2=0 then 'create' else 'call' end,'error',case when j=1 then 'revert' end,'action',jsonb_build_object('from','deployer'),'result',jsonb_build_object('address','created'||j,'code','0xaaaa')),now() from generate_series(1,%s)i cross join generate_series(0,99)j; analyze raw_deployments", (n, n))
        print(json.dumps({'transactions': n, 'traces_per_tx': 100}), flush=True)
        measure('intermediate/deployments/int_ethereum_deployment_state_gas.sql')

def address_code():
    q.execute("create temp table raw_state(id text,data jsonb,_loaded_at timestamptz); insert into raw_state select i::text,jsonb_build_object('address','wallet'||(i%1000),'block_number',i/1000,'code','0x'),'2026-01-01'::timestamptz from generate_series(1,200000)i; analyze raw_state")
    q.execute('create temp view stg_base__address_code as ' + Environment().from_string((ROOT / 'transformation/models/staging/base/stg_base__address_code.sql').read_text()).render(source=lambda *a: 'raw_state'))
    query = render('intermediate/labels/int_base_address_code.sql')
    for indexed in [False, True]:
        if indexed:
            q.execute("create index on raw_state (lower(data->>'address'), ((data->>'block_number')::bigint) desc); analyze raw_state")
        runs = []
        for i in range(3):
            q.execute('explain (analyze,buffers,format json) ' + query)
            p = q.fetchone()[0][0]
            runs.append(p['Execution Time'])
        print(json.dumps({'indexed': indexed, 'ms': runs, 'median_ms': statistics.median(runs), 'plan': p}), flush=True)

def snapshots():
    q.execute("create temp table raw_state(id text,data jsonb,_loaded_at timestamptz); insert into raw_state select i::text,jsonb_build_object('address','wallet'||(i%1000),'wallet','wallet'||(i%1000),'token','token'||(i%1000),'block_number',i/1000,'code','0x','kind',case when i%3=0 then 'balance' when i%3=1 then 'nonce' else 'code' end,'nonce',0,'balance',100,'name','Token','symbol','TOK','decimals',18),'2026-01-01'::timestamptz from generate_series(1,200000)i; analyze raw_state")

    def view(name, path, empty=False):
        s = Environment().from_string((ROOT / 'transformation/models' / path).read_text()).render(source=lambda *a: 'raw_state', ref=lambda n: n)
        q.execute('create temp view ' + name + ' as ' + ('select * from (' + s + ') x where false' if empty else s))
    view('stg_ethereum__eth_balances', 'staging/ethereum/stg_ethereum__eth_balances.sql')
    view('stg_ethereum__erc20_balances', 'staging/ethereum/stg_ethereum__erc20_balances.sql', True)
    view('int_ethereum_balances', 'intermediate/balances/int_ethereum_balances.sql')
    q.execute('create temp view int_solana_balances as select * from int_ethereum_balances where false; create temp view int_bitcoin_balances as select * from int_ethereum_balances where false')
    for chain in ['ethereum', 'arbitrum', 'base']:
        view('stg_' + chain + '__erc20_metadata', 'staging/' + chain + '/stg_' + chain + '__erc20_metadata.sql', chain != 'ethereum')
        view('int_' + chain + '_erc20_metadata', 'intermediate/tokens/int_' + chain + '_erc20_metadata.sql')
    view('stg_ethereum__account_state', 'staging/ethereum/stg_ethereum__account_state.sql')
    for model, expr in [('marts/balances/latest_balances.sql', "lower(data->>'wallet'), ((data->>'block_number')::bigint) desc, _loaded_at desc"), ('marts/tokens/tokens.sql', "lower(data->>'token'), ((data->>'block_number')::bigint) desc, _loaded_at desc"), ('intermediate/accounts/int_ethereum_account_states.sql', "((data->>'block_number')::bigint), (data->>'kind'), lower(data->>'address'), _loaded_at desc")]:
        for indexed in [False, True]:
            if indexed:
                q.execute('create index test_state_index on raw_state (' + expr + '); analyze raw_state')
            times = []
            for i in range(3):
                q.execute('explain (analyze,buffers,format json) ' + render(model))
                p = q.fetchone()[0][0]
                times.append(p['Execution Time'])
            print(json.dumps({'model': model, 'indexed': indexed, 'ms': times, 'median_ms': statistics.median(times), 'plan': p}), flush=True)
        q.execute('drop index test_state_index')
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline-ref', default='fc873ce')
    parser.add_argument('--case', choices=['all', 'bridge', 'candles', 'gamma', 'deployments', 'address_code', 'snapshots'], default='all')
    args = parser.parse_args()
    settings = {field: os.environ['WAREHOUSE_' + name] for field, name in (('host', 'HOST'), ('port', 'PORT'), ('user', 'USER'), ('password', 'PASSWORD'), ('dbname', 'DB'))}
    conn = psycopg2.connect(**settings)
    try:
        with conn.cursor() as q:
            for name in ('bridge', 'candles', 'gamma', 'deployments', 'address_code', 'snapshots'):
                if args.case not in ('all', name):
                    continue
                q.execute("set local statement_timeout='90s'; set local jit=off; set local work_mem='4MB'")
                globals()[name]()
                conn.rollback()
    finally:
        conn.close()
