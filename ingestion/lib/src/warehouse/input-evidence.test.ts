import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { inputEvidence } from "#src/warehouse/input-evidence.ts";
import { pgliteWarehouse } from "#src/warehouse/pglite.fixture.ts";

const source = { name: "test", table: "wallets" };
const files = { files: { "wallets.json": [{ sha256: "file-hash", bytes: 42 }] }, truncated: false };

test("input evidence keeps safe settings and provider identity without credentials or copied lists", () => {
  const url = "https://user:password@provider.example/key-in-path?token=secret";
  const evidence = inputEvidence(source, {
    EVM_RPC_URL: url, api_key: "secret", ACCESS_TOKEN: "secret", password: 123456,
    START_BLOCK: 10, END_BLOCK: 20, BLOCK_NUMBER: "finalized", ENABLED: false,
    ALSO_AT_BLOCKS: Array.from({ length: 10000 }, (_, i) => i),
    custom: { credentials: "secret", wallets: ["private-wallet"] },
  }, files, true);
  assert.deepEqual(evidence.environment.EVM_RPC_URL, {
    origin: "https://provider.example", sha256: createHash("sha256").update(url).digest("hex"),
  });
  assert.deepEqual(evidence.redacted_keys, ["ACCESS_TOKEN", "api_key", "password"]);
  assert.equal(evidence.environment.START_BLOCK, 10);
  assert.equal(evidence.environment.BLOCK_NUMBER, "finalized");
  assert.equal(evidence.environment.ENABLED, false);
  assert.match(JSON.stringify(evidence.environment.ALSO_AT_BLOCKS), /^\{"sha256":"[a-f0-9]{64}"\}$/);
  assert.doesNotMatch(JSON.stringify(evidence), /private-wallet|key-in-path|secret|123456/);
  assert.equal(evidence.complete, true);
  assert.equal(inputEvidence(source, {}, { ...files, truncated: true }, true).complete, false);
});

test("unavailable optional evidence preserves core rows and checkpoints without certifying the run", async (t) => {
  const { db, warehouse } = await pgliteWarehouse(t);
  const table = await warehouse.open("test_wallets");
  table.trackInputs("run", (complete) => inputEvidence(source, {}, files, complete));
  await db.query(`alter table raw._ingestion_inputs add constraint reject_inputs check (run_id <> 'run')`);
  await table.load({ records: [{ id: "a", callId: "a", data: {} }], failed: [],
    checkpoints: [{ key: "page", value: 1 }] });
  await table.finishInputs();
  assert.deepEqual((await db.query("select id from raw.test_wallets")).rows, [{ id: "a" }]);
  assert.equal(await table.getCheckpoint("page"), 1);
  assert.deepEqual((await db.query("select * from raw._ingestion_inputs")).rows, []);
});

test("completion preserves the config hash and different source tables cannot overwrite run evidence", async (t) => {
  const { db, warehouse } = await pgliteWarehouse(t);
  const first = await warehouse.open("test_wallets");
  first.trackInputs("shared-run", (complete) => inputEvidence(source, {}, files, complete));
  await first.load({ records: [], failed: [] });
  const before = (await db.query<{ config_hash: string }>("select config_hash from raw._ingestion_inputs")).rows[0];
  await first.finishInputs();
  const second = await warehouse.open("other_wallets");
  second.trackInputs("shared-run", (complete) => inputEvidence({ name: "other", table: "wallets" }, {}, files, complete));
  await second.finishInputs();
  const { rows } = await db.query<{ source_table: string; config_hash: string; complete: boolean }>(
    "select source_table, config_hash, (evidence->>'complete')::boolean as complete from raw._ingestion_inputs order by source_table");
  assert.equal(rows.length, 2);
  assert.equal(rows[1]?.config_hash, before?.config_hash);
  assert.equal(rows[1]?.complete, true);
  assert.notEqual(rows[0]?.config_hash, rows[1]?.config_hash);
});
