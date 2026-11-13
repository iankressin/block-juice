import {
  finalizedHead,
  logger,
  portalClient,
  readJson,
  type RawRecord,
  type StreamSource,
} from "@ingestion/lib";
import { address, toLower } from "@ingestion/lib/evm";
import { defineAbi, evmEventDecoder, evmPortalStream, type DecodedEvent, type JsonAbiItem } from "@subsquid/pipes/evm";
import * as z from "zod";
import autoRedeemerAbi from "../../../../catalog/protocols/polymarket/abis/auto-redeemer.json" with { type: "json" };
import collateralAdapterAbi from "../../../../catalog/protocols/polymarket/abis/collateral-adapter.json" with { type: "json" };
import conditionalTokensAbi from "../../../../catalog/protocols/polymarket/abis/conditional-tokens.json" with { type: "json" };
import negRiskAdapterAbi from "../../../../catalog/protocols/polymarket/abis/neg-risk-adapter.json" with { type: "json" };

// The catalog's ABI files are JSON, so their events are typed by name only.
const abiEvents = (abi: unknown) => defineAbi(abi as readonly JsonAbiItem[]).events;
const ctf = abiEvents(conditionalTokensAbi);
const negRisk = abiEvents(negRiskAdapterAbi);
const collateralAdapter = abiEvents(collateralAdapterAbi);
const autoRedeemer = abiEvents(autoRedeemerAbi);

const env = z.object({
  PORTAL_URL: z.url().default("https://portal.sqd.dev/datasets/polygon-mainnet"),
  // Sent with every Portal request when set. Without one, the public Portal answers at its anonymous limits.
  PORTAL_API_KEY: z.string().optional(),
  // Where the first run starts. Later runs resume after the cursor Pipes keeps in the warehouse.
  START_BLOCK: z.coerce.number().int().nonnegative(),
  // The last block to read, set only to check a short window. Unset, each run ends at Portal's finalized head.
  END_BLOCK: z.coerce.number().int().positive().optional(),
});

export type CtfEnv = z.infer<typeof env>;

const addresses = z.object({
  conditional_tokens: address,
  neg_risk_adapter: address,
  collateral_adapters: z.array(address).min(1),
  auto_redeemers: z.array(address).min(1),
  wallets: z.array(address).min(1).optional(),
});

// Each record is one log as Portal returns it, unique by its block and its index in that block. Its event
// is the catalog's key, which names the contract group, because three groups emit a PositionSplit.
function logRecord(event: string, log: DecodedEvent<Record<string, unknown>>): RawRecord {
  const id = `${log.block.number}:${log.rawEvent.logIndex}`;
  return {
    id,
    callId: id,
    data: {
      kind: "log",
      event,
      block_number: log.block.number,
      timestamp: log.timestamp.toISOString(),
      tx_hash: log.rawEvent.transactionHash,
      log_index: log.rawEvent.logIndex,
      contract: log.contract,
      args: log.event,
    },
  };
}

// A decoder's output maps each event name to its logs.
const records = (prefix: string) => (logs: Record<string, DecodedEvent<Record<string, unknown>>[]>) =>
  Object.entries(logs).flatMap(([name, found]) => found.map((log) => logRecord(`${prefix}.${name}`, log)));

/**
 * The position ledger of Polymarket's CTF era on Polygon, as emitted, from START_BLOCK to Portal's
 * finalized head when the run starts: ConditionalTokens, the NegRiskAdapter, pUSD's collateral adapters
 * and the auto-redeemers, each decoded with its own ABI.
 *
 * With `wallets` in addresses.json, a split, merge, redemption or conversion loads only when its wallet
 * argument is listed. Conditions, resolutions and neg-risk markets always load whole.
 *
 * A decoder reads one contract group, so a log is named by the group that emitted it. The collateral
 * adapter's PositionSplit has the NegRiskAdapter's topic0, and the address is the only way to tell them
 * apart. Which wallet, collateral or condition matters is left to dbt. The ConditionalTokens transfers
 * are not loaded: the adapters that predate the current ones move positions without these events
 * (catalog/protocols/polymarket/NOTES.md, Q5).
 */
export const polygonPolymarketCtf: StreamSource<CtfEnv> = {
  name: "polygon",
  table: "polymarket_ctf",
  coverage: { unrestricted: ["wallets"] },
  env,
  async stream(env) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const listed = addresses.parse(readJson("addresses.json"));
    const wallets = listed.wallets?.map(toLower);
    const byWallet = <E, P extends string>(event: E, param: P) =>
      wallets ? { event, params: { [param]: wallets } as Record<P, string[]> } : event;
    const portal = portalClient(env.PORTAL_URL, env.PORTAL_API_KEY);
    const range = { from: env.START_BLOCK, to: Math.min(env.END_BLOCK ?? Infinity, await finalizedHead(portal)) };

    return evmPortalStream({
      id: `${this.name}_${this.table}`,
      portal,
      logger: logger.child({ source: this.name, table: this.table }),
      outputs: {
        ctf: evmEventDecoder({
          range,
          contracts: [toLower(listed.conditional_tokens)],
          events: {
            ConditionPreparation: ctf.ConditionPreparation!,
            ConditionResolution: ctf.ConditionResolution!,
            PositionSplit: byWallet(ctf.PositionSplit!, "stakeholder"),
            PositionsMerge: byWallet(ctf.PositionsMerge!, "stakeholder"),
            PayoutRedemption: byWallet(ctf.PayoutRedemption!, "redeemer"),
          },
        }).pipe(records("ctf")),
        negRisk: evmEventDecoder({
          range,
          contracts: [toLower(listed.neg_risk_adapter)],
          events: {
            MarketPrepared: negRisk.MarketPrepared!,
            QuestionPrepared: negRisk.QuestionPrepared!,
            OutcomeReported: negRisk.OutcomeReported!,
            PositionSplit: byWallet(negRisk.PositionSplit!, "stakeholder"),
            PositionsMerge: byWallet(negRisk.PositionsMerge!, "stakeholder"),
            PositionsConverted: byWallet(negRisk.PositionsConverted!, "stakeholder"),
            PayoutRedemption: byWallet(negRisk.PayoutRedemption!, "redeemer"),
          },
        }).pipe(records("neg_risk")),
        collateralAdapters: evmEventDecoder({
          range,
          contracts: listed.collateral_adapters.map(toLower),
          events: {
            PositionSplit: byWallet(collateralAdapter.PositionSplit!, "initiator"),
            PositionsMerged: byWallet(collateralAdapter.PositionsMerged!, "initiator"),
            PositionsRedeemed: byWallet(collateralAdapter.PositionsRedeemed!, "initiator"),
            PositionsConverted: byWallet(collateralAdapter.PositionsConverted!, "initiator"),
          },
        }).pipe(records("collateral_adapter")),
        autoRedeemers: evmEventDecoder({
          range,
          contracts: listed.auto_redeemers.map(toLower),
          events: {
            BinaryRedemption: byWallet(autoRedeemer.BinaryRedemption!, "from"),
            NegRiskRedemption: byWallet(autoRedeemer.NegRiskRedemption!, "from"),
          },
        }).pipe(records("auto_redeemer")),
      },
    });
  },
};
