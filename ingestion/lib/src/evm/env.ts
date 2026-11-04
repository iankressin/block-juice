import * as z from "zod";
import { blockNumber } from "#src/env.ts";

export const evmEnv = z.object({
  BLOCK_NUMBER: blockNumber,
  ERPC_URL: z.url(),
  RPC_BATCH_SIZE: z.coerce.number().int().positive().default(100),
});

export type EvmEnv = z.infer<typeof evmEnv>;
