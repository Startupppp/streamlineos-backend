import {
  DeadlineExceeded,
  contentHash,
  controlProbe,
  percentiles,
  summarise,
  tally,
  withDeadline,
  type RequestSample,
  type RouteMeasurement,
} from "./route-budget-http-harness";

/**
 * The proofs the measurement run depends on, taken without a database.
 *
 * Everything asserted here is a failure that actually happened in this release: a harness that
 * reported clean results while every request failed, a driver that parked for two and a half hours
 * with no deadline, a heap number taken without a forced collection, and a table of results that
 * silently omitted every route it never reached. The instrument is only worth its numbers if these
 * hold, so they are asserted rather than described.
 *
 * Run:
 *   node ./node_modules/jest/bin/jest.js --roots ./test/perf --runInBand \
 *     --testPathPattern route-budget-http-harness
 */
describe("route-budget HTTP harness — the properties the numbers depend on", () => {
  const ok = (status: number, body = "{}") =>
    async (): Promise<{ status: number; bytes: number; body: string }> => ({
      status,
      bytes: Buffer.byteLength(body, "utf8"),
      body,
    });

  describe("control probe", () => {
    it("passes only when the token earns a 200 AND the same route refuses an anonymous caller", async () => {
      const probe = await controlProbe(ok(200, '{"permissions":[]}'), ok(401, '{"message":"Unauthorized"}'), {
        deadlineMs: 1_000,
      });
      expect(probe.ok).toBe(true);
      expect(probe.failure).toBeNull();
      expect(probe.authenticated.status).toBe(200);
      expect(probe.anonymous.status).toBe(401);
    });

    it("REFUSES the run when the authenticated request is not a 200", async () => {
      const probe = await controlProbe(ok(401, '{"message":"Unauthorized"}'), ok(401), { deadlineMs: 1_000 });
      expect(probe.ok).toBe(false);
      expect(probe.failure).toContain("HTTP 401");
      expect(probe.failure).toContain("measuring a failure path");
    });

    it("REFUSES the run when the authenticated request 500s, rather than recording the failure path", async () => {
      const probe = await controlProbe(ok(500, '{"message":"Internal"}'), ok(401), { deadlineMs: 1_000 });
      expect(probe.ok).toBe(false);
      expect(probe.failure).toContain("HTTP 500");
    });

    /**
     * The hole a bare 200 check leaves open. A `@Public()` route answers 200 with no credential at
     * all, so a run whose token was never accepted would still see 200s — and would publish the
     * latency of the unauthenticated path under the name of the authenticated one.
     */
    it("REFUSES the run when the anonymous request ALSO succeeds, because then the 200 proves nothing", async () => {
      const probe = await controlProbe(ok(200), ok(200), { deadlineMs: 1_000 });
      expect(probe.ok).toBe(false);
      expect(probe.failure).toContain("not enforcing");
      expect(probe.failure).toContain("Refusing to score");
    });

    it("REFUSES the run when the anonymous request answers something other than 401/403", async () => {
      const probe = await controlProbe(ok(200), ok(404), { deadlineMs: 1_000 });
      expect(probe.ok).toBe(false);
      expect(probe.failure).toContain("expected 401 or 403");
    });

    it("REFUSES the run when the authenticated request never completes", async () => {
      const probe = await controlProbe(() => new Promise(() => undefined), ok(401), { deadlineMs: 50 });
      expect(probe.ok).toBe(false);
      expect(probe.failure).toContain("did not complete");
      expect(probe.failure).toContain("deadline");
    });
  });

  describe("deadline", () => {
    it("rejects a send that never settles, instead of parking the run", async () => {
      const started = Date.now();
      await expect(withDeadline(() => new Promise(() => undefined), 100, "wedged route")).rejects.toBeInstanceOf(
        DeadlineExceeded,
      );
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it("names the route and the limit in the failure, so an unmeasured route says why", async () => {
      const error: unknown = await withDeadline(() => new Promise(() => undefined), 30, "GET /whatever").catch(
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(DeadlineExceeded);
      if (!(error instanceof DeadlineExceeded)) throw new Error("expected a DeadlineExceeded");
      expect(error.message).toContain("GET /whatever");
      expect(error.message).toContain("30ms");
      expect(error.label).toBe("GET /whatever");
      expect(error.ms).toBe(30);
    });

    it("returns the value untouched when the send finishes inside the deadline", async () => {
      await expect(withDeadline(async () => "done", 1_000, "fast route")).resolves.toBe("done");
    });

    it("does not hold the event loop open after it settles", async () => {
      const before = process.hrtime.bigint();
      await withDeadline(async () => 1, 3_600_000, "long deadline");
      expect(Number(process.hrtime.bigint() - before) / 1_000_000).toBeLessThan(1_000);
    });
  });

  describe("only a 2xx is scored", () => {
    const sample = (status: number): RequestSample => ({
      status,
      ms: 5,
      bytes: 100,
      dbCalls: 3,
      gucCalls: 1,
      downstreamCalls: 0,
      heapMb: 2,
    });

    it("refuses to publish a latency for a route that answered 403", () => {
      const result = summarise([sample(403)], [], '{"message":"Forbidden"}');
      expect(result.status).toBe("unmeasured");
      expect(result.latencyMs).toBeNull();
      expect(result.responseBytes).toBeNull();
      expect(result.reason).toContain("403");
    });

    it("scores a 200 and takes the MAXIMUM db call count, because a ceiling is a ceiling", () => {
      const varied: RequestSample[] = [
        { ...sample(200), dbCalls: 3 },
        { ...sample(200), dbCalls: 7 },
      ];
      const result = summarise(varied, [{ ...sample(200), heapMb: 4 }], undefined);
      expect(result.status).toBe("measured");
      expect(result.dbCalls).toBe(7);
      expect(result.dbCallsVaried).toEqual([3, 7]);
      expect(result.memoryMb).toBe(4);
    });

    it("reports a null memory rather than guessing when no heap pass ran", () => {
      const result = summarise([sample(200)], [], undefined);
      expect(result.status).toBe("measured");
      expect(result.memoryMb).toBeNull();
    });
  });

  describe("refusal count", () => {
    const route = (status: RouteMeasurement["status"], reason?: string): RouteMeasurement => ({
      status,
      httpStatus: null,
      reason,
      samples: 0,
      latencyMs: null,
      dbCalls: null,
      dbCallsVaried: null,
      gucCalls: null,
      downstreamCalls: null,
      responseBytes: null,
      memoryMb: null,
      memoryMbPercentiles: null,
      responseBytesPercentiles: null,
    });

    it("counts measured, refused and failed separately and lists every failure", () => {
      const counted = tally({
        "GET /a": route("measured"),
        "GET /b": route("unmeasured", "no project in this tenant"),
        "GET /c": route("unmeasured", "no project in this tenant"),
        "GET /d": route("failed", 'exceeded its 30000ms deadline'),
      });
      expect(counted).toEqual({
        total: 4,
        measured: 1,
        refused: 2,
        failed: 1,
        refusalsByReason: { "no project in this tenant": 2, "exceeded its 30000ms deadline": 1 },
        routeFailures: ["GET /d: exceeded its 30000ms deadline"],
      });
    });

    it("never silently drops a route with no stated reason", () => {
      const counted = tally({ "GET /a": route("unmeasured") });
      expect(counted.refusalsByReason).toEqual({ unstated: 1 });
    });
  });

  describe("content hash", () => {
    it("is stable across key order, so a reordered snapshot is not read as drift", () => {
      expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
    });

    it("changes when a single counted row moves, which is the drift it exists to catch", () => {
      expect(contentHash({ tickets: 18500 })).not.toBe(contentHash({ tickets: 18501 }));
    });

    it("distinguishes a missing table from a table counted at zero", () => {
      expect(contentHash({ a: 0, b: 1 })).not.toBe(contentHash({ b: 1 }));
    });
  });

  describe("percentiles", () => {
    it("returns null for an empty sample rather than zero", () => {
      expect(percentiles([])).toBeNull();
    });

    it("orders p50 <= p95 <= p99 and carries min and max", () => {
      const p = percentiles([9, 1, 5, 3, 7, 100]);
      expect(p).not.toBeNull();
      expect(p?.min).toBe(1);
      expect(p?.max).toBe(100);
      expect(p?.p50).toBeLessThanOrEqual(p?.p95 ?? 0);
      expect(p?.p95).toBeLessThanOrEqual(p?.p99 ?? 0);
    });
  });
});
