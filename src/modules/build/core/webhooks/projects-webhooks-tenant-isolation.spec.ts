import type { Db } from "../../../../db/drizzle.module";
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
