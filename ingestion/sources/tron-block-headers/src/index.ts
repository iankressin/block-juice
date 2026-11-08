import { runSource } from "@ingestion/lib";
import { tronBlockHeaders } from "#src/source.ts";

await runSource(tronBlockHeaders);
