import { runSource } from "@ingestion/lib";
import { lighterCandles } from "#src/source.ts";

await runSource(lighterCandles);
