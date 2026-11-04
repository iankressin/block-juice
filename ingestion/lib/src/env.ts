import { config } from "dotenv";
import * as z from "zod";

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
