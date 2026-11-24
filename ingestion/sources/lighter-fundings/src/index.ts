import { runSource } from "@ingestion/lib";
import { lighterFundings } from "#src/source.ts";

await runSource(lighterFundings);
