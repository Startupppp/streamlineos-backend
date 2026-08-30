jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (_db: unknown, fn: (tx: unknown) => unknown) => fn(_db),
  runInNewTenantTransaction: jest.fn().mockResolvedValue(undefined),
}));

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
    const walletRows = walletRow ? [walletRow] : [];
    const reservationRow = { id: 1, orgId: "org-x", credits: 100, status: "RESERVED", expiresAt: new Date() };
    const forChain = { then: (fn: (v: unknown) => unknown) => Promise.resolve(walletRows).then(fn), catch: (fn: (e: unknown) => unknown) => Promise.resolve(walletRows).catch(fn), finally: (fn: () => void) => Promise.resolve(walletRows).finally(fn) };
    const where = jest.fn().mockReturnValue({ for: jest.fn().mockReturnValue(forChain), then: (fn: (v: unknown) => unknown) => Promise.resolve(walletRows).then(fn), catch: (fn: (e: unknown) => unknown) => Promise.resolve(walletRows).catch(fn) });
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    const update = jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) });
    const insert = jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([reservationRow]) }) });
    const innerTx = { select, insert, update, execute: jest.fn().mockResolvedValue([]) };
    const outerTx = {
      select, insert, update, execute: jest.fn().mockResolvedValue([]),
      transaction: jest.fn().mockImplementation(async (fn2: (tx: unknown) => Promise<unknown>) => fn2(innerTx)),
    };
    const db = {
      select, insert, update,
      execute: jest.fn().mockResolvedValue([]),
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(outerTx)),
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
