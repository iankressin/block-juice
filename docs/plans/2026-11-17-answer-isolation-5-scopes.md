# Answer isolation 5: scopes, and a deposit rule that does not depend on the load

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A question that needs other addresses or other blocks from a stream source adds a folder, a scope, in place of editing the address list and start block every other question shares. One mart rule stops depending on what else is loaded.

**Architecture:** A scope is a folder with its own `addresses.json` and, when it needs one, its own `.env.example`. Dagster runs the source once for its standing files and once per scope, with `SOURCE_SCOPE` set. `loadEnv` reads the scope's env files first, and a source that opts in reads its `addresses.json` through one helper. Each scope is then a configuration of its own to the warehouse code that exists, so it gets its own cursor and coverage records with no change there. Records land in the same raw table under the same ids.

**Tech Stack:** TypeScript (`ingestion/lib`, two source packages, `node:test`, PGlite), Python 3 (Dagster asset, `bj coverage`), dbt 1.12 unit tests, pytest.

**Spec:** the contract below. It is step 5 of the answer isolation proposal of 2026-11-17, with its three recommended decisions: a helper each source calls, scopes written by hand, and the deposit rule grouped by token. It needs plan 2, whose first guard makes the coverage check read the question's own filter.

**Baseline:** `main` with plan 2 merged. Tasks 1 and 2 to 4 need nothing from the other plans.

## The contract

1. **The deposit rule.** In `classified_transfers`, an address is a deposit address for a token when every loaded transfer of that token from it went to the addresses of one exchange. The rule groups by chain, token and address, where it grouped by chain and address. Loading a second token can then no longer change the first token's labels. The meaning narrows from "this address only ever deposits" to "this address only ever deposits this token", and the mart's description says so.
2. **A scope** is a folder `<settings>/scopes/<name>/`, where `<settings>` is the folder `ingestion/sources.json` names for the source: `chains/<chain>/` in a package that loads several chains, else the package's folder. `<name>` matches `^[a-z0-9][a-z0-9-]*$`. The folder holds `addresses.json`, and may hold `.env.example` and an ignored `.env`.
3. A scope's env files set what differs from the source's own, in practice `START_BLOCK` and `END_BLOCK`. Everything else comes from the files the source reads today. A scope never sets `PORTAL_URL`: one raw table holds one dataset, and the warehouse refuses a second.
4. `SOURCE_SCOPE=<name>` selects a scope for one run. Only the environment sets it, as with `CHAIN`: a value in a file is dropped.
5. `loadEnv` reads, in order: the environment, the scope's `.env` and `.env.example`, then the files it reads today.
6. `settingsFolder(chain?: string): string`, exported by `@ingestion/lib`, returns `chains/<chain>` or `.`, and that folder's `scopes/<SOURCE_SCOPE>` when the variable is set. It throws when the name is malformed or the scope has no `addresses.json`.
7. A source opts in with one line: it reads `` `${settingsFolder(chain)}/addresses.json` ``. Nothing about a source's inputs moves into `runSource` or the `Source` contract. This plan opts in `evm-wallet-transactions` and `evm-erc20-transfers`.
8. `runSource` fails a stream run that has `SOURCE_SCOPE` set and read no JSON file under `scopes/<name>/`. A source that did not opt in would otherwise load its standing addresses from the scope's start block and record them as the scope.
9. One materialization of an ingestion asset runs the standing configuration, then each scope in name order, one process each. The standing run never sees `SOURCE_SCOPE`. The first run that fails fails the asset and names its scope.
10. `bj coverage` lists each scope of a source under `scopes`: its name, start block, the file that sets it, its cursor and its filter.
11. `bj answer`'s coverage check does not change. It already searches every recorded configuration for one whose filter and blocks hold the question's.
12. A person writes the scope folder. The question's `filter` repeats the addresses it needs, and the coverage check proves they are inside what some scope loaded.

Not in this plan, and why:

- **Splitting the lists that exist.** `evm-wallet-transactions` on Ethereum holds 632 wallets from three questions. Moving them to three scopes starts three loads on the maintainer's warehouse, and the standing list needs a decision: the source refuses an empty one. The records of today's configuration keep proving the three shipped answers either way.
- **`bj` writing a scope from `question.yaml`.** By hand first.
- **A source with scopes and no standing configuration.** It follows from the split above.

