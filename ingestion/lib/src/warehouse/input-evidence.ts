import { createHash } from "node:crypto";
import type { JsonInputFiles } from "#src/json.ts";
import type { Query } from "#src/warehouse/index.ts";
import { fingerprint } from "#src/warehouse/provenance.ts";
import { logger } from "#src/logger.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const sensitive = /(?:KEY|SECRET|PASSWORD|AUTH|CREDENTIAL|PRIVATE|TOKEN)/i;
const publicText = /^(?:BLOCK_NUMBER|CANDLE_INTERVAL|GAMMA_END_DATE_FROM|SOURCE_BACKFILL_ID)$/;

/** Parsed source settings, with credentials omitted and provider URL paths/query/userinfo hashed. */
export function inputEvidence(
  source: { name: string; table: string }, environment: unknown, files: JsonInputFiles, complete: boolean,
) {
  const safe: Record<string, unknown> = {};
  const redacted: string[] = [];
  for (const [key, value] of Object.entries((environment ?? {}) as object)) {
    if (value === undefined) continue;
    if (sensitive.test(key)) { redacted.push(key); continue; }
    if (/_URL$/i.test(key) && typeof value === "string") {
      let origin: string | undefined;
      try { origin = new URL(value).origin; } catch { /* Custom source schemas may allow relative endpoints. */ }
      safe[key] = { ...(origin ? { origin } : {}), sha256: hash(value) };
    } else if (typeof value === "number" || typeof value === "boolean" || publicText.test(key)) {
      safe[key] = value;
    } else {
      try { safe[key] = { sha256: hash(JSON.stringify(value) ?? String(value)) }; }
      catch { redacted.push(key); }
    }
  }
  return {
    version: 1, scope: "ingestion_run", source: { name: source.name, table: source.table },
    environment: safe, redacted_keys: redacted.sort(), files: files.files,
    complete: complete && !files.truncated, truncated: files.truncated,
  };
}

export type InputEvidence = ReturnType<typeof inputEvidence>;

/** Metadata is optional for existing warehouse roles. Isolate its failure from a data transaction. */
async function optionalEvidence(q: Query, transaction: boolean, write: () => Promise<unknown>): Promise<boolean> {
  if (transaction) await q.query("savepoint ingestion_input_evidence");
  try {
    await write();
    if (transaction) await q.query("release savepoint ingestion_input_evidence");
    return true;
  } catch {
    if (transaction) {
      // If the connection itself broke, rollback also fails and the data transaction still fails.
      await q.query("rollback to savepoint ingestion_input_evidence");
      await q.query("release savepoint ingestion_input_evidence");
    }
    logger.warn("Could not record ingestion input evidence; provenance remains incomplete");
    return false;
  }
}

export async function prepareInputEvidence(q: Query, raw: string): Promise<boolean> {
  return optionalEvidence(q, true, () => q.query(`create table if not exists ${raw}."_ingestion_inputs" (
    run_id text not null, source_table text not null, config_hash text not null,
    evidence jsonb not null, updated_at timestamptz not null default now(),
    primary key (run_id, source_table)
  )`));
}

export async function recordInputEvidence(
  q: Query, raw: string, sourceTable: string, runId: string, evidence: InputEvidence, transaction = true,
): Promise<boolean> {
  const { complete: _complete, ...config } = evidence;
  return optionalEvidence(q, transaction, () => q.query(`insert into ${raw}."_ingestion_inputs" (run_id, source_table, config_hash, evidence)
    values ($1, $2, $3, $4::jsonb) on conflict (run_id, source_table)
    do update set config_hash = excluded.config_hash, evidence = excluded.evidence, updated_at = now()`,
  [runId, sourceTable, fingerprint(config), JSON.stringify(evidence)]));
}
