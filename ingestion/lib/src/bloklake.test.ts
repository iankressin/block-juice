import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type AbiEvent } from "viem";
import { bloklakeClient, type EventPage } from "#src/bloklake.ts";

type Row = Record<string, string | number | null>;
type Filter = Record<string, string[]>;
type Body = { fromBlock: number; toBlock: number; logs: Filter[]; fields: unknown };

const transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const approval = parseAbiItem("event Approval(address indexed owner, address indexed spender, uint256 value)");
const nftTransfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");

const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WALLET = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const OTHER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const asTopic = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

/** A log as bloklake's JSON rows hold one: snake_case names, hex in lower case, a missing topic null. */
function log(block: number, logIndex: number, address: string, event: AbiEvent, args: Record<string, unknown>): Row {
  const topics = encodeEventTopics({ abi: [event], args } as never) as string[];
  const unindexed = event.inputs.filter((input) => !input.indexed);
  return {
    block_number: block,
    log_index: logIndex,
    transaction_hash: `0x${block.toString(16).padStart(64, "0")}`,
    transaction_index: 0,
    address: address.toLowerCase(),
    topic0: topics[0] ?? null,
    topic1: topics[1] ?? null,
    topic2: topics[2] ?? null,
    topic3: topics[3] ?? null,
    data: encodeAbiParameters(unindexed, unindexed.map((input) => args[input.name!]) as never),
    block_timestamp: 1_700_000_000 + block,
  };
}

/**
 * A local bloklake with `logs` on a chain whose head is `head`. It answers at most `blocksPerPage`
 * blocks a response and filters as the API does: a log matches a filter when each of the filter's
 * fields lists the log's value, and it is returned when it matches any filter. `failures` are sent
 * first, one a request: a status and headers, or "drop" to break the connection.
 */
