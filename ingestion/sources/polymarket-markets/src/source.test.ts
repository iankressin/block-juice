import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import type { Batch } from "@ingestion/lib";
import type { Clock } from "#src/gamma.ts";
import type { MarketsWalkCall } from "#src/markets.ts";
import { marketsSource, type GammaEnv } from "#src/source.ts";

const NOW = Date.UTC(2026, 10, 7, 12);
const FROM = Date.UTC(2026, 10, 5);

type Reply = { status: number; body: unknown };
type Pages = Record<string, unknown[][]>;

/** A walk's key in the fake: its filters, as `<version> <open|closed> <min> <max>`. */
const key = (version: string, closed: boolean, min = "", max = "") =>
  `${version} ${closed ? "closed" : "open"} ${min} ${max}`.trimEnd();

const market = (id: number, extra: Record<string, unknown> = {}) => ({
  id: String(id),
  question: `Question ${id}?`,
  outcomes: '["Yes", "No"]',
  clobTokenIds: null,
  events: [{ id: "1", slug: "event" }],
  ...extra,
});

/**
 * Gamma's keyset list over `walks`, each a list of pages. A reply holds a page and, unless it is
 * the last, a `next_cursor` that names the next one. A walk the test does not list is empty.
 * `reply` may answer a request in its place. `requests` gets each request's query string.
 */
