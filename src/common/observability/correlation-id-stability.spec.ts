import {
  enrichObservabilityContext,
  getObservabilityContext,
  runWithObservabilityContext,
} from "./observability-context";
import { logger } from "../logger/logger.service";
import { buildOutboxEvent } from "../outbox/outbox-envelope";

type Line = Record<string, unknown>;

function captureOutput(): { lines: Line[]; restore: () => void } {
  const lines: Line[] = [];
  const out = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(JSON.parse(String(chunk)) as Line);
    return true;
  });
  const err = jest.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(JSON.parse(String(chunk)) as Line);
    return true;
  });
  return { lines, restore: () => [out, err].forEach((s) => s.mockRestore()) };
}

const EVENT_UUID = "11111111-1111-4111-8111-111111111111";
const CORRELATION_UUID = "c20c3003-0000-4000-8000-000000000003";

describe("correlation id stability across request layers", () => {
  it("carries the same id from guard to service to outbox record", async () => {
    const { lines, restore } = captureOutput();

    let outboxCorrelationId: string | null = null;

    await runWithObservabilityContext({ correlationId: CORRELATION_UUID }, async () => {
      enrichObservabilityContext({ orgId: "org-1", actorId: "user-1" });

      logger.warn("guard: permission check passed");

      await Promise.resolve();
      logger.warn("service: record retrieved");

      outboxCorrelationId = getObservabilityContext()?.correlationId ?? null;
    });

    restore();

    const event = buildOutboxEvent({
      eventId: EVENT_UUID,
      organizationId: "org-1",
      aggregateType: "deal",
      aggregateId: "deal-1",
      aggregateVersion: 1,
      eventType: "deal.closed",
      payload: {},
      occurredAt: new Date("2026-08-26T00:00:00.000Z"),
      correlationId: outboxCorrelationId,
    });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      level: "warn",
      correlationId: CORRELATION_UUID,
      orgId: "org-1",
      actorId: "user-1",
    });
    expect(lines[1]).toMatchObject({
      level: "warn",
      correlationId: CORRELATION_UUID,
    });
    expect(event.correlationId).toBe(CORRELATION_UUID);
  });

  it("keeps the id stable across an async hop without losing the organisation", async () => {
    const { lines, restore } = captureOutput();

    await runWithObservabilityContext({ correlationId: CORRELATION_UUID }, async () => {
      enrichObservabilityContext({ orgId: "org-stable" });
      await Promise.resolve();
      logger.warn("after hop");
    });

    restore();

    expect(lines[0]).toMatchObject({
      correlationId: CORRELATION_UUID,
      orgId: "org-stable",
    });
  });
});
