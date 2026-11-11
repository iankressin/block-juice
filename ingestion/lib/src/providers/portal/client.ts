import { PortalClient } from "@subsquid/pipes/portal-client";

/**
 * A client for one Portal dataset that reads finalized blocks. A PortalClient retries nothing
 * unless told to, and the SDK adds retries only to the clients it builds itself. Ten tries,
 * about two minutes, get past a busy Portal (HTTP 529) without hanging a run for good.
 *
 * With `apiKey`, every request carries it in `x-api-key`. Without one, the public Portal still
 * answers, at the limits it sets for anonymous clients.
 *
 * Requests ask for gzip only. On Node 24.4 and later the SDK also offers zstd, which Portal
 * prefers, and Node's zstd decoder stops after the first of the many frames in a Portal stream.
 * Each response then ends after a hundred blocks or so, and a dense stream crawls through one
 * request after another. The SDK sets its header after ours, so only this hook can replace it.
 */
export const portalClient = (url: string, apiKey?: string) =>
  new PortalClient({
    url,
    finalized: true,
    http: {
      retryAttempts: 10,
      headers: apiKey ? { "x-api-key": apiKey } : {},
      hooks: { onBeforeRequest: (req) => req.headers.set("accept-encoding", "gzip") },
    },
  });

/** Portal's finalized head now. A stream source ends its range there, so each run ends. */
export async function finalizedHead(portal: PortalClient): Promise<number> {
  const head = await portal.getHead({ finalized: true });
  if (!head) throw new Error(`${portal.getUrl()} reports no finalized head`);
  return head.number;
}
