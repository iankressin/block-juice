import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { createChain, resolveBlock } from "#src/evm/contract-state/index.ts";

type Request = { id: number; method: string; params: unknown[] };

/** A JSON-RPC endpoint that answers every block request with block `head`. Returns its URL and the requests it saw. */
async function fakeRpc(t: TestContext, head: number) {
  const requests: Request[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const answer = (request: Request) => {
      requests.push(request);
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: { number: `0x${head.toString(16)}`, hash: `0x${"ab".repeat(32)}`, transactions: [] },
      };
    };
    const request = JSON.parse(body);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(request) ? request.map(answer) : answer(request)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

test("a tag becomes the number of the block it points to now", async (t) => {
  const { url, requests } = await fakeRpc(t, 21_000_000);

  assert.equal(await resolveBlock(createChain(url, { retryCount: 0 }), "finalized"), 21_000_000);
  assert.deepEqual(
    requests.map(({ method, params }) => ({ method, params })),
    [{ method: "eth_getBlockByNumber", params: ["finalized", false] }],
  );
});

test("a block number is kept as it is, with no request", async (t) => {
  const { url, requests } = await fakeRpc(t, 21_000_000);

  assert.equal(await resolveBlock(createChain(url, { retryCount: 0 }), 5), 5);
  assert.deepEqual(requests, []);
});
