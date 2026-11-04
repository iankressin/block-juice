import { PortalClient } from "@subsquid/pipes/portal-client";

/**
 * A client for one Portal dataset that reads finalized blocks. A PortalClient retries nothing
 * unless told to, and the SDK adds retries only to the clients it builds itself. Ten tries,
 * about two minutes, get past a busy Portal (HTTP 529) without hanging a run for good.
 */
export const portalClient = (url: string) =>
  new PortalClient({ url, finalized: true, http: { retryAttempts: 10 } });

/** Portal's finalized head now. A stream source ends its range there, so each run ends. */
export async function finalizedHead(portal: PortalClient): Promise<number> {
  const head = await portal.getHead({ finalized: true });
  if (!head) throw new Error(`${portal.getUrl()} reports no finalized head`);
  return head.number;
}
