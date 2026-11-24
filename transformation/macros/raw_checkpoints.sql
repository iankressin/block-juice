{# The call sources' checkpoint table in RAW_SCHEMA, which a call source makes on its first run. Until then
   it is an empty set with the same columns, so a test that reads checkpoints finds nothing to check instead
   of failing, and dbt build does not skip the models after it. #}
{% macro raw_checkpoints() %}
    {%- set relation = adapter.get_relation(
        database=target.database, schema=env_var('RAW_SCHEMA', 'raw'), identifier='_checkpoints') if execute else none -%}
    {%- if relation is none -%}
        (select null::text as source_table, null::text as key, null::jsonb as value, null::timestamptz as updated_at where false)
    {%- else -%}
        {{ relation }}
    {%- endif -%}
{% endmacro %}
