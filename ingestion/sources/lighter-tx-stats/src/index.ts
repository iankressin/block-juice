import { runSource } from "@ingestion/lib";
import { lighterTxStats } from "#src/source.ts";

await runSource(lighterTxStats);
