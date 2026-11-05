/**
 * Writes ingestion/sources.json: the exported `name` and `table` of every source package, with its
 * folder under ingestion/sources/, sorted by name then table. Dagster builds its SOURCES from this
 * file, and the orchestration tests fail when it falls behind the code.
 *
 * Run it with `pnpm generate-sources` from ingestion/ after adding or renaming a source. An optional
 * argument writes the list somewhere else, which is how the freshness test compares it.
 *
 * It imports each package's src/source.ts, which must be free of side effects, and never src/index.ts,
 * which runs the source. The export's name varies by package, so the Source is found by shape.
 */

import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type SourceEntry = { name: string; table: string; package: string };

const ingestionDir = path.resolve(import.meta.dirname, "..");
const sourcesDir = path.join(ingestionDir, "sources");
const out = path.resolve(process.argv[2] ?? path.join(ingestionDir, "sources.json"));

function isSource(value: unknown): value is { name: string; table: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { table?: unknown }).table === "string"
  );
}

async function sourceOf(pkg: string): Promise<SourceEntry> {
  const file = path.join(sourcesDir, pkg, "src", "source.ts");
  const exports: Record<string, unknown> = await import(pathToFileURL(file).href);
  const sources = Object.entries(exports).filter(([, value]) => isSource(value));
  if (sources.length !== 1) {
    const found = sources.map(([key]) => key).join(", ") || "none";
    throw new Error(`${path.relative(ingestionDir, file)} must export exactly one Source, found ${found}`);
  }
  const [[, source]] = sources as [[string, { name: string; table: string }]];
  return { name: source.name, table: source.table, package: pkg };
}

const packages = (await readdir(sourcesDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
  .map((entry) => entry.name)
  .sort();
const entries: SourceEntry[] = [];
for (const pkg of packages) {
  entries.push(await sourceOf(pkg));
}
entries.sort((a, b) => a.name.localeCompare(b.name) || a.table.localeCompare(b.table));

const seen = new Map<string, string>();
for (const { name, table, package: pkg } of entries) {
  const key = `${name}.${table}`;
  const other = seen.get(key);
  if (other) throw new Error(`${other} and ${pkg} both export ${key}`);
  seen.set(key, pkg);
}

await writeFile(out, JSON.stringify(entries, null, 2) + "\n");
console.log(`wrote ${entries.length} sources to ${path.relative(process.cwd(), out) || out}`);
