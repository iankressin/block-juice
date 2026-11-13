import { readFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

const captured = new AsyncLocalStorage<Record<string, unknown>>();

/** Capture the bytes actually used to construct a stream, not a later reread of mutable files. */
export async function captureJsonReads<T>(read: () => Promise<T>) {
  const inputs: Record<string, unknown> = {};
  const value = await captured.run(inputs, read);
  return { value, inputs };
}

/**
 * The JSON in a file, by its path from the working directory, the package's folder when a source
 * runs, as for its .env. Call it inside a run, so a bad file fails the run and runSource logs why.
 */
export function readJson(path: string): any {
  const text = readFileSync(path, "utf8");
  try {
    const value = JSON.parse(text);
    if (captured.getStore()) captured.getStore()![path] = structuredClone(value);
    return value;
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}
