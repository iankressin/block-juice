# Planted bugs: how much the dbt tests prove

A green test run says the tests found nothing. It does not say they would have found something. `transformation/planted_bugs.py` measures that: it plants one small bug at a time in a model, rebuilds the model and everything that reads it, and records whether a test failed.

## Run it

You need a Postgres server whose user may create databases. The script makes a database of its own there and drops it when it ends, so it reads and changes no warehouse.

```sh
set -a && . ./.env && set +a
uv run --project orchestration python transformation/planted_bugs.py                      # every model
uv run --project orchestration python transformation/planted_bugs.py --select dex_trades+  # some models, by dbt selector
uv run --project orchestration python transformation/planted_bugs.py --rows my-rows/       # with raw rows loaded
```

Without `--rows`, every raw table is empty. The dbt unit tests bring their own rows, so they still run, and a model with no unit test shows up as not exercised. With `--rows`, the script loads each `<raw table>.jsonl` in the folder, one `{"id": …, "data": …}` object a line, and the data tests have rows to check.

`--per-operator` and `--per-model` set how many bugs one model gets. The defaults are 3 of each kind and 12 in all, the same ones every run. `--json` prints one object per bug in place of the table.

A run that is killed leaves its database behind, named `planted_bugs_<id>`. Drop it by hand.

## The bugs

Each bug is one rewrite of the model's SQL, outside comments, Jinja and string literals.

| Kind | Rewrite |
|---|---|
| `arithmetic` | `+` becomes `-`, `*` becomes `/`, and back |
| `bound` | `>=` becomes `>`, `<` becomes `<=`, and back |
| `negation` | `=` becomes `!=`, `is null` becomes `is not null`, a `not` goes |
| `condition` | one `and` or `or` line goes, or a one-line `where` |
| `join` | `inner join` becomes `left join`, and back |
| `pick` | `min` becomes `max`, `greatest` becomes `least`, `desc` becomes `asc`, a `distinct` goes |
| `branch` | the two results of a `then … else … end` trade places |
| `number` | a number goes up by one: `1e6` becomes `1e7` |

## Reading the table

| Outcome | Meaning |
|---|---|
| `caught` | A test that passed before the bug failed with it. |
| `missed` | The model's rows, or the rows of a model that reads it, changed, and every test still passed. Each one is listed under the table with its line. |
| `not_exercised` | Nothing changed. Either the rewrite means the same, or the data has no row that takes that path. |
| `build_error` | The rewritten SQL did not run. |
| `timeout` | A statement ran past 60 seconds, as a dropped join condition can. |

The catch rate is `caught / (caught + missed)`: of the bugs that changed the output and still built, the share a test caught. A missed bug names a test worth writing. A model with many bugs not exercised needs a unit test, or rows that reach its branches.

Two notes can follow the table. A test that fails before any bug is planted catches nothing, so the reference tests need their window's rows in `--rows`. A model that does not build before any bug gets none.
