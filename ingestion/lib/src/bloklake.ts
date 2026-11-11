import { setTimeout as sleep } from "node:timers/promises";
import { decodeEventLog, encodeEventTopics, type AbiEvent, type AbiParameter } from "viem";
import * as z from "zod";

type Hex = `0x${string}`;

/**
 * A decoded value. Every provider returns exactly this for each Solidity type, which is what the
 * rows Pipes loaded already hold:
 *
 * | Solidity type            | Value                                 |
 * | ------------------------ | ------------------------------------- |
 * | `address`                | hex string in lower case              |
 * | `bytes`, `bytesN`        | hex string in lower case              |
 * | `bool`                   | boolean                               |
 * | `string`                 | string                                |
 * | `intN`, `uintN`, N <= 32 | number                                |
 * | `intN`, `uintN`, N >= 40 | bigint                                |
 * | `T[]`, `T[k]`            | array of T's value                    |
 * | tuple                    | object keyed by each component's name |
 *
 * An indexed `string`, `bytes`, array or tuple is only its keccak-256 hash in the log, so its value
 * is that hash, as hex in lower case. Pipes gives the same.
 */
export type Value = string | number | bigint | boolean | Value[] | { [name: string]: Value };

/** One event to read: its ABI, who emits it, and which values of its indexed arguments to keep. */
export type EventRequest = {
  /** A JSON ABI event item with every argument named, as catalog/protocols/<name>/abis/ holds them. */
  event: AbiEvent;
  /** The contracts that emit it. Left out: any contract. */
  contracts?: Hex[];
  /** An indexed argument's name and the values it may have. */
  where?: Record<string, readonly unknown[]>;
};

export type DecodedEvent = {
  blockNumber: number;
  /** The block's time, in seconds. */
  timestamp: number;
  transactionHash: Hex;
  logIndex: number;
  contract: Hex;
  args: Record<string, Value>;
};

/** One response's events, under the name each request was given. `through` is the last block it covered. */
export type EventPage<K extends string> = { events: Record<K, DecodedEvent[]>; through: number };

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
type LogFilter = Partial<Record<"address" | "topic0" | "topic1" | "topic2" | "topic3", string[]>>;

const TRIES = 10;
/** Too many requests, a fault on bloklake's side, and no free query slot: bloklake says to ask again. */
const WORTH_ANOTHER_TRY = new Set([429, 500, 503]);

/**
 * A client for one chain of bloklake, at `url`: https://api.bloklake.com/v1/chains/<chain>.
 * It keeps no cursor. The caller says which blocks to read, and each page says how far it got.
 *
 * The cheapest plan allows one request a second, so reading page after page meets HTTP 429 as a
 * matter of course. Ten tries, each after the wait bloklake asks for, get past that and past a
 * broken connection without hanging a run for good.
 */
