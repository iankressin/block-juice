# Add or extend a history source

A history source is a Pipes stream source. It reads events over a range of blocks from SQD Portal, and each run resumes after the last block it saved. `ingestion/sources/evm-erc20-transfers/` is the pattern: on each chain in its `chains/`, every Transfer of the tokens in that chain's `addresses.json`, into or out of its wallets when it lists any, from the chain's `START_BLOCK` on.

## What a history source has loaded

```sh
uv run --project orchestration bj coverage <chain>.<table>
```

It prints the effective configuration's `cursor`, current `filter`, committed `verified_ranges` and
recorded `generations`. `covered` is present only for one continuous verified interval. A legacy cursor
without recorded configuration is unverified; a factory source also needs evidenced pool discovery.
See [source provenance](../../../../docs/source-provenance.md) for the complete contract.

## Reuse before you build

When a source already reads the right events:

- The window and required filters are verified: nothing to load.
- The current generation has not reached the window's end: run its pipeline with `bj run <pipeline>`.
  `MAX_BLOCKS_PER_RUN` optionally caps each invocation; without a cap, it reads to the configured end.
- The question needs an earlier start or new addresses: update the source configuration. Its next run
  automatically backfills an independent generation into the existing raw table, preserving old rows,
  cursors and factory caches. Estimate the requested provider work before starting a new large load.
