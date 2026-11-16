{#- Each balance reading of a wallet and cash token on Polygon after the wallet's first, up to the cursor of
    polygon.erc20_transfers, in whole tokens (6 decimals), with the first reading's balance beside it: the
    readings polymarket_wallet_cash_flows can be checked against. bj answer passes what the source has
    loaded, as `bj coverage` prints it, in var('coverage'). Without it, as in a scheduled build, or
    before the source's first run, no rows. -#}
{%- macro polymarket_cash_readings() %}
{%- set balances = ref('int_polygon_balances') %}
{%- set loaded = var('coverage', {}).get('polygon.erc20_transfers') %}
{%- if loaded and loaded.covered %}
{%- set cursor = loaded.covered[1] %}
select * from (
    select
        wallet,
        asset as token,
        block_number,
        balance / 1e6 as balance,
        first_value(balance) over (partition by wallet, asset order by block_number) / 1e6 as opening_balance,
        row_number() over (partition by wallet, asset order by block_number) as reading
    from {{ balances }}
    where block_number <= {{ cursor }}
        and asset in (select token from ({{ polymarket_cash_tokens() }}) as cash_tokens)
) as readings
where reading > 1
{%- else %}
select
    null::text as wallet, null::text as token, null::bigint as block_number, null::numeric as balance,
    null::numeric as opening_balance, null::bigint as reading
where false
{%- endif %}
{%- endmacro %}
