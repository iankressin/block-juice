import { isAddress, type Address } from "@solana/kit";
import * as z from "zod";

/** Solana addresses are case-sensitive base58, so they are kept exactly as written. */
export const solanaAddress = z.custom<Address>(
  (value) => typeof value === "string" && isAddress(value),
  "Expected a Solana address",
);