- Legacy history or a lost factory cache needs verification: set a stable `SOURCE_BACKFILL_ID` in root
  `.env` and follow the [nondestructive backfill procedure](../../../../docs/source-provenance.md#nondestructive-backfill).
  Keep that identifier for subsequent runs so they resume the rebuilt generation. No truncation is needed.

## A new history source

1. Find the events in the protocol's catalog entry, `catalog/protocols/<name>/`. With no entry, follow [explore-protocol.md](explore-protocol.md) first.
2. Estimate the load before you build: count the matching logs over a few thousand blocks of the window with the Portal MCP (`portal_evm_query_logs`), scale it, and call it an estimate, since a thin sample can be far off. Put it in front of the user with the definitions, per [answer.md](answer.md). Never write a script to count, and never count the whole window: the estimate exists so the user can decide on the full load.
3. Build one source per protocol version, each with its own raw table, per [../references/layers.md](../references/layers.md). A question over Uniswap v2, v3 and v4 needs three sources: `evm-uniswap-v2`, `evm-uniswap-v3` and `evm-uniswap-v4`. Copy the source closest in shape:

   | Contracts | Copy |
   |---|---|
   | Tokens, for their Transfers | Nothing: add the chain's folder to `evm-erc20-transfers`, as [docs/architecture.md](../../../../docs/architecture.md#add-a-source) describes |
   | A protocol version already loaded on another chain | Nothing: add the chain's folder to its `evm-*` package, and the chain's factory to `src/source.ts`, as [docs/architecture.md](../../../../docs/architecture.md#add-a-source) describes |
   | Known contracts, such as gateways | `arbitrum-token-bridge` |
   | Contracts a factory creates, such as pools | `evm-uniswap-v3` |
   | One contract that names its children by id, such as the v4 PoolManager | `evm-uniswap-v4` |

   ```sh
   uv run --project orchestration bj new-source ethereum pancakeswap_v3 --like evm-uniswap-v3
   ```

   That makes the package `evm-pancakeswap-v3`, with one chain folder, `chains/ethereum/`, and the raw table `raw.ethereum_pancakeswap_v3`. A factory copy changes only the constants at the top of `src/source.ts` (each chain's factory address and deploy block in `FACTORIES`, its creation event, the argument that holds the child's address, the child's event, the two ABI imports), and the events its test encodes. `bj new-source` sets `table` in `src/source.ts` and regenerates `ingestion/sources.json`. `forChain(chain)` names each source for its chain, so there is no export to rename, but the error it throws for a chain missing from `FACTORIES` still names Uniswap.

4. Edit the copied `src/source.ts`. It extracts and loads only, per [../references/layers.md](../references/layers.md): each record is one item as Portal returns it, a log with its ABI-decoded arguments, or a transaction the logs came from, keyed by its hash. Give each record a `kind`, `log` or `transaction`, and never copy a transaction's fields into a log.
   - Read `[START_BLOCK, finalizedHead(portal)]` through `portalClient`, so each run ends at Portal's finalized head and no fork reaches the warehouse. An optional `END_BLOCK` stops a check window short of the head.
   - Key a log by `<block>:<logIndex>` and a transaction by `tx:<hash>`, so a rerun or an overlap writes the same row. Write only the transactions of the logs you write: Portal returns the transactions of every log it matched, including the ones a factory filter drops.
   - One `evmEventDecoder` per filter, since Pipes refuses two filters on the same event in one decoder.
   - For contracts a factory creates, such as Uniswap pools, follow the children with Pipes' factory pattern inside the stream. Never read another source's raw table to find them. A factory source has two start blocks: `POOLS_START_BLOCK` for the creation events, at the token's first pool or the factory's deployment, and `START_BLOCK` for the children's events. Pipes keeps the children it found in `chains/<chain>/factory.sqlite`, which git ignores.
   - Put addresses in `addresses.json`, and set `START_BLOCK` in `.env.example`, both in `chains/<chain>/` for an `evm-*` package, to the window's first block or the contract's deployment block.
   - Leave out sign rules, joins, buy or sell, units and prices. They go in dbt.
5. Cast the fields in staging, one view per raw table and kind of record, per [../references/layers.md](../references/layers.md). Put each version's rules from the catalog's `NOTES.md` in that version's intermediate model, with a dbt unit test per rule built from a proof log. A mart that needs every version unions those models. Add the mart in a pipeline ([new-pipeline.md](new-pipeline.md)), with `unique` and `not_null` tests on the id.
6. When a view function returns the value the events rebuild, add a reconciliation test like `transformation/tests/erc20_transfers_match_balances.sql`. It reads what the source has loaded from `var('coverage')`, which `bj answer` passes, and compares the rebuilt value with state readings inside the loaded blocks.
7. Check it on a short window first, in schemas of its own so no check cursor lands in `raw`. In the package's `.env`, set `RAW_SCHEMA` to a check schema such as `raw_dex_check`. Set `START_BLOCK` and `END_BLOCK` a few thousand blocks apart, in `chains/<chain>/.env` for an `evm-*` package: the chain's settings load first and win over the package's `.env`. Run it, then build its models with the check schemas set in the shell:

   ```sh
   set -a && . ./.env && set +a && cd transformation && RAW_SCHEMA=raw_dex_check DBT_SCHEMA=analytics_dex_check uv run --project ../orchestration dbt build --select +path:models/marts/<pipeline>
   ```

   Compare the rows with a Portal MCP count of the same blocks and filter.
   - A factory source cannot find old children quickly: its creation scan reads every block from `POOLS_START_BLOCK`, which for a token from 2023 takes over a day. Check discovery on a short range around one known creation from the catalog's proof table, check the children's events for the pools the run found, and say what the check does not prove.
   - Tell the user how long the full creation scan will take before starting it.
   - Then put the real schemas and `START_BLOCK` back, load with `bj run <pipeline>`, and check `bj coverage`.

## Use it in an answer

In `question.yaml`, name the source on its input, quote every address, and give the window in blocks:

```yaml
window:
  chain: ethereum
  blocks: [26316189, 26343605]
inputs:
  - name: usdc_flows
    strategy: history
    source: ethereum.erc20_transfers
    filter: {tokens: ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"]}
```

`bj answer` then adds a `coverage` check. After it passes, run the cross-check in [../references/checks.md](../references/checks.md).

## Sandboxed shells

If `pnpm ingest` fails with `listen EPERM`, or Portal calls fail with `ENOTFOUND` behind a proxy, run the source directly in its package with `NODE_USE_ENV_PROXY=1 node --import tsx src/index.ts`. A source run without network access to Portal hangs at "Run started" with no error. Installing `better-sqlite3`, which the factory pattern needs, wants `npm_config_cache` set to a writable folder.
