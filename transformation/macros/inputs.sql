{#- One filter of a named input of question.yaml, as a SQL list: ('a', 'b'). bj answer passes the filters in
    var('inputs'), by input name and key, so a question's subject is written once, in question.yaml. A compile
    without it, as CI runs, still compiles, and the SQL fails when run, so no answer comes from a list that
    matches nothing. -#}
{%- macro input_values(input, key) -%}
{%- set values = var('inputs', {}).get(input, {}).get(key) -%}
{%- if values -%}
({%- for value in values -%}'{{ value | replace("'", "''") }}'{{ ', ' if not loop.last }}{%- endfor -%})
{%- else -%}
('no values for {{ input }}.{{ key }}: run bj answer'::bigint)
{%- endif -%}
{%- endmacro %}
