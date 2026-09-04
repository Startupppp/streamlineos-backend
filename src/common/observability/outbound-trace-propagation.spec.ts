import { readFileSync } from "fs";
import { join } from "path";
import { outboundTraceHeaders } from "../outbound/call-provider";
import { runWithObservabilityContext } from "./observability-context";
import { runInSpan, startSpan } from "./tracing";

/**
 * PRD-C102 — "distributed trace context across … provider adapters", and
 * "correlate one user intent through asynchronous work". A webhook fired by a
 * user's action is that asynchronous work: the shared adapter propagates trace
 * context, but these product-module callers each hand-rolled their own `fetch`
 * and sent none, so the intent stopped being traceable the moment it left us.
 */
describe("outboundTraceHeaders", () => {
  it("carries both the W3C traceparent and the correlation id of the current intent", () => {
    const headers = runWithObservabilityContext({ correlationId: "corr-abc" }, () => {
      const open = startSpan("test");
      return runInSpan(open.span, () => outboundTraceHeaders());
    });

    expect(headers["x-correlation-id"]).toBe("corr-abc");
    expect(headers["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-(00|01)$/);
  });

  it("sends nothing when there is no ambient intent, rather than a misleading header", () => {
    expect(outboundTraceHeaders()).toEqual({});
  });
});

describe("product-module outbound calls propagate trace context", () => {
  const BACKEND_SRC = join(__dirname, "..", "..");

  const SCANNED_FILES = [
    "modules/hr/automations/hr-webhooks.service.ts",
    "modules/inventory/webhooks/webhook-emitter.service.ts",
    "modules/automation/automation-webhook.service.ts",
    "modules/hr/automations/hr-automation-actions.service.ts",
    "modules/crm/automation-studio/crm-automation-runner.service.ts",
    "common/security/turnstile.service.ts",
  ];

  /**
   * The window reaches backwards as well as forwards: two of these call sites
   * build their header record on an earlier line and pass it by name, and a call
   * routed through the shared adapter names it before the `fetch` it wraps.
   */
  const TRACED = /outboundTraceHeaders\(\)|callProvider\(|postSafeWebhook\(|outboundRequest\(/;

  function untracedFetches(source: string): string[] {
    const offenders: string[] = [];
    for (const match of source.matchAll(/\bfetch\(/g)) {
      const at = match.index ?? 0;
      const window = source.slice(Math.max(0, at - 500), at + 400);
      if (!TRACED.test(window)) offenders.push(source.slice(at, at + 60).split("\n")[0] ?? "");
    }
    return offenders;
  }

  it.each(SCANNED_FILES)("%s sends trace context on every outbound call", (relative) => {
    expect(untracedFetches(readFileSync(join(BACKEND_SRC, relative), "utf8"))).toEqual([]);
  });

  it("the scan bites — a hand-rolled webhook post with only a signature header is detected", () => {
    const bad = [
      "const response = await fetch(url, {",
      '  method: "POST",',
      '  headers: { "Content-Type": "application/json", "X-Signature": sig },',
      "  body,",
      "  signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),",
      "});",
    ].join("\n");
    expect(untracedFetches(bad)).toHaveLength(1);
  });

  it("the scan accepts a call routed through the shared adapter instead", () => {
    const good = "await callProvider(descriptor, () => fetch(url, { method: \"POST\" }));";
    expect(untracedFetches(good)).toEqual([]);
  });
});
