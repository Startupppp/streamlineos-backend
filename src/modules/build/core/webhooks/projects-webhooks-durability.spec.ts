import { outboxEvents } from "../../../../db/schema/common/outbox";
import { webhookDeliveries } from "../../../../db/schema/build/tasks";
import { runWithTenantContext } from "../../../../common/tenant/tenant-context";
import { OutboxConsumerRegistry } from "../../../../common/outbox/outbox-consumer.registry";
import type { OutboxEventRow } from "../../../../common/outbox/outbox-consumer.registry";
import type { Db } from "../../../../db/drizzle.module";
import { postSafeWebhook } from "../../../../common/outbound/safe-webhook-transport";
import { ProjectsWebhooksDispatchService } from "./projects-webhooks-dispatch.service";

jest.mock("../../../../common/outbound/safe-webhook-transport", () => {
  const actual = jest.requireActual("../../../../common/outbound/safe-webhook-transport");
  return { ...actual, postSafeWebhook: jest.fn() };
});

const post = postSafeWebhook as jest.MockedFunction<typeof postSafeWebhook>;

function event(deliveryId: number): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: "11111111-1111-4111-8111-111111111111",
    organizationId: "org-1",
    aggregateType: "project_webhook_delivery",
    aggregateId: String(deliveryId),
    aggregateVersion: deliveryId,
    schemaVersion: 1,
    causationId: null,
    correlationId: null,
    actorMembershipId: null,
    audience: "INTERNAL",
    lifecycleState: "ACTIVE",
    deliveryState: "IN_FLIGHT",
    eventType: "build.project-webhook.delivery.requested",
    payload: { deliveryId },
    occurredAt: new Date(),
    publishedAt: null,
    leaseExpiresAt: new Date(Date.now() + 30_000),
    retryCount: 0,
    lastError: null,
    deadLetteredAt: null,
    createdAt: new Date(),
  };
}

describe("ProjectsWebhooksDispatchService durable outbox", () => {
  beforeEach(() => post.mockReset());

  it("persists delivery intent and outbox event before returning, without network I/O", async () => {
    const inserts: unknown[] = [];
    const tx = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ id: 5, events: ["ticket.created"] }]),
        }),
      }),
      insert: jest.fn((table: unknown) => {
        inserts.push(table);
        return {
          values: jest.fn().mockReturnValue(
            table === webhookDeliveries
              ? { returning: jest.fn().mockResolvedValue([{ id: 77 }]) }
              : Promise.resolve(undefined),
          ),
        };
      }),
    };
    const service = new ProjectsWebhooksDispatchService({} as Db);

    await runWithTenantContext(
      { orgId: "org-1", audience: "INTERNAL", tx: tx as never },
      () => service.dispatch("org-1", 9, "ticket.created", {
        id: 12,
        projectId: 9,
        actor: "member-1",
        timestamp: new Date().toISOString(),
      }),
    );

    expect(inserts).toEqual([webhookDeliveries, outboxEvents]);
    expect(post).not.toHaveBeenCalled();
  });

  it("registers its durable event consumer with the shared outbox registry", () => {
    const registry = new OutboxConsumerRegistry();
    const service = new ProjectsWebhooksDispatchService({} as Db, registry);
    service.onModuleInit();
    expect(registry.get("build.project-webhook.delivery.requested")).toBe(service);
  });

  it("retries a failed row and suppresses a duplicate after success", async () => {
    let status = "pending";
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockImplementation(() => Promise.resolve([{
                deliveryId: 77,
                event: "ticket.created",
                payload: { id: 12, projectId: 9, actor: "member-1", timestamp: "now" },
                status,
                endpointId: 5,
                url: "https://hooks.example.test/build",
                secret: "secret",
                endpointOrgId: "org-1",
              }])),
            }),
          }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn((values: Record<string, unknown>) => {
          updates.push(values);
          status = String(values["status"]);
          return { where: jest.fn().mockResolvedValue(undefined) };
        }),
      }),
    } as unknown as Db;
    const service = new ProjectsWebhooksDispatchService(db);
    post.mockRejectedValue(new Error("connection reset"));

    await expect(service.handle(event(77))).rejects.toThrow("connection reset");
    expect(status).toBe("failed");
    post.mockReset().mockResolvedValue({ statusCode: 204, responseBody: "" });
    const recoveredWorker = new ProjectsWebhooksDispatchService(db);
    await expect(recoveredWorker.handle(event(77))).resolves.toBeUndefined();
    expect(status).toBe("success");
    await expect(recoveredWorker.handle(event(77))).resolves.toBeUndefined();

    expect(post).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(2);
    expect(post.mock.calls[0]?.[2]).toMatchObject({
      "X-StreamlineOS-Delivery-Id": "77",
    });
  }, 15_000);
});
