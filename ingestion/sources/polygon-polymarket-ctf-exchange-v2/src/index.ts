import { runSource } from "@ingestion/lib";
import { polygonPolymarketCtfExchangeV2 } from "#src/source.ts";

await runSource(polygonPolymarketCtfExchangeV2);
