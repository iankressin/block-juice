import { readFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

export type JsonInputFiles = { files: Record<string, { sha256: string; bytes: number }[]>; truncated: boolean };
type Capture = { values: Record<string, unknown>; files: JsonInputFiles; keepValues: boolean };
const captured = new AsyncLocalStorage<Capture>();

/** Capture actual reads throughout extraction, including lazy generators and changed file versions.
 * Stream contracts also need parsed filters; call sources retain only bounded byte fingerprints.
 */
export async function captureJsonReads<T>(
  read: (inputs: Record<string, unknown>, files: JsonInputFiles) => Promise<T>, keepValues = true,
) {
  const inputs: Record<string, unknown> = Object.create(null);
  const files: JsonInputFiles = { files: Object.create(null), truncated: false };
  const value = await captured.run({ values: inputs, files, keepValues }, () => read(inputs, files));
  return { value, inputs, files };
}

/**
 * The JSON in a file, by its path from the working directory, the package's folder when a source
 * runs, as for its .env. Call it inside a run, so a bad file fails the run and runSource logs why.
 */
export function readJson(path: string | URL): any {
  const bytes = readFileSync(path);
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    const capture = captured.getStore();
    if (capture) {
      const label = typeof path === "string" ? path : relative(process.cwd(), fileURLToPath(path));
      if (capture.keepValues) capture.values[label] = structuredClone(value);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const versions = capture.files.files[label] ?? [];
      if (!versions.some((entry) => entry.sha256 === hash)) {
        // Built-ins read one small configuration file. Bound custom sources that reread many
        // changing files, and explicitly mark incomplete evidence rather than losing that fact.
        if (versions.length >= 16 || Object.keys(capture.files.files).length >= 128 && !versions.length) {
          capture.files.truncated = true;
        } else {
          versions.push({ sha256: hash, bytes: bytes.length });
          capture.files.files[label] = versions;
        }
      }
    }
    return value;
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}
