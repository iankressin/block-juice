import { runSource } from "@ingestion/lib";
import { polymarketMarkets } from "#src/source.ts";

await runSource(polymarketMarkets);
