import { runSource } from "@ingestion/lib";
import { lighterAccounts } from "#src/source.ts";

await runSource(lighterAccounts);
