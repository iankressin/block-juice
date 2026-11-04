import assert from "node:assert/strict";
import { test } from "node:test";
import * as z from "zod";
import { runSource } from "#src/run.ts";
import type { DeadLetter, DeadLetterQueue, Target } from "#src/types.ts";

// loadEnv treats an empty value as unset, so the run pushes no metrics and cannot reach
// ops.ingestion_runs, even when the shell or a .env file points at the warehouse.
process.env.PUSHGATEWAY_URL = "";
process.env.WAREHOUSE_HOST = "";

function memoryTarget() {
  const written: string[] = [];
  const target: Target = {
    open: async () => ({
      name: "memory",
      write: async (records) => {
        written.push(...records.map((r) => r.id));
      },
      close: async () => {},
    }),
  };
  return { target, written };
}

function memoryDeadLetters(letters: DeadLetter[]) {
  const rows = new Map(letters.map((letter) => [letter.id, { ...letter, parked: false }]));
  const queue: DeadLetterQueue = {
    open: async () => ({
      name: "memory",
      pending: async () => [...rows.values()].filter((row) => !row.parked),
      push: async (failed) => {
        for (const { id, call, error } of failed) rows.set(id, { id, call, error, attempts: 1, parked: false });
      },
      park: async (letters) => {
        for (const { id, error } of letters) Object.assign(rows.get(id)!, { error, parked: true });
      },
      resolve: async (ids) => {
        for (const id of ids) rows.delete(id);
      },
      backlog: async () => {
        const all = [...rows.values()];
        return { pending: all.filter((r) => !r.parked).length, parked: all.filter((r) => r.parked).length };
      },
      close: async () => {},
    }),
  };
  return { queue, rows };
}

test("a dead letter whose call no longer parses is parked, and the run goes on without it", async () => {
  const { queue, rows } = memoryDeadLetters([
    { id: "a", call: { wallet: "a" }, error: "timeout", attempts: 1 },
    { id: "b", call: { address: "b" }, error: "timeout", attempts: 2 },
  ]);
  const { target, written } = memoryTarget();
  let retried: unknown[] | undefined;

  await runSource(
    {
      name: "test",
      table: "wallets",
      env: z.object({}),
      call: z.object({ wallet: z.string() }),
      async *extract(_env, retry) {
        retried = retry;
        const calls = [...retry, { wallet: "c" }];
        yield { records: calls.map((c) => ({ id: c.wallet, callId: c.wallet, data: {} })), failed: [] };
      },
    },
    target,
    queue,
  );

  assert.equal(process.exitCode, undefined, "the run succeeded");
  assert.deepEqual(retried, [{ wallet: "a" }]);
  assert.deepEqual(written, ["a", "c"]);
  const [parked, ...others] = rows.values();
  assert.deepEqual(others, [], "the retried letter was resolved");
  assert.deepEqual({ ...parked, error: undefined }, {
    id: "b",
    call: { address: "b" },
    error: undefined,
    attempts: 2,
    parked: true,
  });
  assert.match(parked!.error, /no longer matches the source's call schema.*wallet/s);
});

test("a record clears the dead letter of the call it answers, under its own row id", async () => {
  const { queue, rows } = memoryDeadLetters([
    { id: "W", call: { wallet: "W" }, error: "timeout", attempts: 1 },
  ]);
  const { target, written } = memoryTarget();

  await runSource(
    {
      name: "test",
      table: "wallets",
      env: z.object({}),
      call: z.object({ wallet: z.string() }),
      async *extract(_env, retry) {
        yield {
          records: retry.map((c) => ({ id: `205:${c.wallet}`, callId: c.wallet, data: {} })),
          failed: [],
        };
      },
    },
    target,
    queue,
  );

  assert.equal(process.exitCode, undefined, "the run succeeded");
  assert.deepEqual(written, ["205:W"]);
  assert.deepEqual([...rows.keys()], [], "the dead letter was cleared");
});