Costs, known before building:

- Two scopes that overlap read the same blocks twice.
- A source with many open scopes runs many streams in one materialization.
- Nothing on the ingestion side was run before this plan. The design rests on reading `env.ts`, `provenance.ts`, `run/index.ts` and `coverage.py`.

## Global Constraints

- Use the terms in `GLOSSARY.md`: source, record, run, coverage, history. Never "job" for a run. "Scope" already names the factory's scope run and `window.scope`, so the glossary entry this plan adds is **Load scope**.
- The repo is public. No hosts, keys, private URLs or client names in code, docs or commits. Test addresses are made up or already in the repo.
- Commits: one imperative sentence in sentence case, no type prefix. Keep the `Co-Authored-By:` trailer. No session link.
- Node 24. If `node --version` shows another major, prefix Node commands with `mise exec --`.
- Ingestion checks: `pnpm -C ingestion typecheck`, and `pnpm -C ingestion --filter @ingestion/<package> test` for each package changed. One lib file: `pnpm -C ingestion/lib exec tsx --test src/<file>.test.ts`. A PGlite test can crash V8 at exit: rerun it once before treating it as a failure.
- Put a limit on all work, as a named constant with its unit.
- Grow the types `ingestion/lib` owns before adding a layer. No change to the `Source` or `StreamSource` interfaces.
- Load real data only through `bj run`, outside a sandbox, over a few thousand blocks.

## Review Focus

1. `SOURCE_SCOPE` left set in the shell that starts Dagster. The standing run would load a scope and record it as the standing configuration. Pinned by `test_each_scope_runs_after_the_standing_configuration_with_its_name_in_the_environment`.
2. A scope folder in a source that did not opt in. Pinned by the run test of Task 3, `a scope run that read no scope file fails`.
3. A scope name with a space, a slash or `..`. It reaches a path and an env var. Pinned by `settingsFolder refuses a malformed scope name` and `test_a_scope_name_that_is_not_a_slug_is_bad_input`.
4. A scope with no `.env.example`. It inherits the source's `START_BLOCK` and runs to the head. Pinned by `test_each_scope_is_read_as_a_configuration_of_its_own`, whose second scope has none.
5. A question whose window is covered by a scope's record and not by the standing one. The check must pass with no change to it. Pinned by `test_a_scopes_record_proves_an_answer_the_standing_file_never_could`.
6. A deposit address that handles two tokens. Its label for one must not move when the other loads. Pinned by the changed row `1:3` of the unit test in Task 1.

## File structure

| File | Change |
|---|---|
| `transformation/models/marts/transfers/classified_transfers.sql`, `_transfers__models.yml` | The deposit rule by token, its description and unit test. |
| `ingestion/lib/src/env.ts`, `index.ts` | `settingsFolder`, scope files in `loadEnv`. |
| `ingestion/lib/src/run/index.ts` | The guard of contract item 8. |
| `ingestion/sources/evm-wallet-transactions/src/source.ts`, `evm-erc20-transfers/src/source.ts` | One line each. |
| `orchestration/pipeline/sources.py` | `SourceEntry.scopes`. |
| `orchestration/pipeline/assets/ingestion.py` | One run per configuration. |
| `orchestration/pipeline/cli/coverage.py` | `ScopeCoverage`, `configuration`, scope files in `start_block`. |
| `infra/postgres/ops.sql` | `ops.pipeline_runs` counts sources, not source runs. |
| Docs | `ingestion/CLAUDE.md`, `GLOSSARY.md`, `docs/source-provenance.md`, the skill's history-source workflow and layers reference. |

---

### Task 1: Group the deposit rule by token

It needs nothing else in this plan and can ship alone.

**Files:**
- Modify: `transformation/models/marts/transfers/classified_transfers.sql:4-8,24-33,52-53`
- Modify: `transformation/models/marts/transfers/_transfers__models.yml:56,86-92,118`

- [ ] **Step 1: Change the unit test**

In `a_deposit_address_sends_only_to_one_exchange`, `0xd2` sends token `0xt1` only to Binance and token `0xt2` to an EOA. Under the new rule it is a Binance deposit address for `0xt1`. The expected row for `1:3` becomes:

