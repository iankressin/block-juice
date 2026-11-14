{# Each pair explains transfers after its first reading through its second. The reading just
   before a verified interval can therefore serve as that interval's opening balance. #}
{%- macro erc20_balance_pairs() %}
{%- set balances = ref('stg_ethereum__erc20_balances') %}
{%- set loaded = var('coverage', {}).get('ethereum.erc20_transfers') %}
{%- set ranges = loaded.get('verified_ranges', [loaded.covered] if loaded.covered else []) if loaded else [] %}
{%- if ranges %}
with intervals(first_block, last_block) as (
    values
    {% for first, last in ranges -%}
    ({{ first | int }}::bigint, {{ last | int }}::bigint){{ ',' if not loop.last }}
    {% endfor %}
), readings as (
    select
        wallet,
        token,
        lag(block_number) over ordered as from_block,
        block_number as to_block,
        balance - lag(balance) over ordered as balance_change
    from {{ balances }}
    join intervals on block_number between first_block - 1 and last_block
    where balance is not null
        {% if 'wallets' in loaded.filter -%}
        and wallet in ('{{ loaded.filter.wallets | map('lower') | map('replace', "'", "''") | join("', '") }}')
        {% endif -%}
        and token in ('{{ loaded.filter.tokens | map('lower') | map('replace', "'", "''") | join("', '") }}')
    window ordered as (partition by first_block, wallet, token order by block_number)
)
select * from readings where from_block is not null
{%- else %}
select null::text as wallet, null::text as token, null::bigint as from_block, null::bigint as to_block, null::numeric as balance_change
where false
{%- endif %}
{%- endmacro %}
