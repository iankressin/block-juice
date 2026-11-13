import { createHash } from "node:crypto";
import type { Query } from "#src/warehouse/index.ts";

/** Only dataset settings belong here. Credentials and operational limits never do. */
export type StreamProvenance = {
  version: 1;
  source: string;
  table: string;
  startBlock: number;
  datasetHash: string;
  filter: Record<string, string[]>;
  unrestricted: string[];
  settings: Record<string, number>;
  backfill?: string;
};

const canonical = (value: unknown): string => {
  // Arrays in these contracts are filter sets, matching normalized provenance filters.
  if (Array.isArray(value)) return JSON.stringify([...new Set(value.map(canonical))].sort());
  if (value && typeof value === "object") {
    return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return JSON.stringify(value);
};

export const fingerprint = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");

export function streamProvenance(
  source: { name: string; table: string; coverage?: { unrestricted: string[] } },
  env: unknown,
  inputs: Record<string, unknown>,
): StreamProvenance | undefined {
  if (!source.coverage || !env || typeof env !== "object") return undefined;
  const settings = env as Record<string, unknown>;
  if (typeof settings.START_BLOCK !== "number" || typeof settings.PORTAL_URL !== "string") return undefined;
  const filter: Record<string, string[]> = {};
  for (const [path, value] of Object.entries(inputs)) {
    if (!path.endsWith("addresses.json") || !value || typeof value !== "object") continue;
    for (const [key, values] of Object.entries(value)) {
      const list = typeof values === "string" ? [values] : values;
      if (!Array.isArray(list) || !list.every((item) => typeof item === "string")) {
        throw new Error(`Cannot record coverage for ${path}: ${key} must contain addresses`);
      }
      filter[key] = [...new Set(list.map((item: string) => item.toLowerCase()))].sort();
    }
  }
  return {
    version: 1, source: source.name, table: source.table,
    startBlock: settings.START_BLOCK,
    datasetHash: createHash("sha256").update(settings.PORTAL_URL).digest("hex"),
    filter, unrestricted: source.coverage.unrestricted,
    settings: typeof settings.POOLS_START_BLOCK === "number"
      ? { POOLS_START_BLOCK: settings.POOLS_START_BLOCK } : {},
    ...(process.env.SOURCE_BACKFILL_ID ? { backfill: process.env.SOURCE_BACKFILL_ID } : {}),
  };
}

/** Additive: upgrading never resets a raw table or adopts an unevidenced legacy cursor. */
export async function prepareProvenance(q: Query, raw: string): Promise<void> {
  await q.query(`create table if not exists ${raw}."_coverage" (
    source_table text not null, fingerprint text not null, from_block bigint not null,
    to_block bigint not null, config jsonb not null, verified boolean not null,
    updated_at timestamptz not null default now(),
    primary key (source_table, fingerprint, from_block), check (to_block >= from_block)
  )`);
  await q.query(`create table if not exists ${raw}."_source_configurations" (
    source_table text not null, fingerprint text not null, cursor_id text not null,
    config jsonb not null, created_at timestamptz not null default now(),
    primary key (source_table, fingerprint)
  )`);
}

/** Existing installations keep their cursor. Every later contract gets independent backfill progress. */
export async function configureStream(q: Query, raw: string, sourceTable: string, config: StreamProvenance) {
  const hash = fingerprint(config);
  const { rows } = await q.query<{ fingerprint: string; cursor_id: string }>(
    `select fingerprint, cursor_id from ${raw}."_source_configurations" where source_table = $1`, [sourceTable]);
  const existing = rows.find((row) => row.fingerprint === hash);
  if (existing) return existing.cursor_id;
  const cursorId = rows.length === 0 && !config.backfill ? sourceTable : `${sourceTable}_${hash.slice(0, 24)}`;
  await q.query(`insert into ${raw}."_source_configurations" (source_table, fingerprint, cursor_id, config)
    values ($1, $2, $3, $4::jsonb)`, [sourceTable, hash, cursorId, JSON.stringify(config)]);
  return cursorId;
}

/** Called inside the same transaction as the records and Pipes cursor, including empty batches. */
export async function recordCoverage(
  q: Query, raw: string, sourceTable: string, config: StreamProvenance, first: number, last: number,
  fresh: boolean,
): Promise<void> {
  if (first > last) return;
  const hash = fingerprint(config);
  // A filtered factory cache must have witnessed its pool-creation history under this contract.
  // A legacy resumed cache has no such evidence; an explicit backfill creates a fresh generation.
  let verified = config.settings.POOLS_START_BLOCK === undefined
    || (fresh && first <= config.settings.POOLS_START_BLOCK);
  if (!verified) {
    const { rows } = await q.query(`select 1 from ${raw}."_coverage"
      where source_table = $1 and fingerprint = $2 and to_block = $3 - 1 and verified`,
    [sourceTable, hash, first]);
    verified = rows.length > 0;
  }
  const updated = await q.query(`update ${raw}."_coverage" set to_block = $4, updated_at = now()
    where source_table = $1 and fingerprint = $2 and to_block = $3 - 1 and verified = $5 returning from_block`,
  [sourceTable, hash, first, last, verified]);
  if (updated.rows.length) return;
  await q.query(`insert into ${raw}."_coverage" (source_table, fingerprint, from_block, to_block, config, verified)
    values ($1, $2, $3, $4, $5::jsonb, $6)
    on conflict (source_table, fingerprint, from_block) do update
      set to_block = greatest(${raw}."_coverage".to_block, excluded.to_block), updated_at = now()`,
  [sourceTable, hash, first, last, JSON.stringify(config), verified]);
}
