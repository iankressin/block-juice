{{ config(tags=['reference']) }}
-- #45: shares RN1 traded per outcome token, side and maker/taker role, verified on polygon blocks 96972629
-- to 96975028 against the Polymarket Data API (/v2/activity and the taker-only /v2/trades). The actual CTE
-- is analyses/rn1_polymarket_fills_2026_11_08_by_token.sql. token_id is uint256, so it compares as text.
with actual as (
    select
        token_id::text as token_id,
        side,
        role,
        sum(shares) as shares
    from {{ ref('polymarket_wallet_fills') }}
    where wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and block_number between 96972629 and 96975028
    group by token_id, side, role
)
{{ reference_mismatches(ref('reference_rn1_polymarket_fills_2026_11_08'), 'actual', ['token_id', 'side', 'role'], 'shares', 'relative', 0.000001) }}
