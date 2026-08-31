import type { Db } from "../../../db/drizzle.module";
import { PaymentProviderSetupService } from "./payment-provider-setup.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("PaymentProviderSetupService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const PROVIDER_ROW = { id: 1, orgId: OWNER, providerKey: "razorpay", status: "active" };

  it("returns empty providers for a different org (cross-tenant isolation)", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const db = {
      query: {
        paymentProviders: { findMany, findFirst: jest.fn().mockResolvedValue(null) },
        paymentProviderCredentials: { findMany: jest.fn().mockResolvedValue([]) },
      },
    } as unknown as Db;
    const mockRegistry = { get: jest.fn() } as any;
    const mockAudit = { log: jest.fn() } as any;
    const mockAnalytics = {} as any;
    const svc = new PaymentProviderSetupService(db, mockRegistry, mockAudit, mockAnalytics);
    const result = await svc.listProviders(ATTACKER);
    expect(result).toHaveLength(0);
    const call = findMany.mock.calls[0]?.[0];
    expect(sqlValues(call?.where)).toContain(ATTACKER);
  });

  it("returns providers for the owning org (control — same-tenant)", async () => {
    const findMany = jest.fn().mockResolvedValue([PROVIDER_ROW]);
    const findManyCredentials = jest.fn().mockResolvedValue([]);
    const db = {
      query: {
        paymentProviders: { findMany, findFirst: jest.fn().mockResolvedValue(PROVIDER_ROW) },
        paymentProviderCredentials: { findMany: findManyCredentials },
      },
    } as unknown as Db;
    const mockRegistry = { get: jest.fn().mockReturnValue({ publicKeyId: jest.fn() }) } as any;
    const mockAudit = { log: jest.fn() } as any;
    const mockAnalytics = {} as any;
    const svc = new PaymentProviderSetupService(db, mockRegistry, mockAudit, mockAnalytics);
    const result = await svc.listProviders(OWNER);
    expect(result).toHaveLength(1);
  });
});
