import { runSource } from "@ingestion/lib";
import { lighterAccountLogs } from "#src/source.ts";

await runSource(lighterAccountLogs);
