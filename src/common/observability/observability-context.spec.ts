import {
  bindObservabilityContext,
  enrichObservabilityContext,
  getObservabilityContext,
  runWithObservabilityContext,
} from "./observability-context";

describe("observability context", () => {
  it("has no context outside a run", () => {
    expect(getObservabilityContext()).toBeUndefined();
  });

  it("exposes the context inside a run", async () => {
    await runWithObservabilityContext({ correlationId: "c-1" }, async () => {
      expect(getObservabilityContext()).toEqual({ correlationId: "c-1" });
    });
  });

  it("does not leak the context after the run completes", async () => {
    await runWithObservabilityContext({ correlationId: "c-1" }, async () => undefined);
    expect(getObservabilityContext()).toBeUndefined();
  });

  it("enriches the current context once the organisation and actor are known", async () => {
    await runWithObservabilityContext({ correlationId: "c-1" }, async () => {
      expect(enrichObservabilityContext({ orgId: "org-1", actorId: "user-1" })).toBe(true);
      expect(getObservabilityContext()).toEqual({
        correlationId: "c-1",
        orgId: "org-1",
        actorId: "user-1",
      });
    });
  });

  it("reports enrichment as a no-op outside a context rather than throwing", () => {
    expect(enrichObservabilityContext({ orgId: "org-1" })).toBe(false);
  });

  it("never overwrites the correlation id through enrichment", async () => {
    await runWithObservabilityContext({ correlationId: "c-1" }, async () => {
      enrichObservabilityContext({ correlationId: "hijacked" } as never);
      expect(getObservabilityContext()?.correlationId).toBe("c-1");
    });
  });

  it("carries the context into deferred work that runs after the request finished", async () => {
    let deferred: (() => string | undefined) | undefined;

    await runWithObservabilityContext({ correlationId: "c-1", orgId: "org-1" }, async () => {
      deferred = bindObservabilityContext(() => getObservabilityContext()?.correlationId);
    });

    expect(getObservabilityContext()).toBeUndefined();
    expect(deferred?.()).toBe("c-1");
  });

  it("binds to a snapshot, so later enrichment of a finished request is not observed", async () => {
    let deferred: (() => string | undefined) | undefined;

    await runWithObservabilityContext({ correlationId: "c-1" }, async () => {
      deferred = bindObservabilityContext(() => getObservabilityContext()?.orgId);
      enrichObservabilityContext({ orgId: "org-late" });
    });

    expect(deferred?.()).toBeUndefined();
  });

  it("keeps nested runs isolated from the outer context", async () => {
    await runWithObservabilityContext({ correlationId: "outer" }, async () => {
      await runWithObservabilityContext({ correlationId: "inner" }, async () => {
        expect(getObservabilityContext()?.correlationId).toBe("inner");
      });
      expect(getObservabilityContext()?.correlationId).toBe("outer");
    });
  });
});