```yaml
        - {chain: arbitrum, id: "1:3", from_kind: deposit, from_entity: Binance, from_group: exchange, to_kind: exchange, to_entity: Binance, to_group: exchange, category: exchange}
```

Row `1:4`, the `0xt2` transfer, stays `unknown`. In the description, the sentence on `0xd2` becomes: `0xd2 sends one token only to Binance and another to an EOA, so it is a Binance deposit address for the first token alone.`

- [ ] **Step 2: Run it and see it fail**

With a warehouse up:

```bash
set -a && . ./.env && set +a && uv run --project orchestration dbt test --project-dir transformation --profiles-dir transformation --select "classified_transfers,test_type:unit"
```

Expected: FAIL on row `1:3`, which still comes back `unknown`. Without a warehouse, run `dbt parse` and go on: Step 4 needs one.

- [ ] **Step 3: Change the model**

`deposits` selects and groups by `t.chain, t.token, t.from_address`. The two joins to it in `sides` add `and fd.token = t.token` and `and td.token = t.token`. The header comment's lines on `deposit` say: an address that is no exchange yet sent every transfer it made of this token on its chain to the addresses of one exchange. In the yml, give `classified_transfers` a `description` with the same sentence and one more: a token-filtered load never holds every transfer of an address, so the rule is per token.

- [ ] **Step 4: Run it and build the mart**

Run the Step 2 command. Expected: PASS. Then `uv run --project orchestration bj run transfers --select classified_transfers`. Expected: success. Each chain holds one token today, so no shipped answer moves. To confirm, run `bj answer token-categories` before and after and compare `answers/token-categories/results/` with `diff -r`.

- [ ] **Step 5: Commit**

```bash
git add transformation/models/marts/transfers
git commit -m "Label a deposit address for each token on its own"
```

---

### Task 2: `settingsFolder`, and a scope's env files

**Files:**
- Modify: `ingestion/lib/src/env.ts:6-19`, `ingestion/lib/src/index.ts:3`
- Test: `ingestion/lib/src/env.test.ts`

**Interfaces:**
- Produces: `settingsFolder(chain?: string): string` in `env.ts`, exported from `index.ts`. Errors: `SOURCE_SCOPE must be a scope name such as mexc-2026-11, not <value>` and `SOURCE_SCOPE=<name>: <folder>/addresses.json does not exist`.
- Changes: `loadEnv` puts `<settings>/scopes/<SOURCE_SCOPE>/.env` and `.env.example` first in its file list when the variable is set, and deletes a `SOURCE_SCOPE` that a file set.

- [ ] **Step 1: Write the failing tests**

In `env.test.ts`, add `"SOURCE_SCOPE"` to `KEYS`, import `settingsFolder`, and add:

```ts
const scoped = {
  ...files,
  "chains/base/scopes/mexc-2026-11/.env.example": "ENV_TEST_A=scope-example\nENV_TEST_B=scope-example\n",
  "chains/base/scopes/mexc-2026-11/.env": "ENV_TEST_A=scope\n",
  "chains/base/scopes/mexc-2026-11/addresses.json": "{}",
  "chains/base/scopes/empty/.env.example": "ENV_TEST_A=empty\n",
};

test("a scope's files come before the chain's", async (t) => {
  const env = loadFrom(t, await packageWith(t, scoped), { CHAIN: "base", SOURCE_SCOPE: "mexc-2026-11" });
  assert.equal(env.ENV_TEST_A, "scope", "the scope's .env");
  assert.equal(env.ENV_TEST_B, "scope-example", "the scope's .env.example");
  assert.equal(env.ENV_TEST_D, "example", "the chain's .env.example");
  assert.equal(env.ENV_TEST_C, "package", "the package's .env");
});

test("without SOURCE_SCOPE no scope file is read, and a file cannot set it", async (t) => {
  const dir = await packageWith(t, { ...scoped, ".env": files[".env"] + "SOURCE_SCOPE=mexc-2026-11\n" });
  const env = loadFrom(t, dir, { CHAIN: "base" });
  assert.equal(env.ENV_TEST_A, "chain");
  assert.equal(env.SOURCE_SCOPE, undefined);
  assert.equal(process.env.SOURCE_SCOPE, undefined);
});

test("settingsFolder names the chain's folder, or the scope's inside it", async (t) => {
  loadFrom(t, await packageWith(t, scoped), { CHAIN: "base" });
  assert.equal(settingsFolder("base"), "chains/base");
  assert.equal(settingsFolder(), ".");
  process.env.SOURCE_SCOPE = "mexc-2026-11";
  assert.equal(settingsFolder("base"), "chains/base/scopes/mexc-2026-11");
});

test("settingsFolder refuses a malformed scope name", async (t) => {
  loadFrom(t, await packageWith(t, scoped), { CHAIN: "base" });
  for (const name of ["../base", "MEXC 2026", "a/b"]) {
    process.env.SOURCE_SCOPE = name;
    assert.throws(() => settingsFolder("base"), /SOURCE_SCOPE must be a scope name/);
  }
});

test("settingsFolder refuses a scope with no addresses.json", async (t) => {
  loadFrom(t, await packageWith(t, scoped), { CHAIN: "base" });
  process.env.SOURCE_SCOPE = "empty";
  assert.throws(() => settingsFolder("base"), /SOURCE_SCOPE=empty: chains\/base\/scopes\/empty\/addresses.json does not exist/);
});
```

