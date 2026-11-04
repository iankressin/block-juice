import { runSource } from "@ingestion/lib";
import { ethereumErc20Transfers } from "#src/source.ts";

await runSource(ethereumErc20Transfers);
