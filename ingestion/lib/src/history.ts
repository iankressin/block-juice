import { createHash } from "node:crypto";
import * as z from "zod";

export const DAY_MS = 86_400_000;
export type HistoryState = { origin: number; next: number; refreshedAt: number; refreshNext?: number };
export type HistorySettings = {
  HISTORY_OVERLAP_DAYS?: number;
  HISTORY_REFRESH_DAYS?: number;
  HISTORY_FULL_REFRESH?: "0" | "1";
};

/** The settings every history source reads, to spread into its env with `.extend({ ...historyEnv.shape })`. */
export const historyEnv = z.object({
  START_TIME: z
    .union([z.iso.date(), z.iso.datetime({ offset: true })], {
      error: (issue) =>
        issue.input === undefined
          ? "Required"
          : "Expected an ISO date or datetime, such as 2026-10-01 or 2026-10-01T00:00:00Z",
    })
    .transform((value) => Date.parse(value)),
  HISTORY_OVERLAP_DAYS: z.coerce.number().int().nonnegative().optional(),
  HISTORY_REFRESH_DAYS: z.coerce.number().int().positive().optional(),
  HISTORY_FULL_REFRESH: z.enum(["0", "1"]).optional(),
});

/** Hash the complete request identity; credentials and URLs are never stored in plaintext. */
export const historyKey = (identity: unknown) => createHash("sha256").update(JSON.stringify(identity)).digest("hex");

export function historyState(value: unknown): HistoryState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const state = value as HistoryState;
  return [state.origin, state.next, state.refreshedAt].every((v) => Number.isSafeInteger(v) && v >= 0)
    && (state.refreshNext === undefined || Number.isSafeInteger(state.refreshNext) && state.refreshNext >= state.origin)
    ? state : undefined;
}

/**
 * Resume incomplete history, then revisit a recent overlap on ordinary runs. A periodic
 * full sweep also revisits old corrections; its cursor survives interruption. Completion
 * means each request either succeeded or was atomically saved as a retry, not gap-free data.
 */
export function historyPlan(
  key: string, origin: number, span: number, now: number, saved: HistoryState | undefined,
  settings: HistorySettings = {},
) {
  const state = saved ?? { origin, next: origin, refreshedAt: 0 };
  const full = !saved || saved.refreshNext !== undefined || settings.HISTORY_FULL_REFRESH === "1"
    || now - state.refreshedAt >= (settings.HISTORY_REFRESH_DAYS ?? 7) * DAY_MS;
  // The final attempted window may have contained open candles, including in older checkpoints.
  const lastWindow = Math.max(origin, state.next - span);
  const overlap = (settings.HISTORY_OVERLAP_DAYS ?? 3) * DAY_MS;
  const lower = full
    ? (settings.HISTORY_FULL_REFRESH === "1" ? origin : state.refreshNext ?? origin)
    : Math.min(lastWindow, Math.min(state.next, now) - overlap);
  const from = origin + Math.max(0, Math.floor((lower - origin) / span)) * span;
  return {
    from,
    /** Each window start this run fetches, in order. */
    *windows(): Generator<number> {
      for (let start = from; start <= now; start += span) yield start;
    },
    /** Whether a call is one of this run's own windows, so its end may save a checkpoint. */
    covers: (start: number, end: number) =>
      start >= from && start <= now && (start - from) % span === 0 && end === start + span - 1,
    checkpoint(next: number) {
      const finished = next > now;
      const value: HistoryState = { origin, next: Math.max(state.next, next),
        refreshedAt: full && finished ? now : state.refreshedAt };
      if (full && !finished) value.refreshNext = next;
      return { key, value };
    },
  };
}
