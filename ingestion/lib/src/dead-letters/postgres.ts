import { chunk, uniqueBy } from "#src/calls.ts";
import { CHUNK_SIZE, postgresSettings, toJson } from "#src/postgres.ts";
import type { DeadLetter, DeadLetterBacklog, DeadLetterQueue } from "#src/types.ts";

export type DeadLetterQueueOptions = {
  /** After this many failed runs a dead letter is parked: kept for a person to look at, no longer retried. */
  maxAttempts?: number;
};

/** One table, <RAW_SCHEMA>._dead_letters, shared by every source and keyed by (source_table, id). */
export function postgresDeadLetterQueue({
  maxAttempts = 5,
}: DeadLetterQueueOptions = {}): DeadLetterQueue {
  return {
    async open(sourceTable) {
      const { schema, connect } = postgresSettings();
      const table = `${schema}."_dead_letters"`;
      const client = await connect([
        `create schema if not exists ${schema}`,
        `create table if not exists ${table} (
          source_table text not null,
          id text not null,
          call jsonb not null,
          error text not null,
          attempts integer not null default 1,
          parked boolean not null default false,
          first_failed_at timestamptz not null default now(),
          last_failed_at timestamptz not null default now(),
          primary key (source_table, id)
        )`,
      ]);

      return {
        name: table,
        async pending() {
          const { rows } = await client.query<DeadLetter>(
            `select id, call, error, attempts from ${table}
             where source_table = $1 and not parked
             order by first_failed_at, id`,
            [sourceTable],
          );
          return rows;
        },
        async push(failed) {
          for (const part of chunk(uniqueBy(failed, (f) => f.id), CHUNK_SIZE)) {
            await client.query(
              `insert into ${table} as t (source_table, id, call, error, parked)
               select $1, f->>'id', f->'call', f->>'error', $2::integer <= 1
               from jsonb_array_elements($3::jsonb) f
               on conflict (source_table, id) do update set
                 call = excluded.call,
                 error = excluded.error,
                 attempts = t.attempts + 1,
                 parked = t.attempts + 1 >= $2::integer,
                 last_failed_at = now()`,
              [
                sourceTable,
                maxAttempts,
                toJson(part),
              ],
            );
          }
        },
        async park(letters) {
          await client.query(
            `update ${table} as t set parked = true, error = l->>'error'
             from jsonb_array_elements($2::jsonb) l
             where t.source_table = $1 and t.id = l->>'id'`,
            [sourceTable, toJson(letters)],
          );
        },
        async resolve(ids) {
          if (ids.length === 0) return;
          await client.query(
            `delete from ${table} where source_table = $1 and id = any($2::text[])`,
            [sourceTable, ids],
          );
        },
        async backlog() {
          const { rows } = await client.query<DeadLetterBacklog>(
            `select count(*) filter (where not parked)::integer as pending,
                    count(*) filter (where parked)::integer as parked
             from ${table} where source_table = $1`,
            [sourceTable],
          );
          return rows[0]!;
        },
        close: () => client.end(),
      };
    },
  };
}
