import { runSource } from "@ingestion/lib";
import { ethereumUniswapV2 } from "#src/source.ts";

await runSource(ethereumUniswapV2);
