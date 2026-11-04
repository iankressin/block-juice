import { readFileSync } from "node:fs";
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

/** Reads `addresses.json` from the working directory, then validates it. A missing file reads as undefined. */
export function loadAddresses<T extends z.ZodType>(schema: T): z.infer<T> {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync("addresses.json", "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Invalid addresses.json: ${(error as Error).message}`);
    }
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new Error(
      json === undefined ? "addresses.json is missing" : `Invalid addresses.json:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
