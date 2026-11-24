import { runSource } from "@ingestion/lib";
import { lighterExchangeMetrics } from "#src/source.ts";

await runSource(lighterExchangeMetrics);
