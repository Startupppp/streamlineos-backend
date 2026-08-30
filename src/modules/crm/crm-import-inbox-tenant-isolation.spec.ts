import { Test } from "@nestjs/testing";
import type { Db } from "../../db/drizzle.module";
import { DRIZZLE } from "../../db/drizzle.constants";
import { CrmExportService } from "./import/crm-export.service";
import { CrmInboxAiActionsService } from "./inbox/crm-inbox-ai-actions.service";
import { CrmInboxService } from "./inbox/crm-inbox.service";

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

describe("CrmExportService — cross-tenant isolation", () => {
  it("archiveChunks: yields nothing for a different org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = new CrmExportService(db);
    const chunks: unknown[] = [];
    for await (const chunk of svc.archiveChunks(ATTACKER)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("archiveChunks: yields rows for the owning org (control)", async () => {
    const row = { id: 1, orgId: OWNER, data: "x" };
    const { db } = makeDb([row]);
    const svc = new CrmExportService(db);
    const chunks: unknown[] = [];
    for await (const chunk of svc.archiveChunks(OWNER)) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
  });
});

describe("CrmInboxAiActionsService — cross-tenant isolation", () => {
  it("resolveMetadata: queries scoped to attacker org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = new CrmInboxAiActionsService(db);
    const result = await svc.resolveMetadata(ATTACKER);
    expect(result).toBeDefined();
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("resolveMetadata: queries scoped to owner org (control)", async () => {
    const { db, where } = makeDb([]);
    const svc = new CrmInboxAiActionsService(db);
    await svc.resolveMetadata(OWNER);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});

describe("CrmInboxService — cross-tenant isolation", () => {
  async function buildSvc(db: Db) {
    const mod = await Test.createTestingModule({
      providers: [
        CrmInboxService,
        { provide: DRIZZLE, useValue: db },
        { provide: "CrmInboxAiActionsService", useValue: { resolveMetadata: jest.fn().mockResolvedValue({}) } },
      ],
    }).compile();
    return mod.get(CrmInboxService);
  }

  it("getInbox: queries scoped to attacker org (deny)", async () => {
    const { db, where } = makeDb([]);
    const svc = await buildSvc(db);
    const result = await svc.getInbox(ATTACKER, "user-1", "all");
    expect(result.items ?? result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("getInbox: queries scoped to owner org (control)", async () => {
    const row = { id: 1, orgId: OWNER };
    const { db, where } = makeDb([row]);
    const svc = await buildSvc(db);
    await svc.getInbox(OWNER, "user-1", "all");
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(OWNER);
  });
});