export function bloklakeClient(url: string, apiKey: string) {
  const base = url.replace(/\/+$/, "");

  async function send(path: string, body?: unknown) {
    try {
      const response = await fetch(`${base}${path}`, {
        method: body ? "POST" : "GET",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(120_000),
      });
      if (response.ok) return { ok: true as const, json: (await response.json()) as unknown };
      return {
        ok: false as const,
        error: new Error(`bloklake answered ${response.status} to ${path}: ${await response.text()}`),
        final: !WORTH_ANOTHER_TRY.has(response.status),
        retryAfter: Number.parseFloat(response.headers.get("retry-after") ?? ""),
      };
    } catch (error) {
      return { ok: false as const, error, final: false, retryAfter: Number.NaN };
    }
  }

  async function call<T>(answer: z.ZodType<T>, path: string, body?: unknown): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const sent = await send(path, body);
      if (sent.ok) return answer.parse(sent.json);
      if (sent.final || attempt === TRIES) throw sent.error;
      const seconds = Number.isNaN(sent.retryAfter) ? Math.min(2 ** (attempt - 1), 30) : sent.retryAfter;
      await sleep(seconds * 1000);
    }
  }

  return {
    /** The last block that can no longer change. A run ends its range there. */
    async finalizedHead(): Promise<number> {
      const { finalized_block } = await call(status, "/status");
      if (finalized_block === null) throw new Error(`${url} reports no finalized block`);
      return finalized_block;
    },

    /**
     * The events of blocks `from` to `to`, decoded, one page for each response of bloklake's. It
     * asks for the next page only when the caller wants one. A range that runs past the chain's
     * head ends at the head.
     */
    async *events<K extends string>(
      requests: Record<K, EventRequest>,
      range: { from: number; to: number },
    ): AsyncGenerator<EventPage<K>, void, void> {
      const named = Object.entries<EventRequest>(requests).map(
        ([name, request]) => ({ name, event: request.event, filter: logFilter(request) }),
      );
      let from = range.from;
      while (from <= range.to) {
        const page = await call(logsPage, "/query/json", {
          fromBlock: from,
          toBlock: range.to,
          logs: named.map(({ filter }) => filter),
          fields: { log: LOG_FIELDS },
        });
        // Past the head bloklake returns no blocks and repeats the block it was asked for.
        if (page.next_block === from) return;
        if (page.to_block < from || page.next_block !== page.to_block + 1) {
          throw new Error(`bloklake answered blocks ${from} to ${page.to_block} with next_block ${page.next_block}`);
        }
        yield {
          events: Object.fromEntries(
            named.map(({ name, event, filter }) => [
              name,
              page.logs.filter((log) => matches(filter, log)).flatMap((log) => decode(event, log)),
            ]),
          ) as Record<K, DecodedEvent[]>,
          through: page.to_block,
        };
        from = page.next_block;
      }
    },
  };
}

function logFilter({ event, contracts, where }: EventRequest): LogFilter {
  const topics = encodeEventTopics({ abi: [event], args: where });
  return {
    ...(contracts && { address: contracts.map((contract) => contract.toLowerCase()) }),
    ...Object.fromEntries(topics.flatMap((topic, i) => (topic === null ? [] : [[`topic${i}`, [topic].flat()]]))),
  };
}

const matches = (filter: LogFilter, log: Log) =>
  Object.entries(filter).every(([field, values]) => values.includes(log[field as keyof LogFilter] ?? ""));

function decode(event: AbiEvent, log: Log): DecodedEvent[] {
  const topics = [log.topic0, log.topic1, log.topic2, log.topic3].filter((topic) => topic !== null);
  // Another event can share the signature and index other arguments, as ERC-721's Transfer does
  // with ERC-20's. It is not this event.
  const signature = event.anonymous ? 0 : 1;
  if (topics.length !== signature + event.inputs.filter((input) => input.indexed).length) return [];
  const { args } = decodeEventLog({ abi: [event], topics: topics as [Hex, ...Hex[]], data: log.data });
  const decoded = args as unknown as Record<string, unknown>;
  return [
    {
      blockNumber: log.block_number,
      timestamp: log.block_timestamp,
      transactionHash: log.transaction_hash,
      logIndex: log.log_index,
      contract: log.address,
      args: Object.fromEntries(event.inputs.map((input) => [input.name, toValue(input, decoded[input.name!])])),
    },
  ];
}

/** viem's decoded value as the table on `Value` has it: viem checksums addresses and gives 40- and 48-bit integers as numbers. */
function toValue(parameter: AbiParameter, value: unknown): Value {
  if (Array.isArray(value)) {
    const item = { ...parameter, type: parameter.type.replace(/\[\d*\]$/, "") };
    return value.map((each) => toValue(item, each));
  }
  if (typeof value === "object" && value !== null) {
    const fields = value as Record<string, unknown>;
    const components = "components" in parameter ? parameter.components : [];
    return Object.fromEntries(components.map((component) => [component.name, toValue(component, fields[component.name!])]));
  }
  if (parameter.type === "address") return (value as string).toLowerCase();
  if (typeof value === "number" && Number(/^u?int(\d+)$/.exec(parameter.type)?.[1]) >= 40) return BigInt(value);
  return value as Value;
}
