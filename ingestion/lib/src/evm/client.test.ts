import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { connect, createEvmClient, resolveBlock } from "#src/evm/client.ts";

type Request = { id: number; method: string; params: unknown[] };

/**
 * A JSON-RPC endpoint where every block is block `head` and every balance is 0. Returns its URL,
 * the requests it saw, and the methods each HTTP request carried.
 */
async function fakeRpc(t: TestContext, head: number) {
  const requests: Request[] = [];
  const httpRequests: string[][] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const answer = (request: Request) => {
      requests.push(request);
      const result =
        request.method === "eth_getBalance"
          ? "0x0"
          : { number: `0x${head.toString(16)}`, hash: `0x${"ab".repeat(32)}`, transactions: [] };
      return { jsonrpc: "2.0", id: request.id, result };
    };
    const parsed: Request | Request[] = JSON.parse(body);
    const batch = Array.isArray(parsed) ? parsed : [parsed];
    httpRequests.push(batch.map(({ method }) => method));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, httpRequests };
}

test("a tag becomes the number of the block it points to now", async (t) => {
  const { url, requests } = await fakeRpc(t, 21_000_000);

  assert.equal(await resolveBlock(createEvmClient(url, { retryCount: 0 }), "finalized"), 21_000_000);
  assert.deepEqual(
    requests.map(({ method, params }) => ({ method, params })),
    [{ method: "eth_getBlockByNumber", params: ["finalized", false] }],
  );
});

test("a block number is kept as it is, with no request", async (t) => {
  const { url, requests } = await fakeRpc(t, 21_000_000);

  assert.equal(await resolveBlock(createEvmClient(url, { retryCount: 0 }), 5), 5);
  assert.deepEqual(requests, []);
});

test("connect resolves BLOCK_NUMBER at EVM_RPC_URL and batches RPC_BATCH_SIZE calls per request", async (t) => {
  const { url, requests, httpRequests } = await fakeRpc(t, 21_000_000);

  const { client, block } = await connect({ EVM_RPC_URL: url, RPC_BATCH_SIZE: 2, BLOCK_NUMBER: "safe" });
  const wallets = ["0x01", "0x02", "0x03"].map((n) => `0x${n.slice(2).padStart(40, "0")}` as const);
  await Promise.all(wallets.map((address) => client.getBalance({ address, blockNumber: BigInt(block) })));

  assert.equal(block, 21_000_000);
  assert.deepEqual(requests[0]?.params, ["safe", false]);
  assert.deepEqual(
    httpRequests.slice(1).map((methods) => methods.length).sort(),
    [1, 2],
  );
});
