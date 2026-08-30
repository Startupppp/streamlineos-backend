import type { Db } from "../../db/drizzle.module";
import { PushService } from "./push.service";

describe("PushService — cross-tenant isolation", () => {
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

  const config = { VAPID_PUBLIC_KEY: "test-key" } as never;

  it("binds the requesting org to the push subscription insert (tenant isolation)", async () => {
    const svc = new PushService(makeDb(), config);

    await svc.subscribe(ATTACKER, "user-1", {
      endpoint: "https://push.example.com/attacker",
      p256dh: "p256",
      auth: "auth",
    });

    expect(insertedValues.length).toBeGreaterThan(0);
    const row = insertedValues[0] as Record<string, unknown>;
    expect(row["orgId"]).toBe(ATTACKER);
    expect(row["orgId"]).not.toBe(OWNER);
  });

  it("binds the owning org to the push subscription insert (same-tenant control)", async () => {
    const svc = new PushService(makeDb(), config);

    const result = await svc.subscribe(OWNER, "user-2", {
      endpoint: "https://push.example.com/owner",
      p256dh: "p256",
      auth: "auth",
    });

    expect(result).toBeDefined();
    expect(result).toHaveProperty("success", true);
    const row = insertedValues[0] as Record<string, unknown>;
    expect(row["orgId"]).toBe(OWNER);
  });
});
