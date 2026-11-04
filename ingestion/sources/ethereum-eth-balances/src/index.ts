import { runSource } from "@ingestion/lib";
import { ethereumEthBalances } from "#src/source.ts";

await runSource(ethereumEthBalances);
