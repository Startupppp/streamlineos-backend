import type { Db } from "../../db/drizzle.module";
import { PushService } from "./push.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as Record<string, unknown>;
  return [
    ...(Array.isArray(r["queryChunks"]) ? sqlValues(r["queryChunks"], seen) : []),
    ...("value" in r ? sqlValues(r["value"], seen) : []),
  ];
}

describe("PushService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  const insertedValues: unknown[] = [];
  const conflictSets: unknown[] = [];

  function makeDb() {
    insertedValues.length = 0;
    conflictSets.length = 0;
    return {
      // `subscribe` releases the endpoint from any other tenant before inserting
      // (app.claim_push_endpoint, migration 1061). A fake without `execute` fails
      // the call rather than the assertion, so it is modelled here.
      execute: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockImplementation(() => ({
        values: jest.fn().mockImplementation((vals: unknown) => {
          insertedValues.push(vals);
          return {
            onConflictDoUpdate: jest.fn().mockImplementation((spec: { set: unknown }) => {
              conflictSets.push(spec.set);
              return Promise.resolve([]);
            }),
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

    // And the conflict branch must bind it too: a `set` that omits org_id leaves a
    // colliding row owned by whichever tenant registered the endpoint first.
    const set = conflictSets[0] as Record<string, unknown>;
    expect(set["orgId"]).toBe(ATTACKER);
    expect(set["userId"]).toBe("user-1");
    expect(set["membershipId"]).toBeNull();
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

describe("PushService.unsubscribe — cross-user ownership", () => {
  const OWNER_USER = "user-owner";
  const ATTACKER_USER = "user-attacker";
  const ENDPOINT = "https://push.example.com/victim";

  function makeDeleteDb() {
    const deleteWhere = jest.fn().mockResolvedValue([]);
    const db = {
      delete: jest.fn().mockReturnValue({ where: deleteWhere }),
    } as unknown as Db;
    return { db, deleteWhere };
  }

  afterEach(() => jest.resetAllMocks());

  it("includes userId in the delete WHERE so an attacker cannot remove another user's subscription (cross-user DENY)", async () => {
    const { db, deleteWhere } = makeDeleteDb();
    const config = { VAPID_PUBLIC_KEY: "k" } as never;
    const svc = new PushService(db, config);

    await svc.unsubscribe(ENDPOINT, ATTACKER_USER);

    expect(deleteWhere).toHaveBeenCalledTimes(1);
    const whereArg = deleteWhere.mock.calls[0]?.[0];
    const vals = sqlValues(whereArg);
    expect(vals).toContain(ATTACKER_USER);
    expect(vals).not.toContain(OWNER_USER);
  });

  it("includes the caller's userId in the delete WHERE (same-user CONTROL)", async () => {
    const { db, deleteWhere } = makeDeleteDb();
    const config = { VAPID_PUBLIC_KEY: "k" } as never;
    const svc = new PushService(db, config);

    const result = await svc.unsubscribe(ENDPOINT, OWNER_USER);

    expect(result).toHaveProperty("success", true);
    const whereArg = deleteWhere.mock.calls[0]?.[0];
    const vals = sqlValues(whereArg);
    expect(vals).toContain(OWNER_USER);
    expect(vals).toContain(ENDPOINT);
  });
});
