{# Optional maintenance, never an ingestion/model hook. Keep the raw views live while giving
   repeated latest-reading queries an ordered access path. Concurrent builds do not block writes.
   Run with: dbt run-operation index_state_readings --args '{family: address_code}' #}
{% macro index_state_readings(family) %}
    {% set families = {
        'address_code': {
            'arbitrum_address_code': "lower(data ->> 'address'), ((data ->> 'block_number')::bigint) desc",
            'base_address_code': "lower(data ->> 'address'), ((data ->> 'block_number')::bigint) desc"
        },
        'account_state': {
            'ethereum_account_state': "((data ->> 'block_number')::bigint), (data ->> 'kind'), lower(data ->> 'address'), _loaded_at desc"
        }
    } %}
    {% if family not in families %}
        {{ exceptions.raise_compiler_error('Unknown state index family: ' ~ family ~
            '. Supported families: ' ~ families.keys()|list|join(', ')) }}
    {% endif %}
    {% for table, expressions in families[family].items() %}
        {% set relation = adapter.get_relation(database=target.database,
            schema=env_var('RAW_SCHEMA', 'raw'), identifier=table) %}
        {% if relation is none %}
            {{ log('Skipping absent raw relation ' ~ table, info=True) }}
        {% else %}
            {{ index_state_relation(relation, expressions) }}
        {% endif %}
    {% endfor %}
{% endmacro %}

{% macro index_state_relation(relation, expressions) %}
    {% set name = 'bj_state_' ~ local_md5(relation|string ~ ':' ~ expressions) %}
    {% set index = adapter.quote(relation.schema) ~ '.' ~ adapter.quote(name) %}
    {% set key = relation|string ~ ':' ~ name %}
    {% set lock = run_query("select pg_try_advisory_lock(hashtextextended('" ~ key|replace("'", "''") ~ "', 0))") %}
    {% if not lock.rows[0][0] %}
        {{ log('Another session is building ' ~ index ~ '; skipped', info=True) }}
        {{ return(none) }}
    {% endif %}
    {# Failed/interrupted concurrent builds can leave an invalid index. Re-running repairs only
       this command's deterministic index, under its session lock. On SQL failure dbt closes the
       connection and releases the lock; it never holds an ingestion transaction open. #}
    {% set present = run_query("select i.indisvalid from pg_index i where i.indexrelid = to_regclass('" ~
        index|replace("'", "''") ~ "')") %}
    {% if present.rows|length and not present.rows[0][0] %}
        {% do run_query('drop index concurrently ' ~ index) %}
        {{ log('Removed interrupted index ' ~ index, info=True) }}
    {% endif %}
    {% do run_query('create index concurrently if not exists ' ~ adapter.quote(name) ~
        ' on ' ~ relation ~ ' (' ~ expressions ~ ')') %}
    {% do run_query('analyze ' ~ relation) %}
    {% do run_query("select pg_advisory_unlock(hashtextextended('" ~ key|replace("'", "''") ~ "', 0))") %}
    {{ log('Ready: ' ~ index, info=True) }}
{% endmacro %}
