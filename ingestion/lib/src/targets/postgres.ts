import { chunk, uniqueBy } from "#src/calls.ts";
import { CHUNK_SIZE, ident, postgresSettings, toJson } from "#src/postgres.ts";
import type { Target } from "#src/types.ts";

export function postgresTarget(): Target {
  return {
    async open(tableName) {
      const { schema, connect } = postgresSettings();
      const table = `${schema}.${ident(tableName)}`;
      const client = await connect([
        `create schema if not exists ${schema}`,
        `create table if not exists ${table} (
          id text primary key,
          data jsonb not null,
          _loaded_at timestamptz not null default now()
        )`,
      ]);

      return {
        name: table,
        async write(records) {
          // Postgres rejects an upsert that touches the same id twice, so keep the last one.
          for (const part of chunk(uniqueBy(records, (r) => r.id), CHUNK_SIZE)) {
            await client.query(
              `insert into ${table} (id, data)
               select r->>'id', r->'data' from jsonb_array_elements($1::jsonb) r
               on conflict (id) do update set data = excluded.data, _loaded_at = now()`,
              [toJson(part)],
            );
          }
        },
        close: () => client.end(),
      };
    },
  };
}
