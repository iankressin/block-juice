import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fingerprint } from "#src/warehouse/provenance.ts";

/** Keep the original cache on adoption; later datasets rebuild pools in independent files. */
export function factoryCachePath(path: string, settings: {
  PORTAL_URL: string; START_BLOCK: number; POOLS_START_BLOCK: number;
}, addresses: unknown): string {
  const hash = fingerprint({
    // Advancing a window can still use pools discovered earlier. Only changing the dataset,
    // token set or explicit recovery generation needs an independent discovery cache.
    dataset: settings.PORTAL_URL,
    addresses, backfill: process.env.SOURCE_BACKFILL_ID ?? "",
  });
  const identity = `${path}.identity`;
  if (!existsSync(identity)) {
    mkdirSync(dirname(path), { recursive: true });
    // No raw settings or URLs (which may carry credentials) are written to this sidecar.
    writeFileSync(identity, hash, { flag: "wx" });
  }
  const original = readFileSync(identity, "utf8");
  return original === hash && !process.env.SOURCE_BACKFILL_ID ? path : `${path}.${hash.slice(0, 24)}`;
}