`loadFrom` restores every key in `KEYS` after each test, so `SOURCE_SCOPE` does not leak.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm -C ingestion/lib exec tsx --test src/env.test.ts`
Expected: FAIL, `settingsFolder` is not exported.

- [ ] **Step 3: Implement**

`loadEnv` builds its file list from `settingsFolder`'s rule without calling it, since a missing scope folder is the helper's error to raise and dotenv skips a missing file. Update the comment above `loadEnv` with the new order.

- [ ] **Step 4: Run the checks and commit**

Run: `pnpm -C ingestion/lib exec tsx --test src/env.test.ts && pnpm -C ingestion typecheck`
Expected: PASS.

```bash
git add ingestion/lib/src/env.ts ingestion/lib/src/env.test.ts ingestion/lib/src/index.ts
git commit -m "Read a scope's env files before the source's"
```

---

### Task 3: A scope run must read its scope

**Files:**
- Modify: `ingestion/lib/src/run/index.ts:113-117`
- Test: `ingestion/lib/src/run/run.test.ts`, `ingestion/lib/src/warehouse/provenance.test.ts`

**Interfaces:**
- Consumes: `inputs`, the JSON reads `captureJsonReads` collects, keyed by the path each `readJson` call was given.
- Produces: after `source.stream(env)` returns, a run with `SOURCE_SCOPE` set throws `SOURCE_SCOPE=<name> is set, but <source>.<table> read no file in scopes/<name>/: read addresses.json through settingsFolder()` unless some key of `inputs` contains `scopes/<name>/`.

- [ ] **Step 1: Write the tests**

In `provenance.test.ts`, with the file's own source and env fixtures, pin what makes scopes need no warehouse change:

```ts
test("a scope's addresses.json is the filter its configuration records", () => {
  const standing = streamProvenance(source, env, { "chains/ethereum/addresses.json": { wallets: ["0xAA", "0xBB"] } });
  const scope = streamProvenance(source, { ...env, START_BLOCK: 40 },
    { "chains/ethereum/scopes/mexc-2026-11/addresses.json": { wallets: ["0xBB"] } });
  assert.deepEqual(scope?.filter, { wallets: ["0xbb"] });
  assert.equal(scope?.startBlock, 40);
  assert.notEqual(fingerprint(scope), fingerprint(standing), "so it gets a cursor of its own");
});
```

Expected: this passes before any change. Use a `source` whose `coverage.filters` holds `wallets` and an `env` with a numeric `START_BLOCK` and a `PORTAL_URL`, as the file's other tests build them.

In `run.test.ts`, beside `an invalid environment fails the run, and the run log says why`, add `a scope run that read no scope file fails`: run a stream source whose `stream` reads no JSON with `SOURCE_SCOPE=mexc-2026-11` set, and assert `process.exitCode` is 1 and the run log's error contains `read no file in scopes/mexc-2026-11/`. Add `a scope run that read its scope's file loads`: the same source, whose `stream` first calls `readJson` on a temp file at `scopes/mexc-2026-11/addresses.json`, ends with no exit code. Reset `process.exitCode` and delete `process.env.SOURCE_SCOPE` in `t.after`, as the file's failing-run tests reset the exit code.

