{#- Daily flows of `entity`'s labelled wallets on `chain` over blocks from_block to to_block, from
    labelled_wallet_flows, in long form: one row per day, token, counterparty and metric.

    - assets: a list of [token, asset] pairs, where token names the asset in the output (such as 'usdt') and
      asset is 'native' or the token's address. A native amount is in whole coins (18 decimals); a token's
      decimals come from the tokens mart, so a token missing there gives null amounts.
    - day: the UTC date of the block's timestamp, which assigns each block to the day whose first block is
      the first at or after 00:00:00 UTC. Only days with at least one flow of the entity, of any asset, appear.
    - counterparty: 'all' for every flow, and lower(name) for each entity in counterparties, for the flows
      whose other side is that entity's.
    - metrics: inflow, outflow and net (inflow - outflow) in whole tokens, inflow_transfers and
      outflow_transfers as counts. For 'all' also intra and intra_transfers: movements between two of the
      entity's wallets, which inflow, outflow and net leave out.
    labelled_wallet_flows defines inflow, outflow and intra. -#}
{%- macro labelled_flows_daily(entity, chain, assets, counterparties, from_block, to_block) %}
    with assets as (
        select
            a.token,
            a.asset,
            case when a.asset = 'native' then 18 else t.decimals end as decimals
        from (
            values
            {%- for token, asset in assets %}
                ('{{ token }}', '{{ asset | lower }}'){% if not loop.last %},{% endif %}
            {%- endfor %}
        ) as a (token, asset)
        left join {{ ref('tokens') }} as t on t.chain = '{{ chain }}' and t.token = a.asset
    ),

    flows as (
        select
            (f.block_timestamp at time zone 'UTC')::date as day,
            f.asset,
            f.direction,
            f.counterparty_entity,
            f.value
        from {{ ref('labelled_wallet_flows') }} as f
        where f.chain = '{{ chain }}'
            and f.entity = '{{ entity }}'
            and f.block_number between {{ from_block }} and {{ to_block }}
    ),

    counterparties as (
        select 'all' as counterparty, null::text as counterparty_entity
        {%- for c in counterparties %}
        union all
        select '{{ c | lower }}', '{{ c }}'
        {%- endfor %}
    ),

    grid as (
        select days.day, assets.token, assets.asset, assets.decimals, counterparties.*
        from (select distinct day from flows) as days
        cross join assets
        cross join counterparties
    ),

    sums as (
        select
            g.day,
            g.token,
            g.counterparty,
            -- Times 10^-decimals, not divided by 10^decimals: numeric division rounds to about 16 significant
            -- digits, and multiplication is exact.
            coalesce(sum(f.value) filter (where f.direction = 'inflow'), 0) * power(10::numeric, -g.decimals) as inflow,
            coalesce(sum(f.value) filter (where f.direction = 'outflow'), 0) * power(10::numeric, -g.decimals) as outflow,
            coalesce(sum(f.value) filter (where f.direction = 'intra'), 0) * power(10::numeric, -g.decimals) as intra,
            count(f.value) filter (where f.direction = 'inflow') as inflow_transfers,
            count(f.value) filter (where f.direction = 'outflow') as outflow_transfers,
            count(f.value) filter (where f.direction = 'intra') as intra_transfers
        from grid as g
        left join flows as f
            on f.day = g.day
            and f.asset = g.asset
            and (g.counterparty_entity is null or f.counterparty_entity = g.counterparty_entity)
        group by g.day, g.token, g.counterparty, g.decimals
    )

    select sums.day, sums.token, sums.counterparty, m.metric, trim_scale(m.amount) as amount
    from sums
    cross join lateral (
        values
            ('inflow', sums.inflow),
            ('outflow', sums.outflow),
            ('net', sums.inflow - sums.outflow),
            ('intra', sums.intra),
            ('inflow_transfers', sums.inflow_transfers::numeric),
            ('outflow_transfers', sums.outflow_transfers::numeric),
            ('intra_transfers', sums.intra_transfers::numeric)
    ) as m (metric, amount)
    where sums.counterparty = 'all' or m.metric not in ('intra', 'intra_transfers')
{%- endmacro %}
