import { batches, DAY_MS, describeError, historyKey, logger, readJson, uniqueBy, type Batch, type Source } from "@ingestion/lib";
import {
  accountsFileSchema,
  createExplorerClient,
  createLighterClient,
  DETAIL_TYPES,
  LEDGER_TYPES,
  lighterEnv,
  lighterExplorerEnv,
  resolveAccounts,
  systemClock,
  type Clock,
} from "@ingestion/lib/lighter";
import * as z from "zod";

const startTime = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })], {
    error: (issue) =>
      issue.input === undefined
        ? "Required"
        : "Expected an ISO date or datetime, such as 2026-10-01 or 2026-10-01T00:00:00Z",
  })
  .transform((value) => Date.parse(value));

const accountLogsEnv = lighterExplorerEnv.extend(lighterEnv.shape).extend({
  START_TIME: startTime,
  HISTORY_OVERLAP_DAYS: z.coerce.number().int().nonnegative().default(1),
  LIGHTER_LOG_PAGE_SIZE: z.coerce.number().int().positive().max(100).default(100),
});

export type LighterAccountLogsEnv = z.infer<typeof accountLogsEnv>;

const walkCallSchema = z.object({
  kind: z.literal("walk"),
  account_index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  since: z.number().int(),
});
const detailCallSchema = z.object({ kind: z.literal("detail"), hash: z.string().min(1) });
const callSchema = z.discriminatedUnion("kind", [walkCallSchema, detailCallSchema]);

export type AccountLogsCall = z.infer<typeof callSchema>;
type WalkCall = z.infer<typeof walkCallSchema>;

const callId = (call: AccountLogsCall) => (call.kind === "walk" ? `walk:${call.account_index}` : `detail:${call.hash}`);

// A walk's pages go out 10 to a batch, up to 1,000 entries with their details.
const PAGES_PER_BATCH = 10;
// Retried details go out 100 to a batch.
const DETAILS_PER_BATCH = 100;

const progress = z.object({
  account_index: z.number(),
  origin: z.number(),
  newest: z.number().nullable(),
  read_at: z.number(),
});

const logPage = z.array(z.looseObject({ hash: z.string().min(1), time: z.string(), pubdata_type: z.string() }));

const detailTypes = new Set(DETAIL_TYPES);

// 0 to 6 decimals on the seconds and a zone: Date.parse keeps only 3 decimals and reads a time with no
// zone as local time.
const EXPLORER_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;

/** An Explorer time in µs since the epoch. */
function microseconds(text: string): number {
  const match = EXPLORER_TIME.exec(text);
  const ms = match ? Date.parse(`${match[1]}${match[3]}`) : NaN;
  if (Number.isNaN(ms)) throw new Error(`Lighter's Explorer sent a time it cannot read: ${text}`);
  return ms * 1000 + Number((match![2] ?? "").padEnd(6, "0"));
}

const emptyBatch = (): Batch<AccountLogsCall> & { callsCompleted: number } => ({ records: [], failed: [], callsCompleted: 0 });