- [ ] **Step 2: Run them and see the first run test fail**

Run: `pnpm -C ingestion/lib exec tsx --test src/run/run.test.ts src/warehouse/provenance.test.ts`
Expected: the provenance test passes, and `a scope run that read no scope file fails` fails because the run succeeds.

- [ ] **Step 3: Add the guard**

In `run/index.ts`, between `const stream = await source.stream(env);` and `streamProvenance(...)`. A call source is not checked: it has no cursor to mislabel.

- [ ] **Step 4: Run the checks and commit**

Run: `pnpm -C ingestion --filter @ingestion/lib test && pnpm -C ingestion typecheck`
Expected: PASS.

```bash
git add ingestion/lib/src/run ingestion/lib/src/warehouse/provenance.test.ts
git commit -m "Fail a scope run that did not read its scope"
```

---

### Task 4: Two sources read their scope

**Files:**
- Modify: `ingestion/sources/evm-wallet-transactions/src/source.ts:111-115`, `ingestion/sources/evm-erc20-transfers/src/source.ts:71-76`
- Test: `ingestion/sources/evm-wallet-transactions/src/source.test.ts`, `ingestion/sources/evm-erc20-transfers/src/source.test.ts`

**Interfaces:**
- Consumes: `settingsFolder` from `@ingestion/lib` (Task 2).

- [ ] **Step 1: Write the failing test for wallet transactions**

In `evm-wallet-transactions/src/source.test.ts` (import `mkdir`, `mkdtemp`, `rm`, `writeFile` from `node:fs/promises`, `tmpdir` from `node:os`, `join` from `node:path`):

```ts
test("with SOURCE_SCOPE the stream reads the scope's wallets", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "scope-"));
  const cwd = process.cwd();
  t.after(async () => {
    process.chdir(cwd);
    delete process.env.SOURCE_SCOPE;
    await rm(dir, { recursive: true });
  });
  await mkdir(join(dir, "chains/ethereum/scopes/one-wallet"), { recursive: true });
  await writeFile(join(dir, "chains/ethereum/addresses.json"), JSON.stringify({ wallets: [wallet, other] }));
  await writeFile(join(dir, "chains/ethereum/scopes/one-wallet/addresses.json"), JSON.stringify({ wallets: [other] }));
  const url = await portal(t, txs);
  process.chdir(dir);
  process.env.SOURCE_SCOPE = "one-wallet";

  const read = await records(url, 1);
  assert.deepEqual(read.map((r) => r.block_number), [2, 3, 5], "block 1 touches only the wallet the scope leaves out");
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm -C ingestion --filter @ingestion/evm-wallet-transactions test`
Expected: FAIL, the blocks are `[1, 2, 3, 5]`.

- [ ] **Step 3: Opt in**

In `source.ts`, `const path = `chains/${chain}/addresses.json`;` becomes `` const path = `${settingsFolder(chain)}/addresses.json`; ``. Extend the doc comment above `forChain`: a scope in `chains/<chain>/scopes/<name>/` has its own list.

- [ ] **Step 4: Do the same for ERC-20 transfers**

In `evm-erc20-transfers/src/source.test.ts`, add `with SOURCE_SCOPE the stream reads the scope's tokens`, built like the test above with that file's own Portal and record helpers: the standing file lists two tokens, the scope lists one, and only that token's transfers become records. See it fail, then change `readJson(`chains/${chain}/addresses.json`)` and the error message two lines below it to use `settingsFolder(chain)`.

- [ ] **Step 5: Run the checks and commit**

Run: `pnpm -C ingestion --filter @ingestion/evm-wallet-transactions test && pnpm -C ingestion --filter @ingestion/evm-erc20-transfers test && pnpm -C ingestion typecheck`
Expected: PASS. Then `pnpm -C ingestion generate-sources` and `git diff --stat ingestion/sources.json`. Expected: no change, since a scope adds no source.

```bash
git add ingestion/sources/evm-wallet-transactions ingestion/sources/evm-erc20-transfers
git commit -m "Let two stream sources load a scope"
```

---

### Task 5: Dagster runs each scope

