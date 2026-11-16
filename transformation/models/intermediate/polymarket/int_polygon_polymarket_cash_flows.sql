-- One row per transfer of Polymarket's cash, pUSD or USDC.e, into or out of a wallet whose balance the
-- sources read, with the kind of move behind it and the wallet's balance after it. usdc_delta and balance
-- are whole tokens: usdc_delta is positive when the wallet got the tokens, negative when it sent them.
-- Rules:
--   The cash tokens are the catalog's pusd and usdc_e, both with 6 decimals, from
--   macros/polymarket_cash_tokens.sql. pUSD is what wallets pay and get paid in; USDC.e is what pUSD
--   wraps and what ConditionalTokens pays a direct caller.
--   A wallet's rows start after its first balance reading of the token (evm-erc20-balances), and balance
--   is that reading plus every transfer since, in log order. A wallet with no reading has no rows, and
--   neither have transfers at or before the reading's block. A transfer between two such wallets gives a
--   row for each. A transfer from a wallet to itself moves nothing and is left out.
--   kind comes from what Polymarket did for the wallet in the same transaction: trade when an OrderFilled
--   of CTF Exchange v2 fills the wallet's order, else split, merge, redeem or convert when a position
--   event names the wallet (NOTES.md Q4, Q5: the adapters' initiator, the auto-redeemers' from, a
--   stakeholder or redeemer). A fill wins over a position event, and of several position events the
--   first kind by name. A redemption or merge pays in pUSD minted to the wallet, so a mint alone says
--   nothing: the transaction does. Unlike int_polymarket_wallet_ledger, no market is dropped for missing
--   from Gamma, so cash from every loaded fill and position event is told apart from the rest.
--   With neither in the transaction, kind says only what the chain shows. unwrap: the wallet sent pUSD
--   to pUSD's own contract, or got USDC.e from pUSD's vault, the two legs of turning pUSD back into
--   USDC.e. They cancel out across the two tokens; an unwrap paid in native USDC, which is not loaded,
--   would show its pUSD leg alone. mint: the tokens came from the zero address. burn: they went to it.
--   transfer: any other transfer. Deposits, withdrawals and payments such as rewards are among mint, burn
--   and transfer, and counterparty tells them apart. A wallet that withdraws through an unwrap shows it
--   as the USDC.e transfer that follows.
--   So mint, burn and transfer also hold whatever Polymarket did that the sources do not tie to the
--   wallet: anything in blocks the Polymarket sources have not loaded, Protocol V2 fills and payouts,
--   whose modules mint pUSD too, and a call the wallet made straight to a first-generation adapter, whose
--   events name the adapter (NOTES.md Q5). Check counterparty before calling a mint a deposit.
--   The wallets with a reading must be wallets the transfers source follows. One that is not gets rows
--   for only the transfers it shares with one that is.
with cash_tokens as (
    {{ polymarket_cash_tokens() }}
),

-- Each wallet's first reading of each cash token: where its rows start and what its balance adds to.
openings as (
    select distinct on (wallet, asset)
        wallet,
        asset as token,
        block_number,
        balance
    from {{ ref('int_polygon_balances') }}
    where asset in (select token from cash_tokens)
    order by wallet, asset, block_number
),

transfers as (
    select id, block_number, block_timestamp, tx_hash, log_index, token, from_address, to_address, value
    from {{ ref('int_polygon_erc20_transfers') }}
    where from_address <> to_address
),

-- Each transfer seen from its receiver and from its sender.
sides as (
    select
        id, block_number, block_timestamp, tx_hash, log_index, token,
        to_address as wallet,
        from_address as counterparty,
        true as received,
        value as delta_base
    from transfers
    union all
    select
        id, block_number, block_timestamp, tx_hash, log_index, token,
        from_address as wallet,
        to_address as counterparty,
        false as received,
        -value as delta_base
    from transfers
),

position_events as (
    select
        tx_hash,
        case
            when event like 'collateral_adapter.%' then initiator
            when event like 'auto_redeemer.%' then from_address
            else stakeholder
        end as wallet,
        case
            when event in ('ctf.PositionSplit', 'neg_risk.PositionSplit', 'collateral_adapter.PositionSplit')
                then 'split'
            when event in ('ctf.PositionsMerge', 'neg_risk.PositionsMerge', 'collateral_adapter.PositionsMerged')
                then 'merge'
            when event in (
                'ctf.PayoutRedemption', 'neg_risk.PayoutRedemption', 'collateral_adapter.PositionsRedeemed',
                'auto_redeemer.BinaryRedemption', 'auto_redeemer.NegRiskRedemption'
            )
                then 'redeem'
            when event in ('neg_risk.PositionsConverted', 'collateral_adapter.PositionsConverted')
                then 'convert'
        end as kind
    from {{ ref('stg_polygon__polymarket_ctf') }}
),

-- What Polymarket did for a wallet in a transaction, one kind each: a fill first, then the first position
-- kind by name.
activity as (
    select distinct on (tx_hash, wallet)
        tx_hash,
        wallet,
        kind
    from (
        select tx_hash, wallet, 'trade' as kind, 1 as rank
        from {{ ref('int_polygon_polymarket_ctf_exchange_v2_fills') }}
        union all
        select tx_hash, wallet, kind, 2 as rank
        from position_events
        where kind is not null and wallet is not null
    ) as actions
    order by tx_hash, wallet, rank, kind
)

select
    s.id || ':' || s.wallet as id,
    s.block_number,
    s.block_timestamp,
    s.tx_hash,
    s.log_index,
    s.wallet,
    s.token,
    c.symbol,
    s.counterparty,
    case
        when a.kind is not null then a.kind
        when s.counterparty = c.unwrap_counterparty and s.received = c.unwrap_received then 'unwrap'
        when s.counterparty <> '0x0000000000000000000000000000000000000000' then 'transfer'
        when s.received then 'mint'
        else 'burn'
    end as kind,
    round(s.delta_base / 1e6, 6) as usdc_delta,
    round(
        (
            o.balance
            + sum(s.delta_base) over (partition by s.wallet, s.token order by s.block_number, s.log_index)
        ) / 1e6,
        6
    ) as balance
from sides as s
inner join cash_tokens as c on c.token = s.token
inner join openings as o
    on o.wallet = s.wallet
    and o.token = s.token
    and s.block_number > o.block_number
left join activity as a
    on a.tx_hash = s.tx_hash
    and a.wallet = s.wallet
