import { isAddress, type Address } from "viem";
import * as z from "zod";

/** Mixed-case addresses must carry a valid EIP-55 checksum; all-lowercase ones pass as is. */
export const address = z.custom<Address>(
  (value) => typeof value === "string" && isAddress(value),
  "Expected an Ethereum address",
);

export const toLower = (address: Address) => address.toLowerCase() as Address;
