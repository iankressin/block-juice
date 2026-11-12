-- Daily ETH, USDT and USDC flows to and from the 23 Ethereum wallets DefiLlama labels as MEXC, over blocks
-- 26359254 to 26366423 (2026-11-07 UTC), in long form: inflow, outflow and net in whole tokens with their
-- transfer counts, for every counterparty (all) and for the Binance PoR addresses (binance), plus the
-- intra-set flows between two MEXC wallets, which net leaves out. ETH is successful top-level transactions
-- with value; internal ETH is not counted. macros/labelled_flows.sql defines each metric. For the ticket's
-- full window, change the blocks here, in _by_period and in the headline, and in question.yaml.
{{ labelled_flows_daily(
    'MEXC',
    'ethereum',
    [['eth', 'native'], ['usdt', '0xdac17f958d2ee523a2206206994597c13d831ec7'], ['usdc', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48']],
    ['Binance'],
    26359254,
    26366423
) }}
order by day, token, counterparty, metric
