import { runSource } from "@ingestion/lib";
import { ethereumUniswapV4 } from "#src/source.ts";

await runSource(ethereumUniswapV4);