async function bloklake(
  t: TestContext,
  { logs, head, blocksPerPage = 100, failures = [] }: {
    logs: Row[];
    head: number;
    blocksPerPage?: number;
    failures?: ("drop" | { status: number; headers?: Record<string, string>; code: string })[];
  },
) {
  const requests: { path: string; headers: IncomingHttpHeaders; body?: Body }[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const part of req) text += part;
    const body = text ? (JSON.parse(text) as Body) : undefined;
    requests.push({ path: req.url!, headers: req.headers, body });

    const failure = failures.shift();
    if (failure === "drop") return void req.socket.destroy();
    res.setHeader("content-type", "application/json");
    if (failure) {
      res.writeHead(failure.status, failure.headers);
      return void res.end(JSON.stringify({ error: { code: failure.code, message: "the mock was told to fail" } }));
    }
    if (req.url === "/status") {
      return void res.end(JSON.stringify({ chain_id: 1, first_block: 0, archive_height: head, finalized_block: head - 5 }));
    }
    if (req.url !== "/query/json") {
      res.writeHead(404);
      return void res.end(JSON.stringify({ error: { code: "not_found", message: `no route ${req.url}` } }));
    }

    const { fromBlock, toBlock, logs: filters } = body!;
    const to = Math.min(fromBlock + blocksPerPage - 1, toBlock, head);
    const beyondHead = fromBlock > head;
    const matching = logs.filter(
      (row) =>
        (row.block_number as number) >= fromBlock &&
        (row.block_number as number) <= to &&
        filters.some((filter) => Object.entries(filter).every(([field, values]) => values.includes(row[field] as string))),
    );
    res.end(
      JSON.stringify({
        archive_height: head,
        finalized_block: head - 5,
        from_block: fromBlock,
        to_block: beyondHead ? head : to,
        next_block: beyondHead ? fromBlock : to + 1,
        objects: matching.length,
        to_block_hash: null,
        unavailable_fields: [],
        logs: matching,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

const transferIn = (block: number) => log(block, 0, TOKEN, transfer, { from: OTHER, to: WALLET, value: 1n });

async function collect<T>(pages: AsyncIterable<T>): Promise<T[]> {
  const all: T[] = [];
  for await (const page of pages) all.push(page);
  return all;
}

test("it asks for the next page only when the caller wants one, starting at next_block", async (t) => {
  const { url, requests } = await bloklake(t, { logs: [1, 2, 3, 4, 5].map(transferIn), head: 100, blocksPerPage: 2 });
  const pages = bloklakeClient(url, "bl_live_test").events({ transfers: { event: transfer } }, { from: 1, to: 5 });

  const first = (await pages.next()).value as EventPage<"transfers">;
  assert.equal(first.through, 2);
  assert.deepEqual(first.events.transfers.map((e) => e.blockNumber), [1, 2]);
  assert.equal(requests.length, 1, "the second page is not fetched before the caller asks for it");

  const rest = await collect(pages);
  assert.deepEqual(rest.map((page) => page.through), [4, 5]);
  assert.deepEqual(rest.map((page) => page.events.transfers.map((e) => e.blockNumber)), [[3, 4], [5]]);
  assert.deepEqual(requests.map((r) => [r.body!.fromBlock, r.body!.toBlock]), [[1, 5], [3, 5], [5, 5]]);
});

test("a range past the chain's head ends at the head", async (t) => {
  const { url } = await bloklake(t, { logs: [1, 2, 3].map(transferIn), head: 3, blocksPerPage: 2 });
  const pages = await collect(bloklakeClient(url, "k").events({ transfers: { event: transfer } }, { from: 1, to: 10 }));
  assert.deepEqual(pages.map((page) => page.through), [2, 3]);
});

test("a page with no matching log still reports the blocks it covered", async (t) => {
  const { url } = await bloklake(t, { logs: [], head: 100 });
  const pages = await collect(bloklakeClient(url, "k").events({ transfers: { event: transfer } }, { from: 1, to: 50 }));
  assert.deepEqual(pages, [{ events: { transfers: [] }, through: 50 }]);
});

test("each log is decoded with its event's ABI into the values every provider returns", async (t) => {
  const probe = parseAbiItem(
    "event Probe(address indexed who, bytes32 indexed key, bool flag, uint32 u32, uint48 u48, uint256 u256, int24 i24, string note, address[] list, (address token, uint128 amount)[] pairs)",
  );
  const key = `0x${"ab".repeat(32)}`;
  const args = {
    who: WALLET,
    key,
    flag: true,
    u32: 4_000_000_000,
    u48: 200_000_000_000_000,
    u256: 2n ** 255n,
    i24: -197_250,
    note: "héllo",
    list: [WALLET, OTHER],
    pairs: [{ token: TOKEN, amount: 6n }],
  };
  const { url } = await bloklake(t, { logs: [log(7, 3, TOKEN, probe, args)], head: 100 });

  const [page] = await collect(bloklakeClient(url, "k").events({ probes: { event: probe } }, { from: 1, to: 10 }));

  assert.deepEqual(page!.events.probes, [
    {
      blockNumber: 7,
      timestamp: 1_700_000_007,
      transactionHash: `0x${"7".padStart(64, "0")}`,
      logIndex: 3,
      contract: TOKEN.toLowerCase(),
      args: {
        who: WALLET.toLowerCase(),
        key,
        flag: true,
        u32: 4_000_000_000,
        u48: 200_000_000_000_000n,
        u256: 2n ** 255n,
        i24: -197_250,
        note: "héllo",
        list: [WALLET.toLowerCase(), OTHER.toLowerCase()],
        pairs: [{ token: TOKEN.toLowerCase(), amount: 6n }],
      },
    },
  ]);
});

test("each request becomes one filter, and each log comes back under the request it matches", async (t) => {
  const { url, requests } = await bloklake(t, {
    head: 100,
    logs: [
      log(1, 0, TOKEN, transfer, { from: OTHER, to: WALLET, value: 1n }),
      log(1, 1, TOKEN, transfer, { from: WALLET, to: OTHER, value: 2n }),
      log(2, 0, OTHER, transfer, { from: OTHER, to: WALLET, value: 3n }),
      log(2, 1, TOKEN, approval, { owner: WALLET, spender: OTHER, value: 4n }),
    ],
  });

  const [page] = await collect(
    bloklakeClient(url, "k").events(
      {
        received: { event: transfer, contracts: [TOKEN], where: { to: [WALLET] } },
        approvals: { event: approval },
      },
      { from: 1, to: 10 },
    ),
  );

  const transferTopic = encodeEventTopics({ abi: [transfer] })[0];
  const approvalTopic = encodeEventTopics({ abi: [approval] })[0];
  assert.deepEqual(requests[0]!.body!.logs, [
    { address: [TOKEN.toLowerCase()], topic0: [transferTopic], topic2: [asTopic(WALLET)] },
    { topic0: [approvalTopic] },
  ]);
  assert.deepEqual(page!.events.received.map((e) => e.args.value), [1n]);
  assert.deepEqual(page!.events.approvals.map((e) => e.args.value), [4n]);
});

test("a log that shares the event's signature but indexes other arguments is left out", async (t) => {
  const { url } = await bloklake(t, {
    head: 100,
    logs: [
      log(1, 0, TOKEN, nftTransfer, { from: OTHER, to: WALLET, tokenId: 9n }),
      log(1, 1, TOKEN, transfer, { from: OTHER, to: WALLET, value: 1n }),
    ],
  });
  const [page] = await collect(bloklakeClient(url, "k").events({ transfers: { event: transfer } }, { from: 1, to: 10 }));
  assert.deepEqual(page!.events.transfers.map((e) => e.logIndex), [1]);
});

test("an anonymous event, which has no signature topic, is read from its contract", async (t) => {
  const anonymous = {
    type: "event",
    name: "Deposit",
    anonymous: true,
    inputs: [
      { name: "who", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  } as const satisfies AbiEvent;
  const { url, requests } = await bloklake(t, { head: 100, logs: [log(4, 2, TOKEN, anonymous, { who: WALLET, amount: 9n })] });

  const [page] = await collect(
    bloklakeClient(url, "k").events({ deposits: { event: anonymous, contracts: [TOKEN] } }, { from: 1, to: 10 }),
  );

  assert.deepEqual(requests[0]!.body!.logs, [{ address: [TOKEN.toLowerCase()] }]);
  assert.deepEqual(page!.events.deposits.map((e) => e.args), [{ who: WALLET.toLowerCase(), amount: 9n }]);
});

test("the finalized head comes from /status, and the key goes as a bearer token", async (t) => {
  const { url, requests } = await bloklake(t, { logs: [], head: 100 });
  assert.equal(await bloklakeClient(`${url}/`, "bl_live_test").finalizedHead(), 95);
  assert.equal(requests[0]!.path, "/status");
  assert.equal(requests[0]!.headers.authorization, "Bearer bl_live_test");
});

test("it waits as long as bloklake says and asks again when the rate limit is hit", async (t) => {
  const { url, requests } = await bloklake(t, {
    logs: [transferIn(1)],
    head: 100,
    failures: [{ status: 429, headers: { "retry-after": "0" }, code: "rate_limited" }],
  });
  const startedAt = performance.now();
  const pages = await collect(bloklakeClient(url, "k").events({ transfers: { event: transfer } }, { from: 1, to: 10 }));
  assert.equal(pages[0]!.events.transfers.length, 1);
  assert.equal(requests.length, 2);
  assert.ok(performance.now() - startedAt < 900, "it waited the 0 seconds bloklake asked for, not its own second");
});

test("it asks again when the connection breaks", async (t) => {
  const { url, requests } = await bloklake(t, { logs: [transferIn(1)], head: 100, failures: ["drop"] });
  const pages = await collect(bloklakeClient(url, "k").events({ transfers: { event: transfer } }, { from: 1, to: 10 }));
  assert.equal(pages[0]!.events.transfers.length, 1);
  assert.equal(requests.length, 2);
});

test("a request bloklake refuses fails at once, with bloklake's reason", async (t) => {
  const { url, requests } = await bloklake(t, { logs: [], head: 100, failures: [{ status: 400, code: "invalid_query" }] });
  const pages = bloklakeClient(url, "k").events({ transfers: { event: transfer } }, { from: 1, to: 10 });
  await assert.rejects(collect(pages), /400.*invalid_query/s);
  assert.equal(requests.length, 1);
});
