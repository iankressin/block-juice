import { runSource } from "@ingestion/lib";
import { ethereumErc20Balances } from "#src/source.ts";

await runSource(ethereumErc20Balances);
