{# Exact incremental writes for a complete model result. Unlike an event-time watermark this
   also sees old corrections, removed rows, late commits and changed seed/dimension rows.
   The query still reads its complete inputs; this strategy reduces writes, not input scans. #}
{% macro reconcile_config(keys, indexes=[]) %}
    {{ config(
        materialized='incremental', incremental_strategy='reconcile', unique_key=keys,
        on_schema_change='sync_all_columns', indexes=[], meta={'reconcile_indexes': indexes},
        pre_hook="{{ reconcile_lock() }}",
        post_hook=["{{ reconcile_key() }}", "{{ reconcile_indexes() }}", "analyze {{ this }}"]
    ) }}
{% endmacro %}

{% macro fact_config(keys, indexes=[]) %}
    {% set strategy = var('fact_strategy', 'table') %}
    {% set use_indexes = var('fact_indexes', False) %}
    {% if use_indexes is not boolean %}
        {{ exceptions.raise_compiler_error('fact_indexes must be a YAML boolean (true or false)') }}
    {% endif %}
    {% if not use_indexes %}{% set indexes = [] %}{% endif %}
    {% if strategy == 'reconcile' %}
        {{ reconcile_config(keys, indexes) }}
    {% elif strategy == 'table' %}
        {{ config(materialized='table', indexes=indexes,
                  post_hook="analyze {{ this }}") }}
    {% else %}
        {{ exceptions.raise_compiler_error('fact_strategy must be table or reconcile, not ' ~ strategy) }}
    {% endif %}
{% endmacro %}

{% macro reconcile_lock() %}
    {# Existing-table incremental runs lock before evaluating their candidates. dbt resolves the
       relation before pre-hooks, so callers still coordinate first creation and full refresh. #}
    select pg_advisory_xact_lock(hashtextextended('{{ dbt.escape_single_quotes('block-juice:reconcile:' ~ this) }}', 0))
{% endmacro %}

{% macro reconcile_index_name(relation, columns, unique=False) %}
    {# Stable for updates, distinct for --full-refresh: the old backup and its indexes still
       exist when post-hooks run, so a name based only on the model would skip the new index. #}
    {% if execute %}
        {# Reuse an equivalent dbt-created index when switching an existing table to reconcile. #}
        {% set existing_sql %}
            select c.relname
            from pg_index i join pg_class c on c.oid = i.indexrelid
            join pg_am am on am.oid = c.relam
            where i.indrelid = '{{ dbt.escape_single_quotes(relation|string) }}'::regclass
                and i.indisvalid and i.indisready and i.indpred is null and i.indexprs is null
                and am.amname = 'btree' and i.indnatts = {{ columns|length }}
                {% if unique %}and i.indisunique{% endif %}
                and array(select a.attname::text
                    from unnest(i.indkey) with ordinality k(attnum, position)
                    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
                    order by k.position) = array[
                    {% for column in columns %}'{{ dbt.escape_single_quotes(column) }}'{% if not loop.last %}, {% endif %}{% endfor %}
                ]::text[]
            limit 1
        {% endset %}
        {% set existing = run_query(existing_sql) %}
        {% if existing.rows|length %}{{ return(existing.rows[0][0]) }}{% endif %}
        {% set identity = run_query("select '" ~ dbt.escape_single_quotes(relation|string) ~ "'::regclass::oid").rows[0][0] %}
        {{ return('bj_fact_' ~ local_md5(identity|string ~ columns|join(',') ~ unique|string)) }}
    {% endif %}
{% endmacro %}

{% macro reconcile_key(relation=this) %}
    {% if execute %}
    {% set keys = config.get('unique_key') %}
    {% if keys is string %}{% set keys = [keys] %}{% endif %}
    {% set quoted = [] %}
    {% for key in keys %}{% do quoted.append(adapter.quote(key)) %}{% endfor %}
    create unique index if not exists {{ adapter.quote(reconcile_index_name(relation, keys, True)) }}
        on {{ relation }} ({{ quoted|join(', ') }});
    {% for key in keys %}
    alter table {{ relation }} alter column {{ adapter.quote(key) }} set not null;
    {% endfor %}
    {% endif %}
{% endmacro %}

{% macro reconcile_indexes(relation=this) %}
    {% if execute %}
    {% for index in config.get('meta').get('reconcile_indexes', []) %}
        {% set columns = [] %}
        {% for column in index['columns'] %}{% do columns.append(adapter.quote(column)) %}{% endfor %}
        create index if not exists {{ adapter.quote(reconcile_index_name(relation, index['columns'])) }}
            on {{ relation }} ({{ columns|join(', ') }});
    {% endfor %}
    {% endif %}
{% endmacro %}

{% macro get_incremental_reconcile_sql(arg_dict) %}
    {% set target = arg_dict['target_relation'] %}
    {% set snapshot = arg_dict['temp_relation'] %}
    {% set keys = arg_dict['unique_key'] %}
    {% if keys is string %}{% set keys = [keys] %}{% endif %}
    {% if not keys %}{{ exceptions.raise_compiler_error('reconcile requires a unique_key') }}{% endif %}
    {% set key_columns, matches, columns, old_values, new_values, assignments = [], [], [], [], [], [] %}
    {% for key in keys %}
        {% set column = adapter.quote(key) %}
        {% do key_columns.append(column) %}
        {% do matches.append('t.' ~ column ~ ' = s.' ~ column) %}
    {% endfor %}
    {% for item in arg_dict['dest_columns'] %}
        {% set column = adapter.quote(item.name) %}
        {% do columns.append(column) %}
        {% do old_values.append('t.' ~ column) %}
        {% do new_values.append('s.' ~ column) %}
        {% do assignments.append(column ~ ' = s.' ~ column) %}
    {% endfor %}

    {# Validate the entire candidate before changing the target. Index statistics also prevent
       bad join estimates when a new snapshot is much larger than the previous one. #}
    {% for column in key_columns %}
    alter table {{ snapshot }} alter column {{ column }} set not null;
    {% endfor %}
    create unique index on {{ snapshot }} ({{ key_columns|join(', ') }});
    analyze {{ snapshot }};

    {# PostgreSQL 16 MERGE has no NOT MATCHED BY SOURCE. Remove omitted keys separately in the
       same transaction, after candidate validation. Keep MERGE last so dbt's affected-row count
       reports inserts/updates; deletion counts require separate warehouse telemetry. #}
    delete from {{ target }} as t
    where not exists (select 1 from {{ snapshot }} as s where {{ matches|join(' and ') }});

    merge into {{ target }} as t using {{ snapshot }} as s
        on {{ matches|join(' and ') }}
    when matched and row({{ old_values|join(', ') }}) is distinct from row({{ new_values|join(', ') }})
        then update set {{ assignments|join(', ') }}
    when not matched then insert ({{ columns|join(', ') }}) values ({{ new_values|join(', ') }});

{% endmacro %}