// Walks the ledger entries of each account in addresses.json, and of each sub-account of an L1 address
// there, newest first by offset. A walk stops at the first page shorter than a full page or holding an
// entry older than its `since`, and writes the entries at or after `since`, keyed by account and hash:
// an entry that new entries push onto the next page is written once, and a transfer between two listed
// accounts is written under each. `since` is START_TIME on the first walk, then the newest entry the
// last walk saw less HISTORY_OVERLAP_DAYS, never before START_TIME. After each page the source reads
// logs/{hash}, which adds the block and batch, for each entry of DETAIL_TYPES, once a run per hash
// (catalog/vendors/lighter/NOTES.md, Account logs). A walk that fails keeps the pages before the
// failure; only its last page carries its call id, so its dead letter stays until a walk ends. A failed
// detail waits as a dead letter of its own.
export const accountLogsSource = (clock: Clock = systemClock): Source<LighterAccountLogsEnv, AccountLogsCall> => ({
  name: "lighter",
  table: "account_logs",
  env: accountLogsEnv,
  call: callSchema,
  async *extract(env, retry, context) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const file = accountsFileSchema.safeParse(readJson("addresses.json"));
    if (!file.success) throw new Error(`Invalid addresses.json:\n${z.prettifyError(file.error)}`);
    const accounts = await resolveAccounts(createLighterClient(env, clock), file.data);
    const explorer = createExplorerClient(env, clock);
    const keyOf = (account: number) =>
      historyKey(["lighter", env.LIGHTER_EXPLORER_URL, "account_logs", account, env.START_TIME, LEDGER_TYPES]);

    const walks = new Map<number, WalkCall>();
    for (const account of accounts) {
      const saved = progress.safeParse(await context?.getCheckpoint?.(keyOf(account)));
      const newest = saved.success ? saved.data.newest : null;
      const since = newest === null ? env.START_TIME : Math.max(env.START_TIME, newest - env.HISTORY_OVERLAP_DAYS * DAY_MS);
      walks.set(account, { kind: "walk", account_index: account, since });
    }
    // A retried walk merges into this run's walk of its account, which reads back to the earlier since.
    for (const call of retry) {
      if (call.kind !== "walk") continue;
      const fresh = walks.get(call.account_index);
      walks.set(call.account_index, { ...call, since: Math.min(call.since, fresh?.since ?? call.since) });
    }
    logger.info({ walks: [...walks.values()] }, "Walking Lighter account logs back to each walk's since");

    // The hashes whose logs/{hash} this run has read.
    const asked = new Set<string>();
    async function readDetails(hashes: string[], batch: ReturnType<typeof emptyBatch>) {
      for (const hash of hashes) {
        if (asked.has(hash)) continue;
        asked.add(hash);
        const call: AccountLogsCall = { kind: "detail", hash };
        try {
          const reply = await explorer.log(hash);
          if (reply.hash !== hash) throw new Error(`Lighter's Explorer answered log ${hash} with log ${String(reply.hash)}`);
          batch.records.push({ id: callId(call), callId: callId(call), data: reply });
        } catch (error) {
          batch.failed.push({ id: callId(call), call, error: describeError(error) });
        }
        batch.callsCompleted++;
      }
    }

    async function* walk(call: WalkCall): AsyncGenerator<Batch<AccountLogsCall>> {
      const id = callId(call);
      const account = call.account_index;
      const size = env.LIGHTER_LOG_PAGE_SIZE;
      const written = new Set<string>();
      let batch = emptyBatch();
      let previous: string | undefined;
      let newest: number | null = null;
      let readAt = 0;
      for (let page = 0; ; page++) {
        let entries: z.infer<typeof logPage>;
        let times: number[];
        try {
          if (page === 0) readAt = clock.now();
          const reply = await explorer.accountLogs(account, { limit: size, offset: page * size });
          // An Explorer that ignored offset would send the same page forever.
          const text = JSON.stringify(reply);
          if (text === previous) {
            throw new Error(`Lighter's Explorer repeated page ${page - 1} of account ${account}'s log at offset ${page * size}`);
          }
          previous = text;
          const parsed = logPage.safeParse(reply);
          if (!parsed.success) {
            throw new Error(`Lighter's Explorer sent account ${account}'s log in an unexpected shape:\n${z.prettifyError(parsed.error)}`);
          }
          entries = parsed.data;
          times = entries.map((entry) => microseconds(entry.time));
        } catch (error) {
          batch.failed.push({ id, call, error: describeError(error) });
          batch.callsCompleted++;
          yield batch;
          return;
        }
        if (page === 0 && times[0] !== undefined) newest = Math.floor(times[0] / 1000);
        const kept = entries.filter((_, i) => times[i]! >= call.since * 1000);
        const last = entries.length < size || kept.length < entries.length;
        // Only the last page's records carry the walk's id, so a walk that fails later keeps its dead letter.
        const recordCallId = last ? id : `${id}#${page}`;
        for (const entry of kept) {
          if (written.has(entry.hash)) continue;
          written.add(entry.hash);
          batch.records.push({ id: `log:${account}:${entry.hash}`, callId: recordCallId, data: { account_index: account, entry } });
        }
        await readDetails(kept.filter((entry) => detailTypes.has(entry.pubdata_type)).map((entry) => entry.hash), batch);
        if (last) {
          // The last page can hold only entries written already, so the walk's id clears its dead letter here.
          batch.succeededCallIds = [id];
          batch.callsCompleted++;
          batch.checkpoints = [{ key: keyOf(account), value: { account_index: account, origin: env.START_TIME, newest, read_at: readAt } }];
          yield batch;
          return;
        }
        if ((page + 1) % PAGES_PER_BATCH === 0) {
          yield batch;
          batch = emptyBatch();
        }
      }
    }

    for (const call of walks.values()) yield* walk(call);

    // Retried details that no walk read again.
    const details = uniqueBy(retry, callId).flatMap((call) => (call.kind === "detail" && !asked.has(call.hash) ? [call.hash] : []));
    for (const part of batches(details, DETAILS_PER_BATCH)) {
      const batch = emptyBatch();
      await readDetails(part, batch);
      yield batch;
    }
  },
});

export const lighterAccountLogs = accountLogsSource();
