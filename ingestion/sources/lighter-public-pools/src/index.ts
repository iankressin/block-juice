import { runSource } from "@ingestion/lib";
import { lighterPublicPools } from "#src/source.ts";

await runSource(lighterPublicPools);