**Files:**
- Modify: `orchestration/pipeline/sources.py:17-29`, `orchestration/pipeline/assets/ingestion.py:18-28,130-157`, `infra/postgres/ops.sql:78-79`
- Test: `orchestration/tests/test_sources_json.py`, `orchestration/tests/test_ingestion_process.py`

**Interfaces:**
- Produces: `SourceEntry.scopes(self, repo_root: Path) -> list[str]`. The sorted names of the folders in `self.folder(repo_root) / "scopes"` that hold `addresses.json`. `BadInput(f"scope name {name!r} in {folder} must match {SCOPE.pattern}")` for any other name on such a folder. `SCOPE = re.compile(r"^[a-z0-9][a-z0-9-]*$")` in `sources.py`.
- Produces: `ingest_configurations(scopes: Sequence[str], environment: Mapping[str, str]) -> list[tuple[str | None, dict[str, str]]]` in `assets/ingestion.py`. The standing configuration first, as `None` with `SOURCE_SCOPE` removed, then each scope with it set.

- [ ] **Step 1: Write the failing tests**

In `test_sources_json.py` (import `SourceEntry`):

```python
WALLETS = SourceEntry("ethereum", "wallet_transactions", "evm-wallet-transactions", "chains/ethereum")


def add_scope(root, name):
    folder = WALLETS.folder(root) / "scopes" / name
    folder.mkdir(parents=True)
    (folder / "addresses.json").write_text("{}")


def test_a_scope_is_a_folder_with_an_addresses_json(tmp_path):
    for name in ("mexc-2026-11", "binance-hack"):
        add_scope(tmp_path, name)
    (WALLETS.folder(tmp_path) / "scopes" / "notes").mkdir()
    (WALLETS.folder(tmp_path) / "scopes" / "README.md").write_text("")
    assert WALLETS.scopes(tmp_path) == ["binance-hack", "mexc-2026-11"]
    assert SourceEntry("ethereum", "eth_balances", "evm-eth-balances", "chains/ethereum").scopes(tmp_path) == []


def test_a_scope_name_that_is_not_a_slug_is_bad_input(tmp_path):
    add_scope(tmp_path, "MEXC 2026")
    with pytest.raises(BadInput, match="scope name 'MEXC 2026'"):
        WALLETS.scopes(tmp_path)
```

In `test_ingestion_process.py`:

```python
def test_each_scope_runs_after_the_standing_configuration_with_its_name_in_the_environment():
    environment = {"CHAIN": "ethereum", "SOURCE_SCOPE": "left-in-the-shell"}
    assert ingestion.ingest_configurations(["binance-hack", "mexc-2026-11"], environment) == [
        (None, {"CHAIN": "ethereum"}),
        ("binance-hack", {"CHAIN": "ethereum", "SOURCE_SCOPE": "binance-hack"}),
        ("mexc-2026-11", {"CHAIN": "ethereum", "SOURCE_SCOPE": "mexc-2026-11"}),
    ]
    assert environment["SOURCE_SCOPE"] == "left-in-the-shell", "the caller's environment is not changed"
```

- [ ] **Step 2: Run them and see them fail**

Run: `uv run --project orchestration pytest orchestration/tests/test_sources_json.py orchestration/tests/test_ingestion_process.py -q -k scope`
Expected: FAIL with `'SourceEntry' object has no attribute 'scopes'`.

- [ ] **Step 3: Implement**

Add the two functions. In `_ingest`, read the entry's scopes when the asset runs, so a new folder needs no reload, and loop over `ingest_configurations(scopes, {**os.environ, "DAGSTER_RUN_ID": context.run_id, "CHAIN": source})` inside the one `warehouse_slot`. On a non-zero exit, raise the `dg.Failure` of today, with ` in scope <name>` after the exit code when the run had one, and run no further scope. Log one line before each run that names its scope.

- [ ] **Step 4: Count sources, not source runs, in the run log view**

One Dagster run now writes one `ops.ingestion_runs` row per scope. In `infra/postgres/ops.sql`, the `ingestion` part of `ops.pipeline_runs` counts rows as sources. Lines 78-79 become:

```sql
    count(DISTINCT (source, table_name)) AS sources,
    count(DISTINCT (source, table_name)) FILTER (WHERE NOT succeeded) AS sources_failed,
```

