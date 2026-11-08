-- One log of the polygon-polymarket-ctf source: ConditionalTokens, the NegRiskAdapter, pUSD's collateral
-- adapters and the auto-redeemers. event is the catalog's key, such as ctf.PositionSplit, because
-- ctf, neg_risk and collateral_adapter each emit a PositionSplit, with the same topic0 in two of them.
-- Field meanings are in catalog/protocols/polymarket/NOTES.md. Amounts are in base units (6 decimals).
--
-- One column per argument, null where the event has none. stakeholder is the argument that names the
-- wallet in ctf and neg_risk events, a redeemer included; initiator is the adapters' and from_address
-- the auto-redeemers'. index_sets holds a split's or merge's partition and a redemption's indexSets.
with logs as (
    select
        id,
        data ->> 'event' as event,
        (data ->> 'block_number')::bigint as block_number,
        (data ->> 'timestamp')::timestamptz as block_timestamp,
        data ->> 'tx_hash' as tx_hash,
        (data ->> 'log_index')::integer as log_index,
        lower(data ->> 'contract') as contract,
        data -> 'args' as args,
        _loaded_at
    from {{ source('polygon', 'polymarket_ctf') }}
)

select
    id,
    event,
    block_number,
    block_timestamp,
    tx_hash,
    log_index,
    contract,
    lower(args ->> 'conditionId') as condition_id,
    lower(args ->> 'oracle') as oracle,
    lower(args ->> 'questionId') as question_id,
    (args ->> 'outcomeSlotCount')::numeric as outcome_slot_count,
    case when jsonb_typeof(args -> 'payoutNumerators') = 'array'
        then array(select jsonb_array_elements_text(args -> 'payoutNumerators')::numeric)
    end as payout_numerators,
    lower(coalesce(args ->> 'stakeholder', args ->> 'redeemer')) as stakeholder,
    lower(args ->> 'initiator') as initiator,
    lower(args ->> 'from') as from_address,
    lower(args ->> 'collateralToken') as collateral_token,
    lower(args ->> 'parentCollectionId') as parent_collection_id,
    case when jsonb_typeof(coalesce(args -> 'partition', args -> 'indexSets')) = 'array'
        then array(select jsonb_array_elements_text(coalesce(args -> 'partition', args -> 'indexSets'))::numeric)
    end as index_sets,
    (args ->> 'amount')::numeric as amount,
    (args ->> 'amountOut')::numeric as amount_out,
    case when jsonb_typeof(args -> 'amounts') = 'array'
        then array(select jsonb_array_elements_text(args -> 'amounts')::numeric)
    end as amounts,
    (args ->> 'payout')::numeric as payout,
    lower(args ->> 'marketId') as neg_risk_market_id,
    (args ->> 'indexSet')::numeric as index_set,
    (args ->> 'feeBips')::numeric as fee_bips,
    (args ->> 'index')::numeric as question_index,
    (args ->> 'outcome')::boolean as outcome,
    _loaded_at
from logs
