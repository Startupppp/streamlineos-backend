jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db),
  runInNewTenantTransaction: (db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn(db),
}));

import { randomUUID } from "node:crypto";
import { runWithObservabilityContext } from "../../../../common/observability";
import { settleStream } from "../gateway/ai-gateway-stream-credit";
import { AiUsageService } from "./ai-usage.service";
import type { AiCreditLedger } from "../gateway/credit-ledger.interface";

interface CapturedRow {
  correlationId: string | null;
  feature: string;
  orgId: string;
}

function makeDb(): { db: unknown; rows: CapturedRow[] } {
  const rows: CapturedRow[] = [];
  const db = {
    insert: () => ({
      values: (row: CapturedRow) => {
        rows.push(row);
        return Promise.resolve(undefined);
      },
    }),
  };
  return { db, rows };
}

const BASE = {
  orgId: "org_1",
  feature: "ai.chat",
  model: "gpt-4o-mini",
  promptTokens: 10,
  completionTokens: 5,
};

describe("AiUsageService — the row that reaches the database carries the request's correlation id", () => {
  it("defaults from the ambient observability context when the caller passes none", async () => {
    const { db, rows } = makeDb();
    const svc = new AiUsageService(db as never);

    await runWithObservabilityContext({ correlationId: "req-abc-123" }, async () => {
      await svc.track(BASE);
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.correlationId).toBe("req-abc-123");
  });

  it("keeps an explicitly supplied id rather than letting the ambient one displace it", async () => {
    const { db, rows } = makeDb();
    const svc = new AiUsageService(db as never);

    await runWithObservabilityContext({ correlationId: "req-ambient" }, async () => {
      await svc.track({ ...BASE, correlationId: "explicit-id" });
    });

    expect(rows[0]?.correlationId).toBe("explicit-id");
  });

  it("writes null when there is no context at all, which is what a cron-initiated call has", async () => {
    const { db, rows } = makeDb();
    const svc = new AiUsageService(db as never);

    await svc.track(BASE);

    expect(rows[0]?.correlationId).toBeNull();
  });

  it("drops an id longer than the varchar(64) column instead of losing the whole usage row to a 22001", async () => {
    const { db, rows } = makeDb();
    const svc = new AiUsageService(db as never);

    await runWithObservabilityContext({ correlationId: "x".repeat(65) }, async () => {
      await svc.track(BASE);
    });

    expect(rows[0]?.correlationId).toBeNull();
  });

  it("accepts an id exactly at the column width", async () => {
    const { db, rows } = makeDb();
    const svc = new AiUsageService(db as never);
    const id = "y".repeat(64);

    await runWithObservabilityContext({ correlationId: id }, async () => {
      await svc.track(BASE);
    });

    expect(rows[0]?.correlationId).toBe(id);
  });
});

describe("settleStream — a streamed turn is no longer an orphan trace", () => {
  it("lands a correlated ai_usage_logs row, asserted on what the insert received", async () => {
    const { db, rows } = makeDb();
    const usageSvc = new AiUsageService(db as never);
    const ledger: AiCreditLedger = {
      reserve: jest.fn().mockResolvedValue({ reservationId: 1 }),
      settle: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const correlationId = randomUUID();

    await runWithObservabilityContext({ correlationId, orgId: "org_1" }, async () => {
      await settleStream(ledger, usageSvc, {
        reservationId: 1,
        model: "gpt-4o-mini",
        promptTokens: 100,
        completionTokens: 40,
        orgId: "org_1",
        userId: "user_1",
        feature: "ai.chat",
      });
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.correlationId).toBe(correlationId);
    expect(rows[0]?.feature).toBe("ai.chat");
  });
});
