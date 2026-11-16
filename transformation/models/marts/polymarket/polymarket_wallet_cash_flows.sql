-- One row per transfer of Polymarket's cash, pUSD or USDC.e, into or out of a wallet whose balance the
-- sources read: every change to the wallet's cash, with the balance after it. usdc_delta and balance are
-- whole tokens; usdc_delta is positive when the wallet got the tokens. Sum usdc_delta over a wallet and
-- token, add the balance before its first row, and you have the balance at any block.
-- kind is trade, split, merge, redeem or convert when a CTF Exchange v2 fill or a position event of the
-- wallet sits in the transaction. Otherwise it says what the chain shows: unwrap (pUSD turned back into
-- USDC.e, in two legs that cancel out across the tokens), mint (tokens from the zero address), burn (tokens
-- to it) or transfer (any other transfer). Deposits, withdrawals and payments such as rewards are among the
-- last three, and so is anything Polymarket did that the sources do not tie to the wallet, such as a
-- Protocol V2 payout; counterparty tells them apart.
-- The rules, and what kind can be trusted over, are in int_polygon_polymarket_cash_flows.
select
    id, block_number, block_timestamp, tx_hash, log_index, wallet, token, symbol, counterparty, kind,
    usdc_delta, balance
from {{ ref('int_polygon_polymarket_cash_flows') }}
