import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { createLimiter } from "#src/concurrency.ts";
import { observeRequest, observeDelay, observedFetch, transportSnapshot, withTransportMetrics } from "#src/transport-metrics.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("request metrics retain results and exact errors, and do not leak between concurrent runs", async () => {
  const gate = deferred<number>();
  const first = withTransportMetrics(async () => {
    const request = observeRequest(() => gate.promise);
    assert.equal(transportSnapshot().activeRequests, 1);
    assert.equal(transportSnapshot().requestsStarted, 1);
    assert.equal(await request, 42);
    const snapshot = transportSnapshot();
    assert.equal(snapshot.activeRequests, 0);
    assert.equal(snapshot.requestsCompleted, 1);
    assert.ok(snapshot.requestSeconds > 0);
    return snapshot;
  });
  await withTransportMetrics(async () => {
    assert.equal(transportSnapshot().requestsStarted, 0);
    const failure = new Error("original failure");
    await assert.rejects(observeRequest(() => Promise.reject(failure)), (error) => error === failure);
    assert.equal(transportSnapshot().requestsFailed, 1);
    assert.equal(transportSnapshot().requestsCompleted, 1);
    gate.resolve(42);
  });
  assert.equal((await first).requestsFailed, 0);
  assert.equal(transportSnapshot().requestsStarted, 0);
  assert.equal(await observeRequest(async () => "outside"), "outside");
  assert.equal(transportSnapshot().requestsStarted, 0);
});

test("limiter queue metrics follow the waiting run through FIFO slot transfer and failure", async () => {
  const limit = createLimiter(1);
  const gate = deferred<void>();
  const order: number[] = [];
  const first = withTransportMetrics(() => limit(() => gate.promise));
  await withTransportMetrics(async () => {
    const failure = new Error("slot failure");
    const second = limit(async () => { order.push(2); throw failure; });
    const rejected = assert.rejects(second, (error) => error === failure);
    const third = limit(async () => { order.push(3); return 3; });
    assert.equal(transportSnapshot().queuedTasks, 2);
    await sleep(5);
    gate.resolve();
    await rejected;
    assert.equal(await third, 3);
    assert.deepEqual(order, [2, 3]);
    assert.equal(transportSnapshot().queuedTasks, 0);
    assert.ok(transportSnapshot().queueWaitSeconds > 0);
  });
  await first;
});

test("HTTP error responses and network failures are measured without consuming or changing the response", async (t) => {
  const response = new Response('{"error":"rate limited"}', { status: 429 });
  const failure = new Error("network down");
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => { if (++attempts === 1) return response; throw failure; });
  await withTransportMetrics(async () => {
    const result = await observedFetch("https://example.invalid");
    assert.equal(result, response);
    assert.equal(result.bodyUsed, false);
    assert.deepEqual(await result.json(), { error: "rate limited" });
    await assert.rejects(observedFetch("https://example.invalid"), (error) => error === failure);
    const snapshot = transportSnapshot();
    assert.equal(snapshot.requestsStarted, 2);
    assert.equal(snapshot.requestsCompleted, 2);
    assert.equal(snapshot.requestsFailed, 2);
    assert.equal(snapshot.activeRequests, 0);
  });
});

test("client delay metrics use actual elapsed time and always release the waiting gauge", async () => {
  await withTransportMetrics(async () => {
    const gate = deferred<void>();
    const delay = observeDelay(() => gate.promise);
    assert.equal(transportSnapshot().delayedTasks, 1);
    await sleep(5);
    gate.resolve();
    await delay;
    assert.equal(transportSnapshot().delayedTasks, 0);
    assert.ok(transportSnapshot().delaySeconds > 0);
    const failure = new Error("aborted delay");
    await assert.rejects(observeDelay(() => Promise.reject(failure)), (error) => error === failure);
    assert.equal(transportSnapshot().delayedTasks, 0);
  });
});
