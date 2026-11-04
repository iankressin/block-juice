import pg from "pg";
import * as z from "zod";
import { loadEnv } from "#src/env.ts";

const postgresEnvSchema = z.object({
  WAREHOUSE_HOST: z.string().min(1),
  WAREHOUSE_PORT: z.coerce.number().int().positive(),
  WAREHOUSE_USER: z.string().min(1),
  WAREHOUSE_PASSWORD: z.string(),
  WAREHOUSE_DB: z.string().min(1),
  RAW_SCHEMA: z.string().min(1),
});

export const CHUNK_SIZE = 500;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function ident(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`Invalid SQL identifier: ${name}`);
  return `"${name}"`;
}

// jsonb numbers lose precision past 2^53, so bigints (token amounts, balances) go in as strings.
export const toJson = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));

export function postgresSettings() {
  const env = loadEnv(postgresEnvSchema);
  return {
    schema: ident(env.RAW_SCHEMA),
    connect: async (setup: string[]) => {
      const client = new pg.Client({
        host: env.WAREHOUSE_HOST,
        port: env.WAREHOUSE_PORT,
        user: env.WAREHOUSE_USER,
        password: env.WAREHOUSE_PASSWORD,
        database: env.WAREHOUSE_DB,
      });
      await client.connect();
      try {
        for (const statement of setup) await client.query(statement);
      } catch (error) {
        await client.end();
        throw error;
      }
      return client;
    },
  };
}
