import { readFileSync } from "node:fs";
import { join } from "node:path";

const BACKEND_ROOT = join(__dirname, "..", "..", "..");

function source(relativePath: string): string {
  return readFileSync(join(BACKEND_ROOT, relativePath), "utf8");
}

/**
 * The eight boundaries PRD §9 names, and the primitive each one has to reach for.
 *
 * A source-level check on purpose. The behaviour of any one of these is asserted
 * by its own spec; what nothing else can catch is a *ninth* entry point being
 * added, or an existing one being rewritten without its propagation — the change
 * that produces perfectly structured logs describing unrelated things. This is
 * the list of places the trace is allowed to be, and it fails when one of them
 * stops carrying it.
 */
const BOUNDARIES: ReadonlyArray<{
  boundary: string;
  file: string;
  requires: readonly string[];
}> = [
  {
    boundary: "http request",
    file: "src/common/http/correlation-id.middleware.ts",
    requires: [
      "runWithObservabilityContext",
      "parseTraceparent",
      "formatTraceparent",
      "startSpan",
    ],
  },
  {
    boundary: "database adapter (query)",
    file: "src/db/query-telemetry.ts",
    requires: ["startSpan"],
  },
  {
    boundary: "database adapter (pool)",
    file: "src/db/pool-telemetry.ts",
    requires: ["startSpan"],
  },
  { boundary: "cache adapter", file: "src/common/cache/cache.service.ts", requires: ["withSpan"] },
  {
    boundary: "provider adapter (retrying call)",
    file: "src/common/outbound/call-provider.ts",
    requires: ["outboundTraceHeaders", "formatTraceparent", "withSpan"],
  },
  {
    boundary: "provider adapter (fetch)",
    file: "src/common/http/outbound-request.ts",
    requires: ["outboundTraceHeaders", "withSpan"],
  },
  {
    boundary: "provider adapter (dns-pinned webhook)",
    file: "src/common/outbound/safe-webhook-transport.ts",
    requires: ["outboundTraceHeaders", "withSpan"],
  },
  {
    boundary: "outbox publication (producer)",
    file: "src/common/outbox/outbox-writer.ts",
    requires: ["getObservabilityContext"],
  },
  {
    boundary: "outbox publication (consumer)",
    file: "src/common/outbox/outbox-publisher.service.ts",
    requires: ["runInRestoredContext"],
  },
  {
    boundary: "queue/event consumer (outbox → workflow relay)",
    file: "src/common/workflow/workflow-outbox-relay.service.ts",
    requires: ["runInRestoredContext"],
  },
  {
    boundary: "queue/event consumer (workflow drain)",
    file: "src/common/workflow/workflow-runner.service.ts",
    requires: ["runInRestoredContext"],
  },
  {
    boundary: "cron job (per-tenant sweep)",
    file: "src/common/tenant/for-each-org.ts",
    requires: ["runWithObservabilityContext"],
  },
  {
    boundary: "ai stream (gateway call)",
    file: "src/modules/ai/core/telemetry/ai-call-metrics.ts",
    requires: ["startSpan", "resolveAiCorrelationId"],
  },
  {
    boundary: "ai stream (correlation source)",
    file: "src/modules/ai/core/telemetry/ai-correlation.ts",
    requires: ["getObservabilityContext"],
  },
];

describe("trace context reaches every boundary PRD §9 names", () => {
  it.each(BOUNDARIES)("$boundary — $file", ({ file, requires }) => {
    const text = source(file);
    for (const symbol of requires) expect(text).toContain(symbol);
  });

  it("covers all eight named boundaries", () => {
    const named = new Set(
      BOUNDARIES.map(({ boundary }) => boundary.replace(/ \(.*\)$/, "")),
    );
    expect([...named].sort()).toEqual([
      "ai stream",
      "cache adapter",
      "cron job",
      "database adapter",
      "http request",
      "outbox publication",
      "provider adapter",
      "queue/event consumer",
    ]);
  });
});

/**
 * The half of a hop that fails silently.
 *
 * A producer writing the correlation id and a consumer reading it back are two
 * separate decisions, and the second one is invisible when it is wrong: leave
 * the column out of the `RETURNING` list and the run still executes, the logs
 * still look complete, and the only thing lost is the join. `workflow_runs`
 * shipped in exactly that state — the column written on every row and named in
 * no projection that read one back.
 */
describe("the join key survives the projection that reads the row back", () => {
  it("claims workflow_runs.correlation_id along with the run", () => {
    const text = source("src/common/workflow/workflow-store.ts");
    const returning = /RETURNING ([^\n]*)/.exec(text)?.[1] ?? "";
    expect(returning).toContain("correlation_id");
    expect(text).toContain("correlationId: record.correlation_id");
  });

  it("selects outbox_events.correlation_id in the relay's projection", () => {
    expect(source("src/common/workflow/workflow-outbox-relay.service.ts")).toContain(
      "correlationId: outboxEvents.correlationId",
    );
  });

  it("restores the outbox row's own correlation id in the publisher", () => {
    expect(source("src/db/schema/common/outbox.ts")).toContain('correlationId: text("correlation_id")');
    expect(source("src/common/outbox/outbox-publisher.service.ts")).toContain(
      "correlationId: event.correlationId",
    );
  });
});

/**
 * A consumer minting its own id is the regression, not the missing call.
 *
 * `randomUUID()` at a hop's consumer reads as diligence — every line has an id —
 * while quietly making the row's own id unreachable. The only place it belongs is
 * behind `runInRestoredContext`, which reaches for it once, after the persisted
 * id has been found absent.
 */
describe("no consumer mints a correlation id in place of the persisted one", () => {
  it.each([
    "src/common/outbox/outbox-publisher.service.ts",
    "src/common/workflow/workflow-outbox-relay.service.ts",
    "src/common/workflow/workflow-runner.service.ts",
  ])("%s", (file) => {
    expect(source(file)).not.toContain("randomUUID");
  });

  it("keeps the single minting site inside the restore helper", () => {
    const text = source("src/common/observability/async-hop.ts");
    expect(text.match(/randomUUID\(\)/g)).toHaveLength(1);
    expect(text).toContain("hop.correlationId ?? randomUUID()");
  });
});