async function fakeGamma(
  t: TestContext,
  {
    walks = {},
    reply,
    requests = [],
  }: {
    walks?: Pages;
    reply?: (walk: string, query: URLSearchParams, n: number) => Reply | undefined;
    requests?: string[];
  } = {},
) {
  const seen = new Map<string, number>();
  const server = createServer((req, res) => {
    const { pathname, searchParams: q } = new URL(req.url!, "http://gamma");
    requests.push(decodeURIComponent(q.toString()));
    const walk = key(
      q.get("version") ?? "",
      q.get("closed") === "true",
      q.get("end_date_min") ?? "",
      q.get("end_date_max") ?? "",
    );
    const n = (seen.get(`${walk} ${q.get("after_cursor")}`) ?? 0) + 1;
    seen.set(`${walk} ${q.get("after_cursor")}`, n);
    let answer: Reply | undefined = pathname === "/markets/keyset" ? reply?.(walk, q, n) : undefined;
    if (!answer) {
      const pages = walks[walk] ?? [];
      const index = Number(q.get("after_cursor")?.slice(1) ?? 0);
      const body: Record<string, unknown> = { markets: pages[index] ?? [] };
      if (index + 1 < pages.length) body.next_cursor = `p${index + 1}`;
      answer = { status: 200, body };
    }
    const { status, body } = answer;
    if (typeof body === "string") res.writeHead(status, { "content-type": "text/plain" }).end(body);
    else res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A clock stopped at `now` that a sleep moves forward at once. `events` gets each sleep. */
function fakeClock(now: number, events: string[] = []): Clock {
  return {
    now: () => now,
    sleep: async (ms) => {
      events.push(`sleep ${ms}`);
      now += ms;
    },
  };
}

const envAt = (url: string, overrides: Partial<GammaEnv> = {}): GammaEnv => ({
  GAMMA_API_URL: url,
  GAMMA_PAGE_SIZE: 2,
  GAMMA_MAX_CONCURRENCY: 20,
  GAMMA_END_DATE_FROM: FROM,
  ...overrides,
});

async function run(env: GammaEnv, retry: MarketsWalkCall[] = [], clock: Clock = fakeClock(NOW)) {
  const batches: Batch<MarketsWalkCall>[] = [];
  for await (const batch of marketsSource(clock).extract(env, retry)) batches.push(batch);
  return batches;
}

const records = (batches: Batch<MarketsWalkCall>[]) => batches.flatMap((batch) => batch.records);

const day = (date: string): MarketsWalkCall => ({
  kind: "markets_walk",
  version: "v1",
  closed: true,
  end_date_min: `${date}T00:00:00Z`,
  end_date_max: `${new Date(Date.parse(date) + 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`,
});

const OPEN = key("v1", false);
const DAY = key("v1", true, "2026-11-07T00:00:00Z", "2026-11-08T00:00:00Z");

test("walks the cursor to the end, one record per market holding the object as sent", async (t) => {
  const served = [[market(1), market(2, { extra: { deep: [1, { a: null }] } })], [market(3), market(4)], [market(5)]];
  const requests: string[] = [];
  const url = await fakeGamma(t, { walks: { [OPEN]: served }, requests });

  const batches = await run(envAt(url));

  assert.deepEqual(
    records(batches).map(({ id, callId }) => ({ id, callId })),
    [
      { id: "market:1", callId: "markets:v1:open#0" },
      { id: "market:2", callId: "markets:v1:open#0" },
      { id: "market:3", callId: "markets:v1:open#1" },
      { id: "market:4", callId: "markets:v1:open#1" },
      { id: "market:5", callId: "markets:v1:open" },
    ],
  );
  assert.deepEqual(
    records(batches).map(({ data }) => data),
    served.flat(),
  );
  const walk = requests.filter((request) => request.includes("version=v1&closed=false&limit=2"));
  assert.deepEqual(walk, [
    "version=v1&closed=false&limit=2",
    "version=v1&closed=false&limit=2&after_cursor=p1",
    "version=v1&closed=false&limit=2&after_cursor=p2",
  ]);
  // The open walk sets no date filter.
  assert.ok(!walk.some((request) => request.includes("end_date")));
});

test("builds open, daily closed and after-today walks for v1 and v2", async (t) => {
  const requests: string[] = [];
  const url = await fakeGamma(t, { requests });

  const batches = await run(envAt(url));

  // Every walk answers an empty page, so each reports its id.
  const ids = batches.flatMap((batch) => batch.succeededCallIds ?? []);
  const expected = ["v1", "v2"].flatMap((v) => [
    `markets:${v}:open`,
    `markets:${v}:closed:2026-11-05`,
    `markets:${v}:closed:2026-11-06`,
    `markets:${v}:closed:2026-11-07`,
    `markets:${v}:closed:after`,
  ]);
  assert.deepEqual([...ids].sort(), [...expected].sort());
  assert.deepEqual(
    [...requests].sort(),
    [
      ...["v1", "v2"].flatMap((v) => [
        `version=${v}&closed=false&limit=2`,
        `version=${v}&closed=true&limit=2&end_date_min=2026-11-05T00:00:00Z&end_date_max=2026-11-06T00:00:00Z`,
        `version=${v}&closed=true&limit=2&end_date_min=2026-11-06T00:00:00Z&end_date_max=2026-11-07T00:00:00Z`,
        `version=${v}&closed=true&limit=2&end_date_min=2026-11-07T00:00:00Z&end_date_max=2026-11-08T00:00:00Z`,
        `version=${v}&closed=true&limit=2&end_date_min=2026-11-08T00:00:00Z`,
      ]),
    ].sort(),
  );
});

test("a failed page fails its walk and the other walks still load", async (t) => {
  const url = await fakeGamma(t, {
    walks: {
      [OPEN]: [[market(1), market(2)], [market(3)]],
      [DAY]: [[market(11), market(12)], [market(13)]],
    },
    reply: (walk, query) =>
      walk === DAY && query.get("after_cursor") === "p1"
        ? { status: 500, body: { error: "internal error" } }
        : undefined,
  });

  const batches = await run(envAt(url));

  assert.deepEqual(
    records(batches).map(({ id }) => id).sort(),
    ["market:1", "market:11", "market:12", "market:2", "market:3"].sort(),
  );
  const failed = batches.flatMap((batch) => batch.failed);
  assert.deepEqual(failed, [
    { id: "markets:v1:closed:2026-11-07", call: day("2026-11-07"), error: "Gamma answered HTTP 500: internal error" },
  ]);
  // Its page-1 records carry a page-scoped id, so they cannot clear its dead letter.
  assert.deepEqual(
    records(batches).filter(({ id }) => id === "market:11" || id === "market:12").map(({ callId }) => callId),
    ["markets:v1:closed:2026-11-07#0", "markets:v1:closed:2026-11-07#0"],
  );
  // The failed walk's call id is not reported as a success.
  assert.ok(!batches.flatMap((batch) => batch.succeededCallIds ?? []).includes("markets:v1:closed:2026-11-07"));
});

test("a 429 is retried and then succeeds", async (t) => {
  const events: string[] = [];
  const url = await fakeGamma(t, {
    walks: { [OPEN]: [[market(1)]] },
    reply: (walk, _query, n) => (walk === OPEN && n <= 2 ? { status: 429, body: "slow down" } : undefined),
  });

  const batches = await run(envAt(url), [], fakeClock(NOW, events));

  assert.deepEqual(records(batches).map(({ id }) => id), ["market:1"]);
  assert.deepEqual(batches.flatMap((batch) => batch.failed), []);
  assert.deepEqual(events, ["sleep 1000", "sleep 2000"]);
});

test("a retried walk replaces its new twin", async (t) => {
  const requests: string[] = [];
  const url = await fakeGamma(t, { requests });

  const batches = await run(envAt(url), [day("2026-11-06")], fakeClock(NOW));

  assert.equal(requests.length, 10);
  assert.equal(new Set(requests).size, 10);
  const ids = batches.flatMap((batch) => batch.succeededCallIds ?? []);
  assert.equal(ids.length, 10);
  assert.equal(new Set(ids).size, 10);
});

test("a reply in an unexpected shape fails the walk and names the field", async (t) => {
  const url = await fakeGamma(t, {
    walks: { [OPEN]: [[market(1)]] },
    reply: (walk) => (walk === OPEN ? { status: 200, body: { markets: [{ id: 5 }] } } : undefined),
  });

  const batches = await run(envAt(url));

  const failed = batches.flatMap((batch) => batch.failed);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.id, "markets:v1:open");
  assert.match(failed[0]!.error, /unexpected shape/);
  assert.ok(failed[0]!.error.includes("markets[0].id"), failed[0]!.error);
  assert.deepEqual(records(batches), []);
});

test("a market seen by two walks in one round is written once", async (t) => {
  const url = await fakeGamma(t, {
    walks: { [OPEN]: [[market(7), market(8)]], [key("v2", false)]: [[market(7), market(9)]] },
  });

  const batches = await run(envAt(url));

  assert.equal(batches.length, 2);
  assert.deepEqual(records(batches).map(({ id }) => id).sort(), ["market:7", "market:8", "market:9"]);
});

const LONG_DAY = { [DAY]: [[market(1), market(2)], [market(3), market(4)], [market(5)]] };

test("a finished walk gives its slot to the next one, and a round yields once", async (t) => {
  const requests: string[] = [];
  const url = await fakeGamma(t, { walks: LONG_DAY, requests });

  const batches = await run(envAt(url, { GAMMA_MAX_CONCURRENCY: 3 }));

  // 10 walks, 3 slots. The two open walks go first, then the closed ones. The 2026-11-07 walk takes 3
  // rounds, and a slot freed by an empty walk goes to the next pending one: {open v1, open v2},
  // {05, 06, 07}, {07, after, v2 05}, {07, v2 06, v2 07}, {v2 after}. Fixed groups of three would take 6.
  assert.equal(batches.length, 5);
  assert.deepEqual(batches.map((batch) => (batch.succeededCallIds ?? []).length), [2, 2, 2, 3, 1]);
  assert.equal(records(batches).length, 5);
  assert.equal(requests.length, 12);
  assert.ok(batches.every((batch) => batch.records.length <= 2));
});

test("a round starts at most once a second", async (t) => {
  const events: string[] = [];
  const url = await fakeGamma(t, { walks: LONG_DAY, requests: events });

  const batches = await run(envAt(url, { GAMMA_MAX_CONCURRENCY: 3 }), [], fakeClock(NOW, events));

  assert.equal(batches.length, 5);
  // Five rounds: no wait before the first, one second before each of the others.
  assert.deepEqual(events.filter((event) => event.startsWith("sleep")), Array(4).fill("sleep 1000"));
  const kinds = events.map((event) => (event.startsWith("sleep") ? "sleep" : "request"));
  const round = (n: number) => Array(n).fill("request");
  assert.deepEqual(kinds, [...round(2), "sleep", ...round(3), "sleep", ...round(3), "sleep", ...round(3), "sleep", ...round(1)]);
});

test("a 4xx fails its walk at once, with no wait", async (t) => {
  const events: string[] = [];
  const requests: string[] = [];
  const url = await fakeGamma(t, {
    requests,
    reply: (walk) =>
      walk === DAY ? { status: 422, body: { type: "validation error", error: "invalid time range" } } : undefined,
  });

  const batches = await run(envAt(url), [], fakeClock(NOW, events));

  // The one sleep is the second between the open round and the closed round. A retry would add more.
  assert.deepEqual(events, ["sleep 1000"]);
  assert.equal(requests.filter((request) => request.includes("version=v1") && request.includes("end_date_min=2026-11-07")).length, 1);
  assert.deepEqual(batches.flatMap((batch) => batch.failed), [
    { id: "markets:v1:closed:2026-11-07", call: day("2026-11-07"), error: "Gamma answered HTTP 422: invalid time range" },
  ]);
});

test("a bad GAMMA_END_DATE_FROM, page size or concurrency is refused", () => {
  const { env } = marketsSource();
  const ok = { GAMMA_END_DATE_FROM: "2026-10-01" };
  assert.equal(env.safeParse(ok).success, true);
  assert.equal(env.safeParse({}).success, false);
  assert.equal(env.safeParse({ GAMMA_END_DATE_FROM: "yesterday" }).success, false);
  assert.equal(env.safeParse({ ...ok, GAMMA_PAGE_SIZE: "101" }).success, false);
  assert.equal(env.safeParse({ ...ok, GAMMA_MAX_CONCURRENCY: "21" }).success, false);
});

test("a page that hands back the cursor it was asked for fails its walk", async (t) => {
  const requests: string[] = [];
  const url = await fakeGamma(t, {
    walks: { [DAY]: [[market(11), market(12)], [market(13)]] },
    // Page p1 names itself as the next page. From the fourth ask it fails, so a walk that keeps
    // following the cursor still ends and the test shows it.
    reply: (walk, query, n) =>
      walk === DAY && query.get("after_cursor") === "p1"
        ? n <= 3
          ? { status: 200, body: { markets: [market(13)], next_cursor: "p1" } }
          : { status: 500, body: { error: "asked too often" } }
        : undefined,
    requests,
  });

  const batches = await run(envAt(url));

  assert.deepEqual(batches.flatMap((batch) => batch.failed), [
    { id: "markets:v1:closed:2026-11-07", call: day("2026-11-07"), error: "Gamma repeated next_cursor p1" },
  ]);
  const askedForP1 = requests.filter((request) => request.includes("end_date_min=2026-11-07") && request.includes("after_cursor=p1"));
  assert.equal(askedForP1.length, 1);
  assert.ok(!batches.flatMap((batch) => batch.succeededCallIds ?? []).includes("markets:v1:closed:2026-11-07"));
});

test("a walk that ends on an empty page reports its call id as a success", async (t) => {
  const url = await fakeGamma(t, { walks: { [OPEN]: [[market(1), market(2)], []] } });

  const batches = await run(envAt(url));

  assert.deepEqual(
    records(batches).map(({ id, callId }) => ({ id, callId })),
    [
      { id: "market:1", callId: "markets:v1:open#0" },
      { id: "market:2", callId: "markets:v1:open#0" },
    ],
  );
  assert.ok(batches.flatMap((batch) => batch.succeededCallIds ?? []).includes("markets:v1:open"));
});

test("a request that loses its connection is tried again", async (t) => {
  const events: string[] = [];
  let drops = 0;
  const server = createServer((req, res) => {
    if (drops++ === 0) return void req.socket.destroy();
    const q = new URL(req.url!, "http://gamma").searchParams;
    const body = { markets: q.get("version") === "v1" && q.get("closed") === "false" ? [market(1)] : [] };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const batches = await run(envAt(url), [], fakeClock(NOW, events));

  assert.deepEqual(batches.flatMap((batch) => batch.failed), []);
  assert.deepEqual(records(batches).map(({ id }) => id), ["market:1"]);
  assert.deepEqual(events, ["sleep 1000"]);
});

test("a 4xx whose body is cut short still fails its walk at once", async (t) => {
  const events: string[] = [];
  const server = createServer((req, res) => {
    const q = new URL(req.url!, "http://gamma").searchParams;
    if (q.get("version") === "v1" && q.get("closed") === "false") {
      res.writeHead(422, { "content-type": "application/json", "content-length": "500" });
      res.write('{"error":"inva');
      setTimeout(() => req.socket.destroy(), 20);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ markets: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const batches = await run(envAt(url), [], fakeClock(NOW, events));

  assert.deepEqual(events, ["sleep 1000"]);
  const failed = batches.flatMap((batch) => batch.failed);
  assert.deepEqual(failed.map(({ id }) => id), ["markets:v1:open"]);
  assert.match(failed[0]!.error, /HTTP 422/);
});

test("closed walks start after the open walks end, so a market that closes mid-run is seen once", async (t) => {
  // Market 99 sits on the open walk's last page until the open walk reads its second page; then it closes.
  const walks: Pages = {
    [OPEN]: [[market(1), market(2)], [market(3), market(4)], [market(99)]],
    [DAY]: [[]],
  };
  const requests: string[] = [];
  const url = await fakeGamma(t, {
    walks,
    requests,
    reply: (walk, query) => {
      if (walk === OPEN && query.get("after_cursor") === "p1") {
        walks[OPEN] = [walks[OPEN]![0]!, walks[OPEN]![1]!, []];
        walks[DAY] = [[market(99)]];
      }
      return undefined;
    },
  });

  const batches = await run(envAt(url));

  const found = records(batches).filter(({ id }) => id === "market:99");
  assert.deepEqual(found.map(({ callId }) => callId), ["markets:v1:closed:2026-11-07"]);
  const open = requests.flatMap((request, i) => (request.includes("closed=false") ? [i] : []));
  const closed = requests.flatMap((request, i) => (request.includes("closed=true") ? [i] : []));
  assert.ok(Math.max(...open) < Math.min(...closed), requests.join("\n"));
});

test("a retried open walk also finishes before any closed walk starts", async (t) => {
  const requests: string[] = [];
  const url = await fakeGamma(t, { walks: { [OPEN]: [[market(1)], [market(2)]] }, requests });
  const retryOpen: MarketsWalkCall = { kind: "markets_walk", version: "v1", closed: false, end_date_min: null, end_date_max: null };

  await run(envAt(url), [day("2026-11-06"), retryOpen]);

  const lastOpen = requests.map((request, i) => (request.includes("closed=false") ? i : -1)).reduce((a, b) => Math.max(a, b));
  const firstClosed = requests.findIndex((request) => request.includes("closed=true"));
  assert.ok(lastOpen < firstClosed, requests.join("\n"));
});
