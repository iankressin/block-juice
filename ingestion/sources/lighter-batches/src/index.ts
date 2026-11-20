import { runSource } from "@ingestion/lib";
import { lighterBatches } from "#src/source.ts";

await runSource(lighterBatches);
