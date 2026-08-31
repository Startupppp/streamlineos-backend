import type { Db } from "../../db/drizzle.module";
import { NotificationDigestService } from "./notification-digest.service";

describe("NotificationDigestService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  const insertedValues: unknown[] = [];

  function makeDb() {
    insertedValues.length = 0;
    return {
      insert: jest.fn().mockImplementation(() => ({
        values: jest.fn().mockImplementation((vals: unknown) => {
          insertedValues.push(vals);
          return {
            onConflictDoUpdate: jest.fn().mockResolvedValue([]),
          };
        }),
      })),
    } as unknown as Db;
  }

  const makeNotifications = () => ({ create: jest.fn().mockResolvedValue({}) } as never);

  const baseInput = {
    userId: "user-1",
    channel: "IN_APP" as const,
    eventKey: "test.event",
    title: "Test",
    message: "A test notification",
    windowMs: 3600000,
  };

  it("binds the requesting org to the digest item insert (tenant isolation)", async () => {
    const svc = new NotificationDigestService(makeDb(), makeNotifications());

    await svc.enqueue({ ...baseInput, orgId: ATTACKER });

    expect(insertedValues.length).toBeGreaterThan(0);
    const row = insertedValues[0] as Record<string, unknown>;
    expect(row["orgId"]).toBe(ATTACKER);
    expect(row["orgId"]).not.toBe(OWNER);
  });

  it("binds the owning org to the digest item insert (same-tenant control)", async () => {
    const svc = new NotificationDigestService(makeDb(), makeNotifications());

    await svc.enqueue({ ...baseInput, orgId: OWNER });

    expect(insertedValues.length).toBeGreaterThan(0);
    const row = insertedValues[0] as Record<string, unknown>;
    expect(row["orgId"]).toBe(OWNER);
  });
});
