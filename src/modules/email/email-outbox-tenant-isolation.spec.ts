jest.mock("../../common/tenant/tenant-context", () => ({
  getTenantContext: jest.fn().mockReturnValue(null),
}));

import type { Db } from "../../db/drizzle.module";
import { EmailOutboxService } from "./email-outbox.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("EmailOutboxService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  const insertedValues: unknown[] = [];

  function makeDb() {
    insertedValues.length = 0;
    return {
      insert: jest.fn().mockImplementation(() => ({
        values: jest.fn().mockImplementation((vals: unknown) => {
          const arr = Array.isArray(vals) ? vals : [vals];
          insertedValues.push(...arr);
          return {
            returning: jest.fn().mockResolvedValue([{ id: 1 }]),
            onConflictDoNothing: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([]),
            }),
          };
        }),
      })),
    } as unknown as Db;
  }

  function makeSuppression() {
    return { findSuppressed: jest.fn().mockResolvedValue(new Set()) } as never;
  }

  function makeProvider() {
    return {
      getEmailProvider: jest.fn().mockReturnValue("none"),
      sendEmailOnceDirect: jest.fn().mockResolvedValue(undefined),
    } as never;
  }

  it("stores the requesting org on enqueued outbox rows (tenant isolation)", async () => {
    const svc = new EmailOutboxService(makeDb(), makeSuppression(), makeProvider());

    await svc.enqueueForDelivery([
      { to: "user@example.com", subject: "Test", html: "<p>hi</p>", organizationId: ATTACKER },
    ]);

    expect(insertedValues.length).toBeGreaterThan(0);
    const row = insertedValues[0] as Record<string, unknown>;
    expect(row["organizationId"]).toBe(ATTACKER);
    expect(row["organizationId"]).not.toBe(OWNER);
  });

  it("enqueues mail for the owning org (same-tenant control)", async () => {
    const svc = new EmailOutboxService(makeDb(), makeSuppression(), makeProvider());

    const result = await svc.enqueueForDelivery([
      { to: "owner@example.com", subject: "Test", html: "<p>hi</p>", organizationId: OWNER },
    ]);

    expect(result).toBe(1);
    const row = insertedValues[0] as Record<string, unknown>;
    expect(row["organizationId"]).toBe(OWNER);
  });
});
