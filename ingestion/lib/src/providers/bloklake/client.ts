import {
  buildEventTopics,
  getNormalizedEventParams,
  type AbiDecodeEvent,
  type EventFilter,
  type IndexedParamsInput,
} from "@subsquid/pipes/evm";
import * as z from "zod";
import type { Clock } from "#src/clock.ts";

type Hex = `0x${string}`;

// Pipes does not export the type of the events defineAbi builds, so it comes out of the filter type.
type PipesEvent = Extract<EventFilter, { decode: unknown }>;

/**
 * One event to read, as a Pipes decoder takes it: the event `defineAbi` builds from a JSON ABI, such as
 * catalog/protocols/<name>/abis/ holds, and which values of its indexed arguments to keep. Also the
 * contracts that emit it.
 */
export type EventRequest<E extends PipesEvent = PipesEvent> = {
  event: E;
  /** An indexed argument's name and the value or values it may have. */
  params?: IndexedParamsInput<E>;
  /** The contracts that emit it. Left out: any contract. */
  contracts?: Hex[];
};

/**
 * One log of an event. Pipes' own decoder decodes `args`, so they hold what the rows Pipes loaded
 * already hold. As in those rows, an indexed string, bytes or dynamic array is its keccak-256 hash.
 */
export type BloklakeEvent<Args> = {
  blockNumber: number;
  /** The block's time, in seconds. */
  timestamp: number;
  transactionHash: Hex;
  logIndex: number;
  contract: Hex;
  args: Args;
};

/** One response's events, under the name each request was given. `through` is the last block it covered. */
export type EventPage<R extends Record<string, EventRequest>> = {
  events: { [K in keyof R]: BloklakeEvent<AbiDecodeEvent<R[K]["event"]>>[] };
  through: number;
};

const hex = z.templateLiteral(["0x", z.string()]);
const status = z.object({ finalized_block: z.number().nullable() });
const logsPage = z.object({
  to_block: z.number(),
  next_block: z.number(),
  logs: z.array(
    z.object({
      block_number: z.number(),
      log_index: z.number(),
      transaction_hash: hex,
      address: hex,
      topic0: hex.nullable(),
      topic1: hex.nullable(),
      topic2: hex.nullable(),
      topic3: hex.nullable(),
      data: hex,
      block_timestamp: z.number(),
    }),
  ),
});
type Log = z.infer<typeof logsPage>["logs"][number];

const LOG_FIELDS = {
  blockNumber: true,
  logIndex: true,
  transactionHash: true,
  address: true,
  topic0: true,
  topic1: true,
  topic2: true,
  topic3: true,
  data: true,
  blockTimestamp: true,
};

/** bloklake returns a log when, for any one filter, each field of the filter lists the log's value. */
type LogFilter = Partial<
  Record<"address" | "topic0" | "topic1" | "topic2" | "topic3", string[]>
>;

const TRIES = 10;
/** The longest wait between two tries, whatever bloklake asks for, so ten tries end within minutes. */
const WAIT_SECONDS_MAX = 30;
/** Too many requests, no free query slot, and a fault on bloklake's side or in a gateway before it. */
const WORTH_ANOTHER_TRY = new Set([429, 500, 502, 503, 504]);

/**
 * A client for one chain of bloklake, at `url`: https://api.bloklake.com/v1/chains/<chain>.
 * It keeps no cursor. The caller says which blocks to read, and each page says how far it got.
 *
 * The cheapest plan allows one request a second, so reading page after page meets HTTP 429 as a
 * matter of course. Ten tries, each after the wait bloklake asks for, get past that and past a
 * broken connection without hanging a run for good.
 */
