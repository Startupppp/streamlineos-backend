import { correlationIdToPersist, runInRestoredContext } from "./async-hop";
import { getObservabilityContext, runWithObservabilityContext } from "./observability-context";
import { resetSpanExporter, setSpanExporter, type FinishedSpan } from "./tracing";

const REQUEST_ID = "1c5a3f90-7b21-4d64-9a55-2e8c0f6b41d7";
const TICK_ID = "9e0d4a21-3c77-4f18-8b2a-6d51907cb3fe";

describe("correlationIdToPersist", () => {
  it("takes the ambient id so the row can be joined back to the request", () => {
    const persisted = runWithObservabilityContext({ correlationId: REQUEST_ID }, () =>
      correlationIdToPersist(),
    );
    expect(persisted).toBe(REQUEST_ID);
  });

  /**
   * A producer running outside a request genuinely has no origin. Minting one
   * here would stamp the row with an id that appears on no other line anywhere,
   * which reads as a correlation and joins to nothing — strictly worse than a
   * null, because a null is honest about it.
   */
  it("persists nothing rather than an id no log line carries", () => {
    expect(correlationIdToPersist()).toBeNull();
  });

  it("lets a caller state the id explicitly", () => {
    const persisted = runWithObservabilityContext({ correlationId: REQUEST_ID }, () =>
      correlationIdToPersist("chosen-by-caller"),
    );
    expect(persisted).toBe("chosen-by-caller");
  });
});

describe("runInRestoredContext", () => {
  afterEach(() => resetSpanExporter());

  it("runs the consumer under the id the producer persisted", async () => {
    const seen = await runInRestoredContext(
      { correlationId: REQUEST_ID, orgId: "org-1", route: "outbox:deal.closed" },
      async () => getObservabilityContext(),
    );

    expect(seen).toMatchObject({
      correlationId: REQUEST_ID,
      orgId: "org-1",
      route: "outbox:deal.closed",
    });
  });

  /**
   * The failure this exists to prevent. A consumer that inherits the sweep it is
   * running inside files every piece of deferred work under whatever tick
   * happened to pick it up, and the request that caused the work is unreachable
   * from any of it.
   */
  it("never inherits the ambient context of the sweep that invoked it", async () => {
    const seen = await runWithObservabilityContext(
      { correlationId: TICK_ID, route: "/cron/outbox-flush" },
      () =>
        runInRestoredContext(
          { correlationId: REQUEST_ID, orgId: "org-1", route: "outbox:deal.closed" },
          async () => getObservabilityContext(),
        ),
    );

    expect(seen?.correlationId).toBe(REQUEST_ID);
    expect(seen?.route).toBe("outbox:deal.closed");
  });

  it("mints an id for a row that carries none rather than borrowing the sweep's", async () => {
    const seen = await runWithObservabilityContext({ correlationId: TICK_ID }, () =>
      runInRestoredContext({ correlationId: null, route: "outbox:legacy" }, async () =>
        getObservabilityContext(),
      ),
    );

    expect(seen?.correlationId).toBeDefined();
    expect(seen?.correlationId).not.toBe(TICK_ID);
  });

  it("carries the restored id onto the span, not just the log line", async () => {
    const spans: FinishedSpan[] = [];
    setSpanExporter({ export: (span) => spans.push(span) });

    await runInRestoredContext(
      {
        correlationId: REQUEST_ID,
        orgId: "org-1",
        route: "outbox:deal.closed",
        span: { name: "outbox.deliver", attributes: { "outbox.event_type": "deal.closed" } },
      },
      async () => undefined,
    );

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      name: "outbox.deliver",
      attributes: {
        "correlation.id": REQUEST_ID,
        "org.id": "org-1",
        "outbox.event_type": "deal.closed",
      },
    });
  });

  it("records the span as failed and still propagates the error", async () => {
    const spans: FinishedSpan[] = [];
    setSpanExporter({ export: (span) => spans.push(span) });

    await expect(
      runInRestoredContext(
        { correlationId: REQUEST_ID, route: "outbox:deal.closed", span: { name: "outbox.deliver" } },
        async () => {
          throw new Error("consumer blew up");
        },
      ),
    ).rejects.toThrow("consumer blew up");

    expect(spans[0]?.status).toBe("error");
    expect(spans[0]?.attributes["correlation.id"]).toBe(REQUEST_ID);
  });

  it("omits an organisation it was not given rather than inventing one", async () => {
    const seen = await runInRestoredContext(
      { correlationId: REQUEST_ID, route: "cron:sweep" },
      async () => getObservabilityContext(),
    );

    expect(seen?.orgId).toBeUndefined();
  });
});
