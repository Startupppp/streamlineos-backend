import { Test } from "@nestjs/testing";
import type { Db } from "../../db/drizzle.module";
import { DRIZZLE } from "../../db/drizzle.constants";
import { ClientsService } from "./clients.service";
import { ClientOnboardingService } from "./client-onboarding.service";
import { ClientOpportunitiesService } from "./client-opportunities.service";
import { ClientAccountsService } from "./client-accounts.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const rec = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(rec.queryChunks ? sqlValues(rec.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(rec, "value") ? sqlValues(rec.value, seen) : []),
  ];
}

function makeDb(rows: unknown[]): { db: Db; where: jest.Mock } {
  const where = jest.fn();
  const chain: Record<string, unknown> = {
    then: (fn: (v: unknown) => unknown) => Promise.resolve(rows).then(fn),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(rows).catch(fn),
    finally: (fn: () => void) => Promise.resolve(rows).finally(fn),
    where,
  };
  for (const m of ["orderBy", "limit", "offset", "groupBy", "having", "leftJoin", "innerJoin"]) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  where.mockReturnValue(chain);
  const from = jest.fn().mockReturnValue(chain);
  const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
  return { db, where };
}

const ATTACKER = "org-attacker";
const OWNER = "org-owner";

describe("ClientOnboardingService — cross-tenant isolation", () => {
  it("listItems: returns nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = new ClientOnboardingService(db);
    const result = await svc.listItems(ATTACKER, 1);
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("listItems: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, clientId: 1, task: "Send contract" };
    const { db } = makeDb([row]);
    const svc = new ClientOnboardingService(db);
    const result = await svc.listItems(OWNER, 1);
    expect(result).toHaveLength(1);
  });
});

describe("ClientOpportunitiesService — cross-tenant isolation", () => {
  it("list: returns nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = new ClientOpportunitiesService(db);
    const result = await svc.list(ATTACKER, 1);
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("list: returns rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, clientId: 1, title: "New deal" };
    const { db } = makeDb([row]);
    const svc = new ClientOpportunitiesService(db);
    const result = await svc.list(OWNER, 1);
    expect(result).toHaveLength(1);
  });
});

describe("ClientsService — cross-tenant isolation", () => {
  async function buildSvc(db: Db) {
    const mod = await Test.createTestingModule({
      providers: [
        ClientsService,
        { provide: DRIZZLE, useValue: db },
        {
          provide: "CacheService",
          useValue: {
            cached: jest.fn().mockImplementation((_k: unknown, fn: () => Promise<unknown>) => fn()),
            cachedVersioned: jest.fn().mockImplementation((_k: unknown, _h: unknown, fn: () => Promise<unknown>) => fn()),
            invalidateNamespace: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: "PlanLimitsService", useValue: { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    return mod.get(ClientsService);
  }

  it("listClients: queries scoped to attacker org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = await buildSvc(db);
    const result = await svc.listClients(ATTACKER, "user-1", "all");
    expect(result.items ?? result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("listClients: queries scoped to owner org (control)", async () => {
    const row = { id: 1, orgId: OWNER, name: "Acme" };
    const { db, where } = makeDb([row]);
    const svc = await buildSvc(db);
    await svc.listClients(OWNER, "user-1", "all");
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});

describe("ClientAccountsService — cross-tenant isolation", () => {
  async function buildSvc(db: Db) {
    const mod = await Test.createTestingModule({
      providers: [
        ClientAccountsService,
        { provide: DRIZZLE, useValue: db },
        { provide: "REDIS", useValue: { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue("OK") } },
        { provide: "AuditService", useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        { provide: "ClientsEmailService", useValue: { send: jest.fn().mockResolvedValue(undefined) } },
        { provide: "AccessService", useValue: { resolveUserPermissions: jest.fn().mockResolvedValue({}) } },
      ],
    }).compile();
    return mod.get(ClientAccountsService);
  }

  it("list: queries scoped to attacker org (cross-tenant isolation deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = await buildSvc(db);
    const result = await svc.list(ATTACKER);
    expect(result.items ?? result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("list: queries scoped to owner org (control)", async () => {
    const row = { id: 1, orgId: OWNER, name: "Acme Portal" };
    const { db, where } = makeDb([row]);
    const svc = await buildSvc(db);
    await svc.list(OWNER);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});
