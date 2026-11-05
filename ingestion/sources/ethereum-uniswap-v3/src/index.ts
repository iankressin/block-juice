import { runSource } from "@ingestion/lib";
import { ethereumUniswapV3 } from "#src/source.ts";

await runSource(ethereumUniswapV3);
