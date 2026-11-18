import { runSource } from "@ingestion/lib";
import { lighterSystemConfig } from "#src/source.ts";

await runSource(lighterSystemConfig);
