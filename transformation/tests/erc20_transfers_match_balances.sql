-- Between two consecutive balance readings of a wallet and token, the balance must change by the
-- transfers into the wallet minus those out of it, over the blocks after the first reading up to the
-- second. Only readings from the block before START_BLOCK to the cursor count, since outside them
-- transfers are missing. bj answer passes what ethereum.erc20_transfers has loaded, as `bj coverage`
-- prints it, in var('coverage'); without it, as in a scheduled build, the test selects no rows.
{%- set transfers = ref('erc20_transfers') %}
{%- set balances = ref('stg_ethereum__erc20_balances') %}
{%- set loaded = var('coverage', {}).get('ethereum.erc20_transfers') %}
{%- if loaded and loaded.covered %}
{%- set start_block, cursor = loaded.covered %}
{%- set wallets = loaded.filter.wallets | map('lower') | map('replace', "'", "''") | join("', '") %}
{%- set tokens = loaded.filter.tokens | map('lower') | map('replace', "'", "''") | join("', '") %}
with readings as (
    select
        wallet,
        token,
        lag(block_number) over (partition by wallet, token order by block_number) as from_block,
        block_number as to_block,
        balance - lag(balance) over (partition by wallet, token order by block_number) as balance_change
    from {{ balances }}
    where balance is not null
        and block_number between {{ start_block - 1 }} and {{ cursor }}
        and wallet in ('{{ wallets }}')
        and token in ('{{ tokens }}')
)

select
    r.wallet,
    r.token,
    r.from_block,
    r.to_block,
    r.balance_change,
    sum(case when t.to_address = r.wallet then t.value else 0 end)
    - sum(case when t.from_address = r.wallet then t.value else 0 end) as net_transfers,
    count(t.id) as transfers
from readings as r
left join {{ transfers }} as t
    on t.token = r.token
    and r.wallet in (t.from_address, t.to_address)
    and t.block_number > r.from_block
    and t.block_number <= r.to_block
where r.from_block is not null
group by r.wallet, r.token, r.from_block, r.to_block, r.balance_change
having r.balance_change
    <> sum(case when t.to_address = r.wallet then t.value else 0 end)
    - sum(case when t.from_address = r.wallet then t.value else 0 end)
{%- else %}
select null::text as wallet where false
{%- endif %}
