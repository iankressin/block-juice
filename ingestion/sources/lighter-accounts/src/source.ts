import { describeError, readJson, uniqueBy, type Source } from "@ingestion/lib";
import {
  accountsFileSchema,
  createLighterClient,
  lighterEnv,
  resolveAccounts,
  systemClock,
  type Clock,
  type LighterEnv,
} from "@ingestion/lib/lighter";
import * as z from "zod";

const callSchema = z.object({
  kind: z.literal("account"),
  account_index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type AccountsCall = z.infer<typeof callSchema>;

const callId = (call: AccountsCall) => `account:${call.account_index}`;

const accountReply = z.object({ accounts: z.array(z.looseObject({ index: z.number() })).min(1) });

// Reads each account in addresses.json, and each sub-account of an L1 address there, once a run. The
// reply's `accounts[0]` is kept as sent, in a record keyed by account and read time, so the models can
// set one reading against the next. `read_at` is the time `extract` starts. A retried read is the same
// as the run's own read of that account, so it runs once.
export const accountsSource = (clock: Clock = systemClock): Source<LighterEnv, AccountsCall> => ({
  name: "lighter",
  table: "accounts",
  env: lighterEnv,
  call: callSchema,
  async *extract(env, retry) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const file = accountsFileSchema.safeParse(readJson("addresses.json"));
    if (!file.success) throw new Error(`Invalid addresses.json:\n${z.prettifyError(file.error)}`);
    const lighter = createLighterClient(env, clock);
    const readAt = clock.now();
    const own = (await resolveAccounts(lighter, file.data)).map((account_index): AccountsCall => ({ kind: "account", account_index }));
    for (const call of uniqueBy([...own, ...retry], callId)) {
      try {
        const reply = await lighter.get("/api/v1/account", { by: "index", value: call.account_index });
        const parsed = accountReply.safeParse(reply);
        if (!parsed.success) {
          throw new Error(`Lighter sent account ${call.account_index} in an unexpected shape:\n${z.prettifyError(parsed.error)}`);
        }
        const [account] = parsed.data.accounts;
        yield {
          records: [{ id: `${call.account_index}:${readAt}`, callId: callId(call), data: { read_at: readAt, account } }],
          failed: [],
        };
      } catch (error) {
        yield { records: [], failed: [{ id: callId(call), call, error: describeError(error) }] };
      }
    }
  },
});

export const lighterAccounts = accountsSource();
