import { resetSpanExporter, setSpanExporter, type FinishedSpan } from "../common/observability/tracing";
import {
  BoundedReservoir,
  QueryTelemetryTracker,
  RESERVOIR_CAP,
  classifyQuerySeam,
  instrumentPostgresClient,
} from "./query-telemetry";

const GUC_STATEMENT =
  "SELECT set_config('app.organization_id', $1, true), set_config('app.audience', $2, true)";

function captureSpans(): { spans: FinishedSpan[]; stop: () => void } {
  const spans: FinishedSpan[] = [];
  setSpanExporter({ export: (span) => spans.push(span) });
  return { spans, stop: () => resetSpanExporter() };
}

class FakeQuery {
  public valuesMode = false;
  constructor(private readonly settle: () => Promise<unknown>) {}

  values(): this {
    this.valuesMode = true;
    return this;
  }

  then(onOk?: (v: unknown) => unknown, onErr?: (e: unknown) => unknown): unknown {
    return this.settle().then(onOk, onErr);
  }
}

function fakeClient(behaviour: () => Promise<unknown>) {
  const calls: string[] = [];
  const client = {
    unsafe: (query: string): object => {
      calls.push(query);
      return new FakeQuery(behaviour);
    },
  };
  return { client, calls };
}

describe("query seam classification", () => {
  it("names the tenant GUC statement as its own seam", () => {
    expect(classifyQuerySeam(GUC_STATEMENT)).toBe("db.guc.setup");
    expect(classifyQuerySeam("  select SET_CONFIG('a', 'b', true)")).toBe("db.guc.setup");
  });

  it("names everything else an ordinary query", () => {
    expect(classifyQuerySeam('select "id" from "tickets"')).toBe("db.query.execute");
    expect(classifyQuerySeam("insert into notifications (id) values ($1)")).toBe(
      "db.query.execute",
    );
  });

  it("does not mistake a query that merely mentions set_config", () => {
    expect(classifyQuerySeam("select * from audit where sql like '%set_config%'")).toBe(
      "db.query.execute",
    );
  });
});

describe("the reservoir stays bounded", () => {
  it("never grows past its cap however many samples arrive", () => {
    const reservoir = new BoundedReservoir(RESERVOIR_CAP);
    for (let i = 0; i < RESERVOIR_CAP * 5; i++) reservoir.record(i);

    expect(reservoir.size).toBe(RESERVOIR_CAP);
  });

  it("reports a percentile from the samples it holds", () => {
    const reservoir = new BoundedReservoir(100);
    for (let i = 1; i <= 100; i++) reservoir.record(i);

    expect(reservoir.p95()).toBe(95);
  });

  it("reports zero rather than throwing when nothing has been recorded", () => {
    expect(new BoundedReservoir(10).p95()).toBe(0);
  });
});

describe("timing is measured when the query settles, not when the next one starts", () => {
  afterEach(() => resetSpanExporter());

  it("does not close a span until the query resolves", async () => {
    const { spans, stop } = captureSpans();
    const tracker = new QueryTelemetryTracker();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client } = fakeClient(() => gate.then(() => ["row"]));

    const pending = tracker.observe(client.unsafe("select 1"), "select 1");
    await Promise.resolve();

    expect(spans).toHaveLength(0);

    release?.();
    await (pending as unknown as Promise<unknown>);

    expect(spans).toHaveLength(1);
    stop();
  });

  it("counts a GUC statement and a query against separate seams", async () => {
    const tracker = new QueryTelemetryTracker();
    const { client } = fakeClient(() => Promise.resolve(["row"]));

    await tracker.observe(client.unsafe(GUC_STATEMENT), GUC_STATEMENT);
    await tracker.observe(client.unsafe("select 1"), "select 1");
    await tracker.observe(client.unsafe("select 2"), "select 2");

    expect(tracker.snapshot()["db.guc.setup"].count).toBe(1);
    expect(tracker.snapshot()["db.query.execute"].count).toBe(2);
  });

  it("records a failed query once, as an error", async () => {
    const { spans, stop } = captureSpans();
    const tracker = new QueryTelemetryTracker();
    const { client } = fakeClient(() => Promise.reject(new Error("42501")));

    await expect(tracker.observe(client.unsafe("insert 1"), "insert 1")).rejects.toThrow("42501");

    expect(spans).toHaveLength(1);
    expect(spans[0]?.status).toBe("error");
    expect(tracker.snapshot()["db.query.execute"].count).toBe(1);
    stop();
  });
});

describe("instrumentation carries no unbounded label and never breaks a query", () => {
  afterEach(() => resetSpanExporter());

  it("emits no organization or user identifier as a span attribute", async () => {
    const { spans, stop } = captureSpans();
    const tracker = new QueryTelemetryTracker();
    const { client } = fakeClient(() => Promise.resolve([]));

    await tracker.observe(client.unsafe("select 1"), "select 1");

    const attributes = spans[0]?.attributes ?? {};
    expect(Object.keys(attributes)).toEqual(["seam"]);
    expect(JSON.stringify(attributes)).not.toMatch(/org|user|tenant/i);
    stop();
  });

  it("preserves values() so the driver still gets array rows", async () => {
    const tracker = new QueryTelemetryTracker();
    const { client } = fakeClient(() => Promise.resolve([["a"]]));
    const raw = client.unsafe("select 1") as FakeQuery;
    const observed = tracker.observe(raw, "select 1") as unknown as FakeQuery;

    const rows = await observed.values();

    expect(raw.valuesMode).toBe(true);
    expect(rows).toEqual([["a"]]);
    expect(tracker.snapshot()["db.query.execute"].count).toBe(1);
  });

  it("still returns rows when the exporter throws", async () => {
    setSpanExporter({
      export: () => {
        throw new Error("collector down");
      },
    });
    const tracker = new QueryTelemetryTracker();
    const { client } = fakeClient(() => Promise.resolve(["row"]));

    await expect(tracker.observe(client.unsafe("select 1"), "select 1")).resolves.toEqual(["row"]);
  });

  it.each(["begin", "savepoint"] as const)(
    "instruments the client handed to %s, not just the outer one",
    async (method) => {
      const inner = Object.assign((): void => undefined, {
        unsafe: (): object => new FakeQuery(() => Promise.resolve(["row"])),
      });
      const outer = Object.assign((): void => undefined, {
        unsafe: (): object => new FakeQuery(() => Promise.resolve([])),
        [method]: (body: (client: unknown) => unknown): unknown => body(inner),
      });
      const untouched = inner.unsafe;

      instrumentPostgresClient(outer);
      await (outer[method] as (b: (c: unknown) => unknown) => unknown)((client) => {
        expect((client as typeof inner).unsafe).not.toBe(untouched);
        return undefined;
      });
    },
  );

  it("does not double-instrument a client it has already wrapped", () => {
    const client = { unsafe: (): object => new FakeQuery(() => Promise.resolve([])) };

    instrumentPostgresClient(client);
    const afterFirst = client.unsafe;
    instrumentPostgresClient(client);

    expect(client.unsafe).toBe(afterFirst);
  });

  it("returns the untouched query when wrapping itself fails", () => {
    const { client, calls } = fakeClient(() => Promise.resolve([]));
    instrumentPostgresClient(client);

    expect(client.unsafe("select 7")).toBeDefined();
    expect(calls).toEqual(["select 7"]);
  });
});
