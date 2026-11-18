import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { accountsFileSchema, resolveAccounts } from "#src/lighter/accounts.ts";
import { createLighterClient, lighterEnv } from "#src/lighter/client.ts";

const KNOWN = "0x948bD698358dE1c73de0526CA4F592d26986d589";
const UNKNOWN = "0x1111111111111111111111111111111111111111";

async function setup(t: TestContext) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://lighter");
    requests.push(url.pathname + url.search);
    const known = url.searchParams.get("l1_address") === KNOWN;
    const [status, body] = known
      ? [200, { code: 200, l1_address: KNOWN, sub_accounts: [{ index: 1000 }] }]
      : [400, { code: 21100, message: "account not found" }];
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = createLighterClient(lighterEnv.parse({ LIGHTER_API_URL: url, LIGHTER_REQUESTS_PER_MINUTE: "60" }), {
    now: () => Date.now(),
    sleep: async () => {},
  });
  return { client, requests };
}

test("resolveAccounts keeps listed indexes and adds every sub-account of each L1 address, sorted and unique", async (t) => {
  const { client, requests } = await setup(t);
  const file = { accounts: [313004, 1000], l1_addresses: [KNOWN] };
  assert.deepEqual(await resolveAccounts(client, file), [1000, 313004]);
  assert.deepEqual(requests, [`/api/v1/accountsByL1Address?l1_address=${KNOWN}`]);
});

test("resolveAccounts asks for no address when the file lists none", async (t) => {
  const { client, requests } = await setup(t);
  assert.deepEqual(await resolveAccounts(client, { accounts: [5] }), [5]);
  assert.equal(requests.length, 0);
});

test("an L1 address Lighter does not know fails the run, naming it", async (t) => {
  const { client } = await setup(t);
  await assert.rejects(
    resolveAccounts(client, { l1_addresses: [UNKNOWN] }),
    /addresses\.json lists 0x1111111111111111111111111111111111111111, but Lighter has no account for it/,
  );
});

test("accountsFileSchema needs accounts or l1_addresses, each with at least one valid entry", () => {
  assert.equal(accountsFileSchema.safeParse({ accounts: [313004], l1_addresses: [KNOWN] }).success, true);
  const message = (value: unknown) => {
    const result = accountsFileSchema.safeParse(value);
    assert.equal(result.success, false);
    return JSON.stringify(result.error!.issues);
  };
  assert.match(message({}), /lists no accounts and no l1_addresses/);
  assert.match(message({ accounts: [] }), /accounts/);
  assert.match(message({ accounts: [-1] }), /accounts/);
  assert.match(message({ l1_addresses: ["0x12"] }), /l1_addresses/);
});
