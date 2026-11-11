import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type AbiEvent } from "viem";
import { defineAbi } from "@subsquid/pipes/evm";
import { bloklakeClient } from "#src/bloklake.ts";

type Row = Record<string, string | number | null>;
type Filter = Record<string, string[]>;
type Body = { fromBlock: number; toBlock: number; logs: Filter[]; fields: unknown };

const transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const approval = parseAbiItem("event Approval(address indexed owner, address indexed spender, uint256 value)");
const nftTransfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
// viem encodes the logs, and the client decodes them with the event a source would pass, which
// defineAbi builds from the same JSON ABI item.
const pipesEvent = (item: AbiEvent) => Object.values(defineAbi([item]).events)[0]!;

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
 * first, one a request: a status and headers, or "drop" to break the connection. `skip` blocks are
 * left out between one response and the next, as a faulty server might.
 */
async function bloklake(
  t: TestContext,
  { logs, head, blocksPerPage = 100, failures = [], skip = 0 }: {
    logs: Row[];
    head: number;
    blocksPerPage?: number;
    failures?: ("drop" | { status: number; headers?: Record<string, string>; code: string })[];
    skip?: number;
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
        next_block: beyondHead ? fromBlock : to + 1 + skip,
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

/** A clock that returns from each wait at once and records it in `waits`. */
function fakeClock() {
  const waits: number[] = [];
  return { waits, now: () => 0, sleep: async (ms: number) => void waits.push(ms) };
}

test("it asks for the next page only when the caller wants one, starting at next_block", async (t) => {
  const { url, requests } = await bloklake(t, { logs: [1, 2, 3, 4, 5].map(transferIn), head: 100, blocksPerPage: 2 });
  const pages = bloklakeClient(url, "bl_live_test", fakeClock()).events({ transfers: { event: pipesEvent(transfer) } }, { from: 1, to: 5 });

  const { value: first } = await pages.next();
  assert.ok(first);
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
  const pages = await collect(bloklakeClient(url, "k", fakeClock()).events({ transfers: { event: pipesEvent(transfer) } }, { from: 1, to: 10 }));
  assert.deepEqual(pages.map((page) => page.through), [2, 3]);
});

test("a response whose next_block skips blocks fails the read instead of losing them", async (t) => {
  const { url } = await bloklake(t, { logs: [1, 2, 3, 4, 5].map(transferIn), head: 100, blocksPerPage: 2, skip: 2 });
  const pages = bloklakeClient(url, "k", fakeClock()).events({ transfers: { event: pipesEvent(transfer) } }, { from: 1, to: 5 });
  await assert.rejects(collect(pages), /blocks 1 to 2 with next_block 5/);
});

test("a page with no matching log still reports the blocks it covered", async (t) => {
  const { url } = await bloklake(t, { logs: [], head: 100 });
  const pages = await collect(bloklakeClient(url, "k", fakeClock()).events({ transfers: { event: pipesEvent(transfer) } }, { from: 1, to: 50 }));
  assert.deepEqual(pages, [{ events: { transfers: [] }, through: 50 }]);
});

test("each log is decoded into the values the rows Pipes loaded hold", async (t) => {
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

  const [page] = await collect(bloklakeClient(url, "k", fakeClock()).events({ probes: { event: pipesEvent(probe) } }, { from: 1, to: 10 }));

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
    bloklakeClient(url, "k", fakeClock()).events(
      {
        received: { event: pipesEvent(transfer), contracts: [TOKEN], params: { to: [WALLET] } },
        approvals: { event: pipesEvent(approval) },
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
  const [page] = await collect(bloklakeClient(url, "k", fakeClock()).events({ transfers: { event: pipesEvent(transfer) } }, { from: 1, to: 10 }));
  assert.deepEqual(page!.events.transfers.map((e) => e.logIndex), [1]);
});

test("an indexed string, bytes or array is only a hash in the log, and its value is that hash", async (t) => {
  const named = parseAbiItem("event Named(string indexed name, bytes indexed tag, address[] indexed list, uint8 n)");
  const [signature, name, tag] = encodeEventTopics({ abi: [named], args: { name: "héllo", tag: "0xcafe" } }) as string[];
  const list = `0x${"ee".repeat(32)}`;
  const row = {
    ...transferIn(3),
    topic0: signature!,
    topic1: name!,
    topic2: tag!,
    topic3: list,
    data: encodeAbiParameters([{ type: "uint8" }], [7]),
  };
  const { url } = await bloklake(t, { head: 100, logs: [row] });

  const [page] = await collect(bloklakeClient(url, "k", fakeClock()).events({ named: { event: pipesEvent(named) } }, { from: 1, to: 10 }));

  assert.deepEqual(page!.events.named.map((e) => e.args), [{ name, tag, list, n: 7 }]);
});

test("the finalized head comes from /status, and the key goes as a bearer token", async (t) => {
  const { url, requests } = await bloklake(t, { logs: [], head: 100 });
  assert.equal(await bloklakeClient(`${url}/`, "bl_live_test", fakeClock()).finalizedHead(), 95);
  assert.equal(requests[0]!.path, "/status");
  assert.equal(requests[0]!.headers.authorization, "Bearer bl_live_test");
});

test("it waits as long as bloklake says and asks again when the rate limit is hit", async (t) => {
  const { url, requests } = await bloklake(t, {
    logs: [transferIn(1)],
    head: 100,
    failures: [{ status: 429, headers: { "retry-after": "3" }, code: "rate_limited" }],
  });
  const clock = fakeClock();
  const pages = await collect(bloklakeClient(url, "k", clock).events({ transfers: { event: pipesEvent(transfer) } }, { from: 1, to: 10 }));
  assert.equal(pages[0]!.events.transfers.length, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(clock.waits, [3000]);
});

test("it asks again when the connection breaks", async (t) => {
  const { url, requests } = await bloklake(t, { logs: [transferIn(1)], head: 100, failures: ["drop"] });
  const clock = fakeClock();
  const pages = await collect(bloklakeClient(url, "k", clock).events({ transfers: { event: pipesEvent(transfer) } }, { from: 1, to: 10 }));
  assert.equal(pages[0]!.events.transfers.length, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(clock.waits, [1000]);
});

test("without a Retry-After each wait doubles up to 30 seconds, and the tenth failure is final", async (t) => {
  const busy = { status: 503, code: "busy" };
  const { url, requests } = await bloklake(t, { logs: [], head: 100, failures: Array.from({ length: 10 }, () => busy) });
  const clock = fakeClock();
  await assert.rejects(bloklakeClient(url, "k", clock).finalizedHead(), /503/);
  assert.equal(requests.length, 10);
  assert.deepEqual(clock.waits, [1, 2, 4, 8, 16, 30, 30, 30, 30].map((seconds) => seconds * 1000));
});

test("a request bloklake refuses fails at once, with bloklake's reason", async (t) => {
  const { url, requests } = await bloklake(t, { logs: [], head: 100, failures: [{ status: 400, code: "invalid_query" }] });
  const pages = bloklakeClient(url, "k", fakeClock()).events({ transfers: { event: pipesEvent(transfer) } }, { from: 1, to: 10 });
  await assert.rejects(collect(pages), /400.*invalid_query/s);
  assert.equal(requests.length, 1);
});
