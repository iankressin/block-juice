-- Warns when var('coverage') says what polygon.erc20_transfers has loaded, yet no wallet has a second
-- balance reading inside those blocks, so polymarket_wallet_cash_flows_match_balances compared nothing.
-- The ref below and the coverage tag make bj answer run this test wherever it runs the reconciliation.
-- depends_on: {{ ref('polymarket_wallet_cash_flows') }}
{{ config(severity='warn', tags=['coverage']) }}
{%- set readings = polymarket_cash_readings() %}
{%- if var('coverage', {}).get('polygon.erc20_transfers') %}
select count(*) as readings from ({{ readings }}) as readings having count(*) = 0
{%- else %}
select 0 as readings where false
{%- endif %}
