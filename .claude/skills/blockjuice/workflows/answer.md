# Answer a question

Each answer lives in `answers/<slug>/`. Pick a short slug that names the question, such as `tracked-wallets-eth`. If the folder exists, you are refreshing that answer: keep its `question.yaml` unless the user changed the question.

## 1. Scope

Write `answers/<slug>/question.yaml` in the format of [../references/question-spec.md](../references/question-spec.md).

- Define every word that could be counted two ways, such as "bought", "holder", "active" or "wallet". Pick the most literal reading, write it under `definitions`, and list the readings you passed over under `alternatives`.
- Resolve every token, contract and wallet to an address on its chain. Take addresses from the repo (the `addresses.json` files, existing models) or from the user. Never use an address from memory alone.
- When the question names a past time on an EVM chain, turn it into blocks with `bj blocks <chain> <from> <to>` and record both under `window`.
- Choose `state` or `history` for each input with [../references/choosing-the-data.md](../references/choosing-the-data.md).

## 2. Find the data

Look for marts that already hold each input, in `transformation/models/marts/*/`. Read a mart's SQL and its `_<pipeline>__models.yml` before trusting its name.

- Every input is in a mart: go to step 4.
- An input needs history: stop and tell the user which input needs it. History backfills are not built yet.
- An input needs state that no source reads: follow [state-source.md](state-source.md), then [new-pipeline.md](new-pipeline.md).
- The sources hold the data but no mart shapes it the way the question needs: follow [new-pipeline.md](new-pipeline.md).

Before you build a source or a pipeline, show the user the definitions, window and inputs from `question.yaml`, and wait for a go. When existing marts answer the question, do not stop to ask.

## 3. Load

Run the pipeline that builds the marts when they are missing, or older than the question needs:

```sh
uv run --project orchestration bj run <pipeline>
```

It runs every source and model the pipeline needs, the same job its schedule runs. Each source reads its own `ingestion/sources/<package>/.env`. Copy its `.env.example` when that file is missing, and tell the user which values to check.

## 4. Write the analysis

Write `transformation/analyses/<name>.sql`, where `<name>` is the slug with `_` for `-`.

- Select from marts with `{{ ref() }}`, never from staging or raw tables.
- Put the headline in the first analysis as one row and one column. `bj` records that cell as the answer's value.
- Put a breakdown in a second analysis, `<name>_by_<thing>.sql`, and list both under `analyses` in `question.yaml`.
- Convert base units in SQL (wei to ETH, satoshis to BTC, token units by decimals) and name the unit in the column, such as `eth`.

## 5. Run and check

```sh
uv run --project orchestration bj answer <slug>
```

It writes `results/<analysis>.csv` and `answer.json`, and exits 1 when a check fails. [../references/checks.md](../references/checks.md) says what each failure means and what to do. Fix the cause and rerun. Ship an answer with a failed check only when the user agrees, and say so in the answer.

## 6. Write the answer

Write `answers/<slug>/answer.md`:

1. The answer in one sentence, with the number and its unit.
2. How it was counted: the definitions in plain words.
3. The data: chains, blocks or times, and when each input last loaded, from `answer.json`.
4. Caveats: the alternatives that would change the number, and any check that failed.

Copy numbers from `answer.json` and the CSVs; never retype or round them differently. Then give the user the answer in a sentence, link the folder, and offer a report ([report.md](report.md)).
