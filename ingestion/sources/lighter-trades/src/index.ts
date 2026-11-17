import { runSource } from "@ingestion/lib";
import { lighterTrades } from "#src/source.ts";

await runSource(lighterTrades);
