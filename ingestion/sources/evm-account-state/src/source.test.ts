import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { createEvmClient } from "@ingestion/lib/evm";
import { forChain, fetchState, stateCallsAt } from "#src/source.ts";

const contract = "0x00000000000000000000000000000000000000aa";
const wallet = "0x00000000000000000000000000000000000000bb";
const flaky = "0x00000000000000000000000000000000000000cc";
const CODE = "0x6080604052";

type Request = { id: number; method: string; params: [string, string] };

const reply = ({ method, params: [address] }: Request) => {
  if (method === "eth_getBalance") return address === wallet ? "0x1000000000000000000" : "0x0"; // 2^72 wei
  if (method === "eth_getTransactionCount") return address === wallet ? "0x2" : "0x1";
  return address === contract ? CODE : "0x";
};

/** A local JSON-RPC node: `contract` has code, `wallet` has a balance and nonce 2, `flaky` fails every read. */
async function node(t: TestContext) {
  const asked: Request[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body) as Request | Request[];
      const requests = Array.isArray(parsed) ? parsed : [parsed];
      asked.push(...requests);
      const replies = requests.map((r) =>
        r.params[0] === flaky
          ? { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: "header not found" } }
          : { jsonrpc: "2.0", id: r.id, result: reply(r) },
      );
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked };
}

test("each address's balance, nonce and code are recorded at the call's block", async (t) => {
  const { url, asked } = await node(t);
  const client = createEvmClient(url, { retryCount: 0 });
  const batch = await fetchState(client, stateCallsAt(120, [contract, wallet, flaky]));

  assert.deepEqual(
    batch.records.map(({ id, data }) => ({ id, ...data })),
    [
      { id: `120:balance:${contract}`, kind: "balance", block_number: 120, address: contract, balance: 0n },
      { id: `120:nonce:${contract}`, kind: "nonce", block_number: 120, address: contract, nonce: 1 },
      { id: `120:code:${contract}`, kind: "code", block_number: 120, address: contract, code: CODE },
      { id: `120:balance:${wallet}`, kind: "balance", block_number: 120, address: wallet, balance: 2n ** 72n },
      { id: `120:nonce:${wallet}`, kind: "nonce", block_number: 120, address: wallet, nonce: 2 },
      { id: `120:code:${wallet}`, kind: "code", block_number: 120, address: wallet, code: "0x" },
    ],
  );
  assert.deepEqual(
    batch.failed.map((f) => f.id),
    [`120:balance:${flaky}`, `120:nonce:${flaky}`, `120:code:${flaky}`],
    "a failed read waits for the next run",
  );
  assert.ok(asked.every((r) => r.params[1] === "0x78"), "every read is pinned to block 120");
});

test("each chain loads into a table of its own", () => {
  assert.equal(forChain("ethereum").name, "ethereum", "runSource writes to raw.ethereum_account_state");
  assert.equal(forChain("ethereum").table, "account_state");
  assert.throws(() => forChain("Ethereum Mainnet"), /chain name/);
});

test("ALSO_AT_BLOCKS takes block numbers separated by commas", () => {
  const parse = (v: string) =>
    forChain("ethereum").env.safeParse({ BLOCK_NUMBER: "finalized", EVM_RPC_URL: "http://x", ALSO_AT_BLOCKS: v });
  assert.deepEqual(parse("26294680,26316188").data?.ALSO_AT_BLOCKS, [26294680, 26316188]);
  assert.equal(parse("latest").success, false);
});
