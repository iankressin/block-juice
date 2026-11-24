import { describeError, systemClock, type Batch, type Clock, type Source } from "@ingestion/lib";
import { createLighterClient, lighterEnv, type LighterEnv } from "@ingestion/lib/lighter";
import * as z from "zod";

const callSchema = z.object({ kind: z.literal("public_pools") });
type PoolsCall = z.infer<typeof callSchema>;

const CALL_ID = "public_pools";

// The walk starts above the LLP, 281474976710654, the highest pool.
const TOP_INDEX = 281474976710655;
// The most pools a page holds.
const PAGE_SIZE = 100;
// 348 pools fill 4 pages. A walk that reaches 50 pages is not ending, so it fails.
const MAX_PAGES = 50;

const poolEntry = z.looseObject({ account_index: z.number() });
const poolsReply = z.object({ public_pools: z.array(poolEntry) });

// Walks every public pool, highest account_index first, in pages of PAGE_SIZE. Each pool is a record
// keyed by account and read time. Only the last page's records carry the call id, so a walk that fails
// partway keeps its dead letter and the pages before it stay (as in lighter-account-logs).
// A retried read is the same as the run's own read, so it runs once.
export const publicPoolsSource = (clock: Clock = systemClock): Source<LighterEnv, PoolsCall> => ({
  name: "lighter",
  table: "public_pools",
  env: lighterEnv,
  call: callSchema,
  async *extract(env) {
    const lighter = createLighterClient(env, clock);
    const readAt = clock.now();
    let index = TOP_INDEX;
    for (let page = 0; ; page++) {
      const batch: Batch<PoolsCall> = { records: [], failed: [] };
      let pools: z.infer<typeof poolEntry>[];
      try {
        if (page >= MAX_PAGES) throw new Error(`Lighter's publicPoolsMetadata gave ${MAX_PAGES} pages without a short one`);
        const query = { filter: "all", index, limit: PAGE_SIZE };
        pools = (await lighter.get("/api/v1/publicPoolsMetadata", query, poolsReply)).public_pools;
        // The reply lists pools below `index`, so a page that reaches it would repeat for ever.
        const top = pools[0]?.account_index;
        if (top !== undefined && top >= index) {
          throw new Error(`Lighter's publicPoolsMetadata answered index ${index} with a pool at ${top}, not below it`);
        }
      } catch (error) {
        batch.failed.push({ id: CALL_ID, call: { kind: CALL_ID }, error: describeError(error) });
        yield batch;
        return;
      }
      const last = pools.length < PAGE_SIZE;
      for (const pool of pools) {
        batch.records.push({ id: `${pool.account_index}:${readAt}`, callId: last ? CALL_ID : `${CALL_ID}#${page}`, data: { read_at: readAt, pool } });
      }
      if (last) {
        // A last page with no pools carries no call id, so name it here to clear a dead letter.
        batch.succeededCallIds = [CALL_ID];
        yield batch;
        return;
      }
      yield batch;
      // catalog/vendors/lighter/vendor.yaml (public_pools_metadata.index): the cursor is exclusive, so the
      // next page starts at this page's last account_index. Taking 1 off it would skip a pool at each edge.
      index = pools[pools.length - 1]!.account_index;
    }
  },
});

export const lighterPublicPools = publicPoolsSource();
