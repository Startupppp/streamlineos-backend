import { isAfterCommitWork, runAfterCommitWork } from "src/common/observability/after-commit-work";
import { DeferredDownstreamCapture } from "./deferred-downstream-capture";
import { DownstreamCounter, measureOnce } from "./route-budget-http-harness";

describe("deferred downstream accounting", () => {
  it("keeps deferred provider calls out of the request ceiling without dropping them", async () => {
    const fetch = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const counter = new DownstreamCounter();
    counter.install();
    try {
      const sample = await measureOnce(async () => {
        await globalThis.fetch("https://request.example/read");
        void runAfterCommitWork(async () => {
          await Promise.resolve();
          await globalThis.fetch("https://deferred.example/publish?credential=private");
        });
        return { status: 200, bytes: 2 };
      }, counter, { measureHeap: false });
      expect(sample.downstreamCalls).toBe(1);
      expect(sample.deferredDownstreamCalls).toBe(1);
      expect(sample.deferredDownstreamTargets).toEqual({ "https://deferred.example": 1 });
      expect(sample.deferredFailures).toBe(0);
      const next = await measureOnce(async () => ({ status: 200, bytes: 2 }), counter, { measureHeap: false });
      expect(next.downstreamCalls).toBe(0);
      expect(next.deferredDownstreamCalls).toBe(0);
    } finally {
      counter.restore();
      fetch.mockRestore();
    }
  });

  it("preserves the phase across awaits and drains every registered effect", async () => {
    const capture = new DeferredDownstreamCapture();
    capture.install();
    try {
      const completion = runAfterCommitWork(async () => {
        await Promise.resolve();
        expect(isAfterCommitWork()).toBe(true);
        capture.record("https://provider.example");
        await runAfterCommitWork(async () => {
          capture.record("https://provider.example");
        });
      });
      expect(isAfterCommitWork()).toBe(false);
      expect(() => capture.reset()).toThrow("pending");
      await capture.drain();
      await completion;
      expect(capture.snapshot()).toEqual({
        calls: 2, failures: 0, targets: { "https://provider.example": 2 },
      });
      capture.reset();
      expect(capture.snapshot()).toEqual({ calls: 0, failures: 0, targets: {} });
    } finally {
      capture.restore();
    }
  });

  it("records a rejected effect while preserving its rejection for the caller", async () => {
    const capture = new DeferredDownstreamCapture();
    capture.install();
    try {
      const completion = runAfterCommitWork(async () => {
        throw new Error("provider unavailable");
      });
      await expect(completion).rejects.toThrow("provider unavailable");
      await capture.drain();
      expect(capture.snapshot().failures).toBe(1);
    } finally {
      capture.restore();
    }
  });
});
