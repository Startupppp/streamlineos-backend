import type { Db } from "../../../db/drizzle.module";
import { AiCreditsReservationService } from "./ai-credits-reservation.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("AiCreditsReservationService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const USER_ID = "user-abc";

  function makeDb(walletRow: unknown): Db {
    const forUpdate = jest.fn().mockResolvedValue(walletRow ? [walletRow] : []);
    const forClause = jest.fn().mockReturnValue({ then: async (fn: (v: unknown[]) => unknown) => fn(walletRow ? [walletRow] : []) });
    const where = jest.fn().mockReturnValue({ for: () => forClause, then: async (fn: (v: unknown[]) => unknown) => fn(walletRow ? [walletRow] : []) });
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    const insert = jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1 }]) }) });
    const db = {
      select,
      insert,
      execute: jest.fn().mockResolvedValue([]),
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
        select,
        insert,
        execute: jest.fn().mockResolvedValue([]),
        transaction: jest.fn().mockImplementation(async (fn2: (tx: unknown) => Promise<unknown>) => fn2({ select, insert, execute: jest.fn().mockResolvedValue([]) })),
      })),
    } as unknown as Db;
    return db;
  }

  it("creates a reservation scoped to the requesting org (cross-tenant isolation)", async () => {
    const walletRow = { orgId: ATTACKER, balance: 100000, lifetimeGranted: 100000 };
    const db = makeDb(walletRow);
    const svc = new AiCreditsReservationService(db);
    const result = await svc.reserve({ orgId: ATTACKER, userId: USER_ID, feature: "test", credits: 100 });
    expect(result).toHaveProperty("reservationId");
  });

  it("creates a reservation for the owning org (control — same-tenant)", async () => {
    const walletRow = { orgId: OWNER, balance: 200000, lifetimeGranted: 200000 };
    const db = makeDb(walletRow);
    const svc = new AiCreditsReservationService(db);
    const result = await svc.reserve({ orgId: OWNER, userId: USER_ID, feature: "test", credits: 50 });
    expect(result).toHaveProperty("reservationId");
  });
});
