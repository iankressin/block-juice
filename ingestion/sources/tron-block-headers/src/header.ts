import assert from "node:assert/strict";
import { describeError } from "@ingestion/lib";
import type { PortalClient, TronQuery } from "@subsquid/pipes/portal-client";
import * as z from "zod";

/** A block header as one origin states it. Hashes are hex without 0x, as both origins write. */
export type Header = {
  number: number;
  hash: string;
  parentHash: string;
  timestampMs: number;
};

// A request for more headers than this is a bug: a call reads two, a search probe one.
const PORTAL_HEADERS_MAX = 2;

/** Portal's headers of blocks `from` to `to`, every one of them, in order. */
export async function portalHeaders(portal: PortalClient, from: number, to: number) {
  assert.ok(from >= 0);
  assert.ok(to >= from);
  assert.ok(to - from + 1 <= PORTAL_HEADERS_MAX);
  const query: TronQuery = {
    type: "tron",
    fromBlock: from,
    toBlock: to,
    includeAllBlocks: true,
    fields: { block: { number: true, hash: true, parentHash: true, timestamp: true } },
  };
  const headers: Header[] = [];
  for await (const { blocks } of portal.getStream(query)) {
    for (const { header } of blocks) {
      const { number, hash, parentHash, timestamp } = header;
      headers.push({ number, hash, parentHash, timestampMs: timestamp });
    }
  }
  const numbers = headers.map((h) => h.number);
  const expected = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  if (numbers.join() !== expected.join()) {
    throw new Error(`Portal sent headers [${numbers}] for blocks ${from} to ${to}`);
  }
  return headers;
}

const HEX_HASH = /^[0-9a-f]{64}$/;
const blockReply = z.object({
  blockID: z.string().regex(HEX_HASH),
  block_header: z.object({
    raw_data: z.object({
      number: z.number().int().nonnegative(),
      timestamp: z.number().int().positive(),
      parentHash: z.string().regex(HEX_HASH),
    }),
  }),
});

export type TronHttpSettings = {
  url: string;
  apiKey: string | undefined;
  /** The least time between two requests; a retry waits this times 2^attempt more. */
  intervalMs: number;
};

// TronGrid answers 429 or a 5xx under load; a few tries with growing waits get past it.
const ATTEMPTS_MAX = 5;
const REQUEST_TIMEOUT_MS = 30_000;
const REPLY_CHARS_SHOWN = 200;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Block headers over TRON's HTTP API (wallet/getblockbynum), one request at a time, spaced and
 * retried. TronGrid limits clients without a key, so the spacing matters more than speed.
 */
export function tronHttp(settings: TronHttpSettings) {
  assert.ok(Number.isSafeInteger(settings.intervalMs));
  assert.ok(settings.intervalMs >= 0);
  const base = settings.url.endsWith("/") ? settings.url : `${settings.url}/`;
  const endpoint = new URL("wallet/getblockbynum", base);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (settings.apiKey) headers["TRON-PRO-API-KEY"] = settings.apiKey;
  let lastStartMs = 0;

  async function request(number: number, attempt: number): Promise<Response> {
    const backoffMs = attempt === 0 ? 0 : settings.intervalMs * 2 ** attempt;
    await sleep(Math.max(0, lastStartMs + settings.intervalMs - Date.now()) + backoffMs);
    lastStartMs = Date.now();
    return fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ num: number }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  return {
    async header(number: number): Promise<Header> {
      assert.ok(Number.isSafeInteger(number));
      assert.ok(number >= 0);
      let failure: unknown;
      for (let attempt = 0; attempt < ATTEMPTS_MAX; attempt++) {
        let response: Response;
        try {
          response = await request(number, attempt);
        } catch (error) {
          failure = error;
          continue;
        }
        const text = await response.text();
        if (response.status === 429 || response.status >= 500) {
          failure = new Error(`HTTP ${response.status}: ${text.slice(0, REPLY_CHARS_SHOWN)}`);
          continue;
        }
        if (!response.ok) {
          const reply = text.slice(0, REPLY_CHARS_SHOWN);
          throw new Error(`TronGrid answered ${response.status} for block ${number}: ${reply}`);
        }
        return parseBlock(text, number);
      }
      const reason = describeError(failure);
      throw new Error(`TronGrid failed ${ATTEMPTS_MAX} times for block ${number}: ${reason}`);
    },
  };
}

export type TronHttp = ReturnType<typeof tronHttp>;

function parseBlock(text: string, number: number): Header {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    const reply = text.slice(0, REPLY_CHARS_SHOWN);
    throw new Error(`TronGrid sent no JSON for block ${number}: ${reply}`);
  }
  const parsed = blockReply.safeParse(json);
  // TronGrid answers {} for a block it does not have.
  if (!parsed.success) {
    throw new Error(`TronGrid has no block ${number}: ${text.slice(0, REPLY_CHARS_SHOWN)}`);
  }
  const { blockID, block_header } = parsed.data;
  const raw = block_header.raw_data;
  if (raw.number !== number) {
    throw new Error(`TronGrid answered block ${raw.number} for block ${number}`);
  }
  return { number, hash: blockID, parentHash: raw.parentHash, timestampMs: raw.timestamp };
}
