import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("importing @ingestion/lib/lighter leaves DuckDB unloaded, and importing the S3 reader loads it", () => {
  // A fresh process, since this one may have loaded DuckDB already. The S3 import shows the check can see DuckDB.
  const loaded = `process.report.getReport().sharedObjects.some((path) => path.includes("duckdb"))`;
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(import.meta.resolve("#src/lighter/index.ts"))});
       const afterIndex = ${loaded};
       await import(${JSON.stringify(import.meta.resolve("#src/lighter/s3.ts"))});
       console.log(JSON.stringify({ afterIndex, afterS3: ${loaded} }));`,
    ],
    { env: { ...process.env, LOG_LEVEL: "silent" }, encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { afterIndex: false, afterS3: true });
});
