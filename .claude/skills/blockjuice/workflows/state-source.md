# Add a state source

A state source reads values that a view function or RPC method returns at one block. The balances sources are the pattern to follow, for example `ingestion/sources/ethereum-erc20-balances/`.

1. Scaffold from the closest existing source:

   ```sh
   uv run --project orchestration bj new-source <chain> <table> --like <package>
   ```

   It copies the package, renames it, adds the dbt source with a staging stub, and adds the pair to `SOURCES`. Then run `pnpm install` in `ingestion/`.

2. Edit the copied `src/`:
   - Give each call its block number in the `call` zod schema, so a call retried in a later run reads the same block. Turn a tag such as `finalized` into a number once per run with `resolveBlock`.
   - Make calls through `settleCalls`. On EVM, `createChain` merges reads at one block into one Multicall3 call. On Solana, use `createSolanaClient`.
   - A revert at a pinned block is a fact to record as null, not a failure to retry. Copy `balanceAt` in `ethereum-erc20-balances/src/balances.ts`.
   - Reads at past blocks need an archive RPC. Solana serves current state only, so a Solana call has no block, and the record's id takes the slot from the reply.
3. Put the addresses to read in `addresses.json`. Copy `.env.example` to `.env`.
4. Update the copied tests in `src/*.test.ts`. Run `pnpm test` in the package and `pnpm typecheck` in `ingestion/`.
5. Shape the staging model: cast each field out of `data` into its own column, as `stg_ethereum__erc20_balances.sql` does. Add column tests to the folder's `_<chain>__models.yml`.
6. Run it once with `pnpm ingest` in the package. Check that `raw.<chain>_<table>` has rows and that `raw._dead_letters` has none for `<chain>_<table>`.

A source joins a pipeline through a mart that reads it: follow [new-pipeline.md](new-pipeline.md). Until then the orchestration tests fail, because every asset must belong to a scheduled pipeline.
