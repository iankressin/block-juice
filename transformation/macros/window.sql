{#- An analysis's window on one chain, for in_window and for macros that take its bounds. bj answer passes
    it in var('window'), by chain: question.yaml's window, or its eval_window under --eval. A compile
    without it, as CI runs, still compiles, and the SQL fails when run, so no number comes from the wrong
    blocks. -#}
{%- macro window_bound(chain, index) -%}
{%- set blocks = var('window', {}).get(chain) -%}
{%- if blocks -%}
{{ blocks[index] | int }}
{%- else -%}
'no window for {{ chain }}: run bj answer'::bigint
{%- endif -%}
{%- endmacro %}

{%- macro window_start(chain) -%}{{ window_bound(chain, 0) }}{%- endmacro %}

{%- macro window_end(chain) -%}{{ window_bound(chain, 1) }}{%- endmacro %}

{%- macro in_window(column, chain) -%}
{{ column }} between {{ window_start(chain) }} and {{ window_end(chain) }}
{%- endmacro %}
