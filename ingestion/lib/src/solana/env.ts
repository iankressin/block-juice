import * as z from "zod";

export const solanaEnv = z.object({ ERPC_URL: z.url() });

export type SolanaEnv = z.infer<typeof solanaEnv>;
