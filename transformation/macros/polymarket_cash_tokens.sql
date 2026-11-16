{#- Polymarket's cash tokens on Polygon, the catalog's pusd and usdc_e (protocol.yaml), both with 6
    decimals: one row each, with its lowercase address and its symbol.
    The last two columns say what an unwrap looks like in the token's transfers: the wallet sends pUSD to
    pUSD's own contract and gets the same USDC.e from pUSD's vault (protocol.yaml, pusd). unwrap_received
    is whether the wallet gets the token in that leg, unwrap_counterparty the other side of it. -#}
{%- macro polymarket_cash_tokens() %}
select token, symbol, unwrap_received, unwrap_counterparty
from (
    values
        (
            '0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb', 'pUSD',
            false, '0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb'
        ),
        (
            '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', 'USDC.e',
            true, '0xc417fd8e9661c0d2120b64a04bb3278c17e99db1'
        )
) as tokens (token, symbol, unwrap_received, unwrap_counterparty)
{%- endmacro %}