export function bloklakeClient(url: string, apiKey: string, clock: Clock) {
  const base = url.replace(/\/+$/, "");

  async function send(path: string, body?: unknown) {
    try {
      const response = await fetch(`${base}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(120_000),
      });
      if (response.ok)
        return { ok: true as const, json: (await response.json()) as unknown };
      const retryAfter = Number.parseFloat(
        response.headers.get("retry-after") ?? "",
      );
      return {
        ok: false as const,
        error: new Error(
          `bloklake answered ${response.status} to ${path}: ${await response.text()}`,
        ),
        final: !WORTH_ANOTHER_TRY.has(response.status),
        retryAfter: retryAfter >= 0 ? retryAfter : undefined,
      };
    } catch (error) {
      return { ok: false as const, error, final: false };
    }
  }

  async function call<T>(
    answer: z.ZodType<T>,
    path: string,
    body?: unknown,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const sent = await send(path, body);
      if (sent.ok) return answer.parse(sent.json);
      if (sent.final || attempt === TRIES) throw sent.error;
      const seconds = Math.min(
        sent.retryAfter ?? 2 ** (attempt - 1),
        WAIT_SECONDS_MAX,
      );
      await clock.sleep(seconds * 1000);
    }
  }

  return {
    /** The last block that can no longer change. A run ends its range there. */
    async finalizedHead(): Promise<number> {
      const { finalized_block } = await call(status, "/status");
      if (finalized_block === null)
        throw new Error(`${url} reports no finalized block`);
      return finalized_block;
    },

    /**
     * The events of blocks `from` to `to`, decoded, one page for each response of bloklake's. It
     * asks for the next page only when the caller wants one. A range that runs past the chain's
     * head ends at the head.
     */
    async *events<R extends Record<string, EventRequest>>(
      requests: R,
      range: { from: number; to: number },
    ): AsyncGenerator<EventPage<R>, void, void> {
      const named = Object.entries(requests).map(
        ([name, { event, params = {}, contracts }]) => {
          const filter: LogFilter = {
            ...(contracts && {
              address: contracts.map((contract) => contract.toLowerCase()),
            }),
            ...buildEventTopics(event, getNormalizedEventParams(params)),
          };
          return { name, event, filter };
        },
      );
      let from = range.from;
      while (from <= range.to) {
        const page = await call(logsPage, "/query/json", {
          fromBlock: from,
          toBlock: range.to,
          logs: named.map(({ filter }) => filter),
          fields: { log: LOG_FIELDS },
        });
        // Past the head bloklake returns no blocks and repeats the block it was asked for. A repeated
        // block that comes with logs fails the check below instead of losing them.
        if (page.next_block === from && page.logs.length === 0) return;
        if (page.to_block < from || page.next_block !== page.to_block + 1) {
          throw new Error(
            `bloklake answered blocks ${from} to ${page.to_block} with next_block ${page.next_block}`,
          );
        }
        yield {
          events: Object.fromEntries(
            named.map(({ name, event, filter }) => [
              name,
              page.logs.flatMap((log) => {
                const record = { topics: topics(log), data: log.data };
                // `is` also leaves out a log that shares the event's signature but indexes other
                // arguments, as ERC-721's Transfer does with ERC-20's.
                return matches(filter, log) && event.is(record)
                  ? [{ ...meta(log), args: event.decode(record) }]
                  : [];
              }),
            ]),
          ) as EventPage<R>["events"],
          through: page.to_block,
        };
        from = page.next_block;
      }
    },
  };
}

const topics = (log: Log) =>
  [log.topic0, log.topic1, log.topic2, log.topic3].filter(
    (topic) => topic !== null,
  );

// buildEventTopics leaves a topic it does not filter on undefined.
const matches = (filter: LogFilter, log: Log) =>
  Object.entries(filter).every(
    ([field, values]) =>
      !values || values.includes(log[field as keyof LogFilter] ?? ""),
  );

const meta = (log: Log) => ({
  blockNumber: log.block_number,
  timestamp: log.block_timestamp,
  transactionHash: log.transaction_hash,
  logIndex: log.log_index,
  contract: log.address,
});
