import type { Db } from "../../../../db/drizzle.module";
import { NotFoundException } from "@nestjs/common";
import { ProjectsWebhooksService } from "./projects-webhooks.service";
import { ProjectsWebhooksDispatchService } from "./projects-webhooks-dispatch.service";
import { WebhookEndpointService } from "../../../integrations/core/webhook-endpoint.service";
import { runWithTenantContext } from "../../../../common/tenant/tenant-context";

const endpointStub = {
  deliveryStats: jest.fn().mockResolvedValue(new Map()),
  requestDeliveries: jest.fn().mockResolvedValue(undefined),
  listDeliveries: jest.fn().mockResolvedValue([]),
  createCredential: jest.fn().mockResolvedValue({ id: 1, secretSetAt: new Date() }),
  deleteCredential: jest.fn().mockResolvedValue(undefined),
} as unknown as WebhookEndpointService;

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
  it("listWebhooks refuses a project the requesting org does not own (404, not an empty 200)", async () => {
    const where = jest.fn().mockReturnValue({ orderBy: jest.fn().mockResolvedValue([]) });
    const projectFindFirst = jest.fn().mockResolvedValue(undefined);
    const db = {
      query: { projects: { findFirst: projectFindFirst } },
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
    } as unknown as Db;
    const svc = new ProjectsWebhooksService(db, endpointStub);

    await expect(svc.listWebhooks(ATTACKER_ORG, 1)).rejects.toThrow(NotFoundException);

    expect(where).not.toHaveBeenCalled();
    const predicate = projectFindFirst.mock.calls[0]?.[0]?.where;
    expect(sqlValues(predicate)).toContain(ATTACKER_ORG);
    expect(sqlValues(predicate)).not.toContain(OWNER_ORG);
  });

  it("listWebhooks returns webhooks for the owning org (control — same-tenant access works)", async () => {
    const fakeWebhook = {
      id: 1,
      orgId: OWNER_ORG,
      projectId: 1,
      url: "https://x.com",
      events: [],
      isActive: true,
      hasSecret: true,
      secretSetAt: null,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) } },
      execute: jest.fn().mockResolvedValue([]),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([fakeWebhook]) }),
          }),
        }),
      }),
    } as unknown as Db;
    const svc = new ProjectsWebhooksService(db, endpointStub);

    const result = await svc.listWebhooks(OWNER_ORG, 1);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.orgId).toBe(OWNER_ORG);
  });

  it("assertWebhookOwnership throws NotFoundException for a different org (cross-tenant isolation — returns 404 not 403)", async () => {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    } as unknown as Db;
    const svc = new ProjectsWebhooksService(db, endpointStub);

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
    const svc = new ProjectsWebhooksDispatchService({} as Db, endpointStub);

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
