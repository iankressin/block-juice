import { setTimeout } from "node:timers/promises";

/** Time as a client sees it, so a test can pass a retry's wait at once. */
export type Clock = { now(): number; sleep(ms: number): Promise<void> };

export const systemClock: Clock = { now: () => Date.now(), sleep: (ms) => setTimeout(ms) };
