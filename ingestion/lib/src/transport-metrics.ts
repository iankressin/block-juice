import { AsyncLocalStorage } from "node:async_hooks";

export type TransportMetrics = {
  requestsStarted: number; requestsCompleted: number; requestsFailed: number;
  activeRequests: number; requestSeconds: number;
  queuedTasks: number; queueWaitSeconds: number; delayedTasks: number; delaySeconds: number;
};

const empty = (): TransportMetrics => ({ requestsStarted: 0, requestsCompleted: 0, requestsFailed: 0,
  activeRequests: 0, requestSeconds: 0, queuedTasks: 0, queueWaitSeconds: 0, delayedTasks: 0, delaySeconds: 0 });
const context = new AsyncLocalStorage<TransportMetrics>();

/** Fixed-size per-run state; no endpoint labels, request retention, or global accumulation. */
export function withTransportMetrics<T>(task: () => T): T {
  return context.run(empty(), task);
}

export function transportSnapshot(): TransportMetrics {
  return { ...(context.getStore() ?? empty()) };
}

/** Measures one transport attempt, preserving its return value and original error. */
export async function observeRequest<T>(request: () => Promise<T>): Promise<T> {
  const metrics = context.getStore();
  if (!metrics) return request();
  const started = performance.now();
  metrics.requestsStarted++;
  metrics.activeRequests++;
  try {
    return await request();
  } catch (error) {
    metrics.requestsFailed++;
    throw error;
  } finally {
    metrics.activeRequests--;
    metrics.requestsCompleted++;
    metrics.requestSeconds += (performance.now() - started) / 1000;
  }
}

/** Fetch resolves at response headers: leave body consumption and application errors to the caller. */
export function observedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const metrics = context.getStore();
  return observeRequest(async () => {
    const response = await fetch(input, init);
    if (!response.ok && metrics) metrics.requestsFailed++;
    return response;
  });
}

async function observeWait<T>(task: () => Promise<T>, gauge: "queuedTasks" | "delayedTasks",
  seconds: "queueWaitSeconds" | "delaySeconds"): Promise<T> {
  // Capture the waiting task's context: another run may eventually release its slot.
  const metrics = context.getStore();
  if (!metrics) return task();
  const started = performance.now();
  metrics[gauge]++;
  try {
    return await task();
  } finally {
    metrics[gauge]--;
    metrics[seconds] += (performance.now() - started) / 1000;
  }
}

export const observeQueue = <T>(task: () => Promise<T>): Promise<T> => observeWait(task, "queuedTasks", "queueWaitSeconds");
export const observeDelay = <T>(task: () => Promise<T>): Promise<T> => observeWait(task, "delayedTasks", "delaySeconds");
