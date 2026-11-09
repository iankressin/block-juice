{#- The rows where `actual`, a CTE the calling test defines, disagrees with `expected`, a reference seed:
    keys only in expected, keys only in actual, and keys in both whose `value` differs by more than the
    tolerance. A relative tolerance is a share of the expected value; where that value is 0 it counts as
    absolute. A null value on one side only is over any tolerance. transformation/seeds/reference/README.md
    shows a test that calls it. -#}
{%- macro reference_mismatches(expected, actual, key, value, tolerance_kind, tolerance) %}
{%- if tolerance_kind not in ['absolute', 'relative'] %}
    {{- exceptions.raise_compiler_error("reference_mismatches: tolerance_kind must be absolute or relative, not " ~ tolerance_kind) }}
{%- endif %}
{%- set e_value = 'e.' ~ adapter.quote(value) ~ '::numeric' %}
{%- set a_value = 'a.' ~ adapter.quote(value) ~ '::numeric' %}
{%- set limit = '(' ~ tolerance ~ ')::numeric' %}
{%- if tolerance_kind == 'relative' %}
{%- set limit = 'case when ' ~ e_value ~ ' = 0 then ' ~ limit ~ ' else ' ~ limit ~ ' * abs(' ~ e_value ~ ') end' %}
{%- endif %}
select *
from (
    select
        {%- for column in key %}
        coalesce(e.{{ adapter.quote(column) }}, a.{{ adapter.quote(column) }}) as {{ adapter.quote(column) }},
        {%- endfor %}
        {{ e_value }} as expected,
        {{ a_value }} as actual,
        case
            when a._in_actual is null then 'missing_in_actual'
            when e._in_expected is null then 'missing_in_expected'
            when ({{ e_value }} is null) <> ({{ a_value }} is null) then 'over_tolerance'
            when abs({{ a_value }} - {{ e_value }}) > {{ limit }} then 'over_tolerance'
        end as reason
    from (select *, true as _in_expected from {{ expected }}) as e
    full outer join (select *, true as _in_actual from {{ actual }}) as a
        on {% for column in key -%}
        e.{{ adapter.quote(column) }} = a.{{ adapter.quote(column) }}{% if not loop.last %} and {% endif %}
        {%- endfor %}
) as compared
where reason is not null
{%- endmacro %}
