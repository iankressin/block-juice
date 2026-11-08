{#- An amount in base units, cast only when its text is all digits. Postgres would also cast '1e3', ' 7',
    'NaN' or '-5', and staging must not turn such text into a number, so anything else is null and the
    amount tests name the row. -#}
{% macro unsigned_numeric(text) -%}
    case when ({{ text }}) ~ '^[0-9]+$' then ({{ text }})::numeric end
{%- endmacro %}
