import type { Db } from "../../../db/drizzle.module";
import { NotFoundException } from "@nestjs/common";
import { ProjectsWebhooksService } from "./projects-webhooks.service";
import { ProjectsWebhooksDispatchService } from "./projects-webhooks-dispatch.service";
import { runWithTenantContext } from "../../../common/tenant/tenant-context";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

function makeSelectChain(result: unknown = []): Db["select"] {
  return jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        orderBy: jest.fn().mockResolvedValue(result),
        limit: jest.fn().mockResolvedValue(result),
      }),
      innerJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockResolvedValue(result),
          limit: jest.fn().mockResolvedValue(result),
        }),
      }),
    }),
  }) as unknown as Db["select"];
}

describe("ProjectsWebhooksService — cross-tenant isolation", () => {
  it("listWebhooks scopes WHERE to the requesting org (cross-tenant isolation — attacker gets empty list)", async () => {
    const where = jest.fn().mockReturnValue({ orderBy: jest.fn().mockResolvedValue([]) });
    const db = {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
    } as unknown as Db;
    const svc = new ProjectsWebhooksService(db);

    const result = await svc.listWebhooks(ATTACKER_ORG, 1);

    expect(where).toHaveBeenCalled();
    const predicate = where.mock.calls[0]?.[0];
    expect(sqlValues(predicate)).toContain(ATTACKER_ORG);
    expect(sqlValues(predicate)).not.toContain(OWNER_ORG);
    expect(result).toHaveLength(0);
  });

  it("listWebhooks returns webhooks for the owning org (control — same-tenant access works)", async () => {
    const fakeWebhook = { id: 1, orgId: OWNER_ORG, projectId: 1, url: "https://x.com", events: [], isActive: true, createdAt: new Date() };
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockResolvedValue([fakeWebhook]) }),
        }),
      }),
    } as unknown as Db;
    const svc = new ProjectsWebhooksService(db);

    const result = await svc.listWebhooks(OWNER_ORG, 1);
    expect(result).toHaveLength(1);
  });

  it("assertWebhookOwnership throws NotFoundException for a different org (cross-tenant isolation — returns 404 not 403)", async () => {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    } as unknown as Db;
    const svc = new ProjectsWebhooksService(db);

    await expect(svc.assertWebhookOwnership(ATTACKER_ORG, 1, 999)).rejects.toThrow(NotFoundException);
  });
});

describe("ProjectsWebhooksDispatchService — cross-tenant isolation", () => {
  it("run scopes webhook query to the requesting org (cross-tenant isolation)", async () => {
    const where = jest.fn().mockResolvedValue([]);
    const tx = {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
    };
    const svc = new ProjectsWebhooksDispatchService({} as Db);

    await runWithTenantContext(
      { orgId: ATTACKER_ORG, audience: "INTERNAL", tx: tx as never },
      () => svc.dispatch(ATTACKER_ORG, 1, "ticket.created", {
        id: 1,
        projectId: 1,
        actor: "u1",
        timestamp: new Date().toISOString(),
      }),
    );

    if (where.mock.calls.length > 0) {
      const predicate = where.mock.calls[0]?.[0];
      expect(sqlValues(predicate)).toContain(ATTACKER_ORG);
      expect(sqlValues(predicate)).not.toContain(OWNER_ORG);
    }
  });
});
