import { runSource } from "@ingestion/lib";
import { solanaBlockHeaders } from "#src/source.ts";

await runSource(solanaBlockHeaders);