`records_written` and `failed_calls` stay sums: each scope's run wrote its own.

- [ ] **Step 5: Run the checks and commit**

Run: `uv run --project orchestration pytest orchestration/tests/test_sources_json.py orchestration/tests/test_ingestion_process.py orchestration/tests/test_definitions.py orchestration/tests/test_run_log.py -q`
Expected: PASS.

```bash
git add orchestration/pipeline/sources.py orchestration/pipeline/assets/ingestion.py orchestration/tests infra/postgres/ops.sql
git commit -m "Run a stream source once for each of its scopes"
```

---

### Task 6: `bj coverage` lists each scope

**Files:**
- Modify: `orchestration/pipeline/cli/coverage.py:37-52,146-160,187-205,256-304`, `orchestration/pipeline/cli/__init__.py:169-176`
- Test: `orchestration/tests/test_cli_coverage.py`

**Interfaces:**
- Consumes: `SourceEntry.scopes` (Task 5).
- Produces:

  ```python
  @dataclass(frozen=True)
  class ScopeCoverage:
      name: str
      start_block: int
      start_block_file: str
      cursor: int | None
      filter: dict[str, list[str]]
  ```

  `Coverage.scopes: tuple[ScopeCoverage, ...] = ()`, the last field. `Coverage.to_json()` gains `"scopes"`, a list of these as maps, only when the source has any.
- Changes: `start_block(repo_root, folder, scope: Path | None = None)`. With `scope`, the scope's `.env` and `.env.example` come after the environment and before the files of today.
- Produces: `configuration(repo_root: Path, entry: SourceEntry, scope: str | None = None) -> tuple[dict, int, str, dict[str, list[str]]]`: the config ingestion would record, the start block, the file that sets it, and the filter as its `addresses.json` writes it. It holds what lines 264 and 270-296 of `read()` do today, reading the scope's folder for `addresses.json` and the scope's env files first when `scope` is given. `read()` calls it once for the standing files and once per scope.

- [ ] **Step 1: Write the tests**

In `test_cli_coverage.py` (import `ScopeCoverage`):

```python
def add_scope(repo, name, addresses, env=None):
    folder = repo / "ingestion/sources/evm-erc20-transfers/chains/ethereum/scopes" / name
    folder.mkdir(parents=True)
    (folder / "addresses.json").write_text(json.dumps(addresses))
    if env is not None:
        (folder / ".env.example").write_text(env)


def test_each_scope_is_read_as_a_configuration_of_its_own(repo, monkeypatch):
    add_scope(repo, "mexc-2026-11", {"tokens": [USDC], "wallets": [WALLET]}, "START_BLOCK=40\nEND_BLOCK=90\n")
    add_scope(repo, "uni-only", {"tokens": [UNI]})
    monkeypatch.setattr(coverage, "read_cursor", lambda source_table: 180)
    cursors = {(100, ("tokens", "wallets")): 180, (40, ("tokens", "wallets")): 90, (100, ("tokens",)): 60}
    monkeypatch.setattr(coverage, "read_configuration_cursor",
                        lambda source_table, config: (True, cursors[config["startBlock"], tuple(sorted(config["filter"]))]))
    read = coverage.read(repo, "ethereum.erc20_transfers")
    folder = "ingestion/sources/evm-erc20-transfers/chains/ethereum"
    assert read.cursor == 180
    assert read.scopes == (
        ScopeCoverage("mexc-2026-11", 40, f"{folder}/scopes/mexc-2026-11/.env.example", 90, {"tokens": [USDC], "wallets": [WALLET]}),
        ScopeCoverage("uni-only", 100, f"{folder}/.env.example", 60, {"tokens": [UNI]}),
    )
    assert [scope["name"] for scope in read.to_json()["scopes"]] == ["mexc-2026-11", "uni-only"]


def test_a_source_without_scopes_prints_what_it_printed_before(repo, monkeypatch, capsys):
    assert "scopes" not in coverage_json(repo, monkeypatch, capsys, 180)[0]


def test_a_scopes_record_proves_an_answer_the_standing_file_never_could():
    standing = evidence(100, 180)
    scope = evidence(40, 90, {"tokens": [UNI.lower()], "wallets": [WALLET.lower()]})
    read = replace(loaded(), evidence=(standing, scope), dataset_hash="dataset")
    assert read.gaps((40, 90), {"tokens": [UNI], "wallets": [WALLET]}) == []
    assert read.gaps((40, 120), {"tokens": [UNI], "wallets": [WALLET]})
```

