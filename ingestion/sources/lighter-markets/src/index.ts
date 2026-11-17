import { runSource } from "@ingestion/lib";
import { lighterMarkets } from "#src/source.ts";

await runSource(lighterMarkets);
