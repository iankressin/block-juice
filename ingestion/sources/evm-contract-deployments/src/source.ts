import { finalizedHead, logger, portalClient, type RawRecord, type StreamSource } from "@ingestion/lib";
import { evmPortalStream, evmQuery } from "@subsquid/pipes/evm";
import * as z from "zod";

const env = z.object({
  // The chain's Portal dataset, set in chains/<chain>/.env.example.
  PORTAL_URL: z.url(),
  // Sent with every Portal request when set. Without one, the public Portal answers at its anonymous limits.
  PORTAL_API_KEY: z.string().optional(),
  // Where the first run starts; later runs resume after the cursor Pipes keeps in the warehouse.
  START_BLOCK: z.coerce.number().int().nonnegative(),
  // The last block to read, set only to check a short window. Unset, each run ends at Portal's finalized head.
  END_BLOCK: z.coerce.number().int().positive().optional(),
});

export type ContractDeploymentsEnv = z.infer<typeof env>;

/** A chain name as SOURCES and the dbt sources spell it, such as `ethereum`. */
export const chainName = z.string().regex(/^[a-z][a-z0-9]*$/, "Expected a chain name such as ethereum");

// Pipes 1.0.0-beta.11 types no prev or next in a state diff's field selection, yet Portal returns both when
// asked, and the new-slot rule in dbt needs them.
const stateDiffFields = { transactionIndex: true, address: true, key: true, kind: true, prev: true, next: true } as {
  transactionIndex: true;
  address: true;
  key: true;
  kind: true;
};

const query = (range: { from: number; to: number }) =>
  evmQuery()
    .addFields({
      block: { number: true, timestamp: true },
      transaction: {
        transactionIndex: true,
        hash: true,
        from: true,
        to: true,
        sighash: true,
        type: true,
        status: true,
        gasUsed: true,
      },
      trace: {
        type: true,
        transactionIndex: true,
        traceAddress: true,
        subtraces: true,
        error: true,
        createFrom: true,
        createValue: true,
        createResultAddress: true,
        createResultCode: true,
        callFrom: true,
        callTo: true,
        callCallType: true,
        callSighash: true,
      },
      stateDiff: stateDiffFields,
    })
    // Every create trace, with the frames above it, whose errors decide whether the create stood, and its
    // transaction.
    .addTraceRequest({ range, request: { type: ["create"], parents: true, transaction: true } })
    // A trace request cannot ask for its transaction's state diffs, so Portal sends them all and the
    // transform below keeps those of the transactions that have a create trace.
    .addStateDiffRequest({ range, request: {} });

type Block = {
  header: { number: number; timestamp: number };
  transactions: Array<Record<string, unknown> & { transactionIndex: number; hash: string }>;
  traces: Array<{
    type: string;
    transactionIndex: number;
    traceAddress: number[];
    subtraces: number;
    error: string | null;
    revertReason?: string;
    action?: Record<string, unknown>;
    result?: Record<string, unknown>;
  }>;
  stateDiffs: Array<{ transactionIndex: number; address: string; key: string; kind: string; prev?: string; next?: string }>;
};

// Each record is one item as Portal returns it, keyed by its place in the chain: a transaction by its
// hash, a trace by its block, transaction index and trace address, a state diff by its block, transaction
// index, address and key.
export function blockRecords(block: Block): RawRecord[] {
  const number = block.header.number;
  const timestamp = new Date(block.header.timestamp * 1000).toISOString();
  const deployments = new Set(block.traces.filter((t) => t.type === "create").map((t) => t.transactionIndex));
  const record = (id: string, data: Record<string, unknown>): RawRecord => ({
    id,
    callId: id,
    data: { ...data, block_number: number, timestamp },
  });
  return [
    ...block.transactions
      .filter((tx) => deployments.has(tx.transactionIndex))
      .map((tx) => record(`tx:${tx.hash}`, { kind: "transaction", ...tx })),
    ...block.traces
      .filter((t) => deployments.has(t.transactionIndex))
      .map((t) =>
        record(`${number}:${t.transactionIndex}:trace:${t.traceAddress.join(".")}`, {
          kind: "trace",
          trace_type: t.type,
          transaction_index: t.transactionIndex,
          trace_address: t.traceAddress,
          subtraces: t.subtraces,
          error: t.error,
          revert_reason: t.revertReason ?? null,
          action: t.action ?? null,
          result: t.result ?? null,
        }),
      ),
    ...block.stateDiffs
      .filter((d) => deployments.has(d.transactionIndex))
      .map((d) =>
        record(`${number}:${d.transactionIndex}:diff:${d.address}:${d.key}`, {
          kind: "state_diff",
          transaction_index: d.transactionIndex,
          address: d.address,
          key: d.key,
          diff_kind: d.kind,
          prev: d.prev ?? null,
          next: d.next ?? null,
        }),
      ),
  ];
}

// Contract deployments on the chain, as Portal returns them: every transaction with at least one create
// or create2 trace, its create traces and the frames above them, and the transaction's state diffs. Failed
// creates and failed transactions are loaded too; dbt decides which creates stood. The source is named for
// its chain, so each chain loads into raw.<chain>_contract_deployments.
export const forChain = (chain: string): StreamSource<ContractDeploymentsEnv> => ({
  name: chainName.parse(chain),
  table: "contract_deployments",
  coverage: { unrestricted: [] },
  env,
  async stream(env) {
    const portal = portalClient(env.PORTAL_URL, env.PORTAL_API_KEY);
    const range = { from: env.START_BLOCK, to: Math.min(env.END_BLOCK ?? Infinity, await finalizedHead(portal)) };

    return evmPortalStream({
      id: `${this.name}_${this.table}`,
      portal,
      logger: logger.child({ source: this.name, table: this.table }),
      outputs: { blocks: query(range) },
    }).pipe({
      transform: ({ blocks }) => (blocks as unknown as Block[]).flatMap(blockRecords),
    });
  },
});
