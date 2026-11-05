{#- The ERC-20 transfers of the token in var('token'), each chain's inside that chain's blocks. -#}
{%- macro token_transfers() %}
    {%- for w in var('token').windows %}
    select chain, id, block_number, block_timestamp, tx_hash, from_address, to_address, value
    from {{ ref('erc20_transfers') }}
    where chain = '{{ w.chain }}'
        and token = '{{ w.token | lower }}'
        and block_number between {{ w.blocks[0] }} and {{ w.blocks[1] }}
    {%- if not loop.last %}
    union all
    {%- endif %}
    {%- endfor %}
{%- endmacro %}

{#- The bridge moves of the token in var('token'), by its Ethereum address, each chain's inside that
    chain's blocks. -#}
{%- macro token_bridge_transfers() %}
    select *
    from {{ ref('bridge_transfers') }}
    where ethereum_token = '{{ var('token').ethereum | lower }}'
        and (
            {%- for w in var('token').windows %}
            (chain = '{{ w.chain }}' and block_number between {{ w.blocks[0] }} and {{ w.blocks[1] }})
            {%- if not loop.last %} or{% endif %}
            {%- endfor %}
        )
{%- endmacro %}

{#- One whole token in base units, as numeric: divide a base-unit amount by it. -#}
{%- macro token_unit() %}power(10::numeric, {{ var('token').decimals }}){% endmacro %}
