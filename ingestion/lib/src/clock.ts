import { setTimeout } from "node:timers/promises";

/** Time as a client sees it, so a test can pass a wait at once. */
export type Clock = { now(): number; sleep(ms: number): Promise<void> };

export const systemClock: Clock = { now: () => Date.now(), sleep: (ms) => setTimeout(ms) };

/** A `Retry-After` header as ms to wait: seconds, or an HTTP date taken against `nowMs`. Undefined when absent or invalid. */
export function retryAfterMs(header: string | null, nowMs: number): number | undefined {
  const text = header?.trim();
  if (!text) return undefined;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  // Date.parse reads "-3" as a year, so only text that names a month can be a date.
  if (!/[a-z]/i.test(text)) return undefined;
  const date = Date.parse(text);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}
