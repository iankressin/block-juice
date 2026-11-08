-- Fails on any movement whose value_tokens, scaled back by its decimals, is not exactly value_base.
select id, value_base, decimals, value_tokens
from {{ ref('token_movements') }}
where value_tokens * power(10::numeric, decimals) <> value_base
