import { config } from "dotenv";
import * as z from "zod";

export const blockNumber = z.union(
  [
    z.enum(["latest", "safe", "finalized"]),
    z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().max(Number.MAX_SAFE_INTEGER)),
  ],
  {
    error: (issue) =>
      issue.input === undefined
        ? "Required"
        : "Expected a block number, or latest, safe or finalized",
  },
);

export type BlockNumber = z.infer<typeof blockNumber>;

/** Reads `.env` from the working directory, then validates process.env. An empty value counts as unset. */
export function loadEnv<T extends z.ZodType>(schema: T): z.infer<T> {
  config({ quiet: true });
  const values = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== ""),
  );
  const result = schema.safeParse(values);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