- [ ] **Step 2: Run them**

Run: `uv run --project orchestration pytest orchestration/tests/test_cli_coverage.py -q -k scope`
Expected: the first fails with `cannot import name 'ScopeCoverage'`. The last passes already: it pins contract item 11.

- [ ] **Step 3: Implement**

Move the body of `read()` that builds `expected` into `configuration`, and keep `read()`'s result for a source with no scopes exactly as it is. A scope's cursor is `None` when `read_configuration_cursor` reports the source untracked or the configuration unknown.

- [ ] **Step 4: Run the checks and commit**

Run: `uv run --project orchestration pytest orchestration/tests/test_cli_coverage.py orchestration/tests/test_cli_answer.py -q`
Expected: PASS. Add one sentence on `scopes` to the description of the `coverage` command in `cli/__init__.py`.

```bash
git add orchestration/pipeline/cli orchestration/tests/test_cli_coverage.py
git commit -m "List each scope in bj coverage"
```

---

### Task 7: Prove it on a short window, and write it down

**Files:**
- Docs: `ingestion/CLAUDE.md`, `GLOSSARY.md`, `docs/source-provenance.md`, `.claude/skills/blockjuice/workflows/history-source.md`, `.claude/skills/blockjuice/references/layers.md`, `.claude/skills/blockjuice/workflows/answer.md`

- [ ] **Step 1: Load one scope for real**

With the stack up and outside a sandbox, make a scope the maintainer's checkout does not track:

```bash
mkdir -p ingestion/sources/evm-wallet-transactions/chains/ethereum/scopes/trial
printf '{"wallets": ["0x5cbc6299fab3320e7758ac97fd4ca45e5b722059"]}\n' > ingestion/sources/evm-wallet-transactions/chains/ethereum/scopes/trial/addresses.json
printf 'START_BLOCK=26380784\nEND_BLOCK=26383784\n' > ingestion/sources/evm-wallet-transactions/chains/ethereum/scopes/trial/.env.example
uv run --project orchestration bj run accounts --select ethereum/wallet_transactions
uv run --project orchestration bj coverage ethereum.wallet_transactions
```

Expected: the run logs two ingestion runs, the standing one and `trial`. `bj coverage` lists `trial` with `start_block` 26380784 and `cursor` 26383784, and the source's own `cursor` is where the standing run left it. Run the `bj run` line again. Expected: the `trial` run starts at its cursor and writes no record. Then delete the `trial` folder. Its records and its coverage rows stay in the warehouse, which is harmless: they are a subset of what the standing list loaded.

Put the three outputs in the PR text.

- [ ] **Step 2: Write the docs**

- `GLOSSARY.md`: add **Load scope**: one set of addresses and blocks a stream source loads beside its standing ones, in `scopes/<name>/` of the source's settings folder, with a cursor and coverage records of its own. Avoid: configuration, backfill.
- `ingestion/CLAUDE.md`: the layout of contract item 2, the env order of item 5, and the one line a source needs to opt in.
- `docs/source-provenance.md`: a scope is one more configuration, and the records of an old configuration keep proving old answers.
- `.claude/skills/blockjuice/workflows/history-source.md` and `workflows/answer.md`: a question that needs other addresses or an earlier start from a source that has opted in adds a scope folder and never edits the source's `addresses.json` or `.env.example`. Set `END_BLOCK` for a dated question, so its load closes.
- `.claude/skills/blockjuice/references/layers.md`: one sentence, under sources.

- [ ] **Step 3: Commit**

```bash
git add GLOSSARY.md ingestion/CLAUDE.md docs/source-provenance.md .claude/skills/blockjuice
git commit -m "Document load scopes"
```

---

## Left for the maintainer

Moving the 632 wallets of `evm-wallet-transactions` into three scopes, as the proposal drew it, is one PR once two things are decided: what the standing list keeps, and whether a source may run with scopes alone. Each new scope then loads its own window again, on its own cursor.
