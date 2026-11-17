import { runSource } from "@ingestion/lib";
import { lighterOpenInterest } from "#src/source.ts";

await runSource(lighterOpenInterest);
