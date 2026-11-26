{#- One row per address in address_attributions with `attribution` on `chain`: its top-level native flows over
    blocks from_block to to_block, from wallet_transactions, and its state from account_states. Amounts in wei.

    - sent_value_wei: value of its successful transactions. sent_fees_wei: fee_wei of every transaction it
      sent, reverted ones too. sent_out_wei: the two summed. Blob fees are left out (blob_fees_wei).
    - received_wei: value of the successful transactions to it. Internal transfers are in neither.
    - state_block: the latest block at or before to_block at which account_states holds reads. balance_wei,
      nonce and code_kind are read there.
    - has_code: true when code_kind is not 'none' at state_block or at code_also_at, the block before the
      flows a code check also covers. Null when a code read at either block has not loaded and none found
      code. Such an address, or one with code, can move native value through internal calls this does not see.
    - active: it sent a transaction, or received a successful one, in the window. -#}
{%- macro attributed_eth_flows(attribution, chain, from_block, to_block, code_also_at) %}
    with attributed as (
        select distinct address
        from {{ ref('address_attributions') }}
        where chain = '{{ chain }}' and attribution = '{{ attribution }}'
    ),

    window_txs as (
        select *
        from {{ ref('wallet_transactions') }}
        where chain = '{{ chain }}' and block_number between {{ from_block }} and {{ to_block }}
    ),

    sent as (
        select
            from_address as address,
            count(*) as sent_txs,
            count(*) filter (where not succeeded) as sent_failed_txs,
            coalesce(sum(value_wei) filter (where succeeded), 0) as sent_value_wei,
            sum(fee_wei) as sent_fees_wei,
            sum(blob_fee_wei) as blob_fees_wei
        from window_txs
        group by from_address
    ),

    received as (
        select to_address as address, count(*) as received_txs, sum(value_wei) as received_wei
        from window_txs
        where succeeded and to_address is not null
        group by to_address
    ),

    state_block as (
        select max(block_number) as block_number
        from {{ ref('account_states') }}
        where chain = '{{ chain }}' and block_number <= {{ to_block }}
    ),

    held as (
        select s.address, s.block_number, s.balance_wei, s.nonce, s.code_kind
        from {{ ref('account_states') }} as s
        inner join state_block on s.block_number = state_block.block_number
        where s.chain = '{{ chain }}'
    ),

    code as (
        select
            s.address,
            bool_or(s.code_kind <> 'none') as found_code,
            count(distinct s.block_number) filter (where s.code_kind is not null) as code_reads
        from {{ ref('account_states') }} as s
        cross join state_block
        where s.chain = '{{ chain }}' and s.block_number in ({{ code_also_at }}, state_block.block_number)
        group by s.address
    )

    select
        attributed.address,
        (select block_number from state_block) as state_block,
        coalesce(sent.sent_txs, 0) as sent_txs,
        coalesce(sent.sent_failed_txs, 0) as sent_failed_txs,
        coalesce(sent.sent_value_wei, 0) as sent_value_wei,
        coalesce(sent.sent_fees_wei, 0) as sent_fees_wei,
        coalesce(sent.sent_value_wei, 0) + coalesce(sent.sent_fees_wei, 0) as sent_out_wei,
        coalesce(sent.blob_fees_wei, 0) as blob_fees_wei,
        coalesce(received.received_txs, 0) as received_txs,
        coalesce(received.received_wei, 0) as received_wei,
        held.balance_wei,
        held.nonce,
        held.code_kind,
        case
            when code.found_code then true
            when code.code_reads = (select count(distinct b) from state_block, unnest(array[{{ code_also_at }}, state_block.block_number]) as b) then false
        end as has_code,
        sent.address is not null or received.address is not null as active
    from attributed
    left join sent on sent.address = attributed.address
    left join received on received.address = attributed.address
    left join held on held.address = attributed.address
    left join code on code.address = attributed.address
{%- endmacro %}
