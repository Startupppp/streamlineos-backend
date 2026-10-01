import { OutboxConsumerRegistry } from "../../../../common/outbox/outbox-consumer.registry";
import type { Db } from "../../../../db/drizzle.module";
import { postSafeWebhook } from "../../../../common/outbound/safe-webhook-transport";
import { ProjectsWebhooksDispatchService } from "./projects-webhooks-dispatch.service";
import { WebhookDeliveryService, MISSING_SIGNING_SECRET_ERROR } from "../../../integrations/core/webhook-delivery.service";
import { WebhookEndpointService } from "../../../integrations/core/webhook-endpoint.service";

jest.mock("../../../../common/outbound/safe-webhook-transport", () => {
  const actual = jest.requireActual("../../../../common/outbound/safe-webhook-transport");
  return { ...actual, postSafeWebhook: jest.fn() };
});

const post = postSafeWebhook as jest.MockedFunction<typeof postSafeWebhook>;

describe("ProjectsWebhooksDispatchService durable outbox", () => {
  beforeEach(() => post.mockReset());

  it("calls webhookEndpoint.requestDeliveries with delivery intents for each active wired endpoint, without network I/O", async () => {
    const requestDeliveries = jest.fn().mockResolvedValue(undefined);
    const tx = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([
            { id: 5, events: ["ticket.created"], url: "https://hooks.example.test", integrationsEndpointId: 3 },
          ]),
        }),
      }),
    };
    const service = new ProjectsWebhooksDispatchService(
      {} as Db,
      { requestDeliveries } as unknown as WebhookEndpointService,
    );

    await service.enqueue(tx as never, "org-1", 9, "ticket.created", {
      id: 12,
      projectId: 9,
      actor: "member-1",
      timestamp: new Date().toISOString(),
    });

    expect(requestDeliveries).toHaveBeenCalledTimes(1);
    expect(requestDeliveries.mock.calls[0]?.[2]).toEqual([
      expect.objectContaining({ credentialId: 3, buildWebhookId: 5, targetUrl: "https://hooks.example.test", event: "ticket.created" }),
    ]);
    expect(post).not.toHaveBeenCalled();
  });

  it("skips a webhook endpoint that has no integrations_endpoint_id so pre-backfill rows do not cause delivery failures", async () => {
    const requestDeliveries = jest.fn();
    const tx = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([
            { id: 5, events: ["ticket.created"], url: "https://hooks.example.test", integrationsEndpointId: null },
          ]),
        }),
      }),
    };
    const service = new ProjectsWebhooksDispatchService(
      {} as Db,
      { requestDeliveries } as unknown as WebhookEndpointService,
    );

    await service.enqueue(tx as never, "org-1", 9, "ticket.created", {
      id: 12,
      projectId: 9,
      actor: "member-1",
      timestamp: new Date().toISOString(),
    });

    expect(requestDeliveries).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("WebhookDeliveryService registers the outbox consumer with the registry so background deliveries are routed", () => {
    const registry = new OutboxConsumerRegistry();
    const service = new WebhookDeliveryService({} as Db, registry);
    service.onModuleInit();
    expect(registry.get("integrations.webhook.delivery.requested")).toBe(service);
  });
});

describe("WebhookDeliveryService durable outbox", () => {
  beforeEach(() => post.mockReset());

  it("retries a failed row and suppresses a duplicate after success", async () => {
    let status = "pending";
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          leftJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockImplementation(() =>
                Promise.resolve([
                  {
                    deliveryId: 77,
                    event: "ticket.created",
                    payload: { id: 12, projectId: 9 },
                    status,
                    credentialId: 3,
                    targetUrl: "https://hooks.example.test/build",
                    signingSecret: "secret",
                  },
                ]),
              ),
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

    const outboxEvent = {
      outboxEventId: 1,
      eventId: "11111111-1111-4111-8111-111111111111",
      organizationId: "org-1",
      aggregateType: "integration_webhook_delivery",
      aggregateId: "77",
      aggregateVersion: 77,
      schemaVersion: 1,
      causationId: null,
      correlationId: null,
      actorMembershipId: null,
      audience: "INTERNAL" as const,
      lifecycleState: "ACTIVE" as const,
      deliveryState: "IN_FLIGHT" as const,
      eventType: "integrations.webhook.delivery.requested",
      payload: { deliveryId: 77, orgId: "org-1" },
      occurredAt: new Date(),
      publishedAt: null,
      leaseExpiresAt: new Date(Date.now() + 30_000),
      retryCount: 0,
      lastError: null,
      deadLetteredAt: null,
      createdAt: new Date(),
    };

    const service = new WebhookDeliveryService(db);
    post.mockRejectedValue(new Error("connection reset"));

    await expect(service.handle(outboxEvent)).rejects.toThrow("connection reset");
    expect(status).toBe("failed");

    post.mockReset().mockResolvedValue({ statusCode: 204, responseBody: "" });
    const recovered = new WebhookDeliveryService(db);
    await expect(recovered.handle(outboxEvent)).resolves.toBeUndefined();
    expect(status).toBe("success");

    await expect(recovered.handle(outboxEvent)).resolves.toBeUndefined();
    expect(post).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(2);
    expect(post.mock.calls[0]?.[2]).toMatchObject({
      "X-StreamlineOS-Delivery-Id": "77",
    });
  }, 15_000);

  it("records MISSING_SIGNING_SECRET_ERROR and does not call the network when the credential has no secret", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          leftJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([
                {
                  deliveryId: 77,
                  event: "webhook.test",
                  payload: {},
                  status: "pending",
                  credentialId: null,
                  targetUrl: "https://hooks.example.test/build",
                  signingSecret: null,
                },
              ]),
            }),
          }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn((values: Record<string, unknown>) => {
          updates.push(values);
          return { where: jest.fn().mockResolvedValue(undefined) };
        }),
      }),
    } as unknown as Db;

    const outboxEvent = {
      outboxEventId: 1,
      eventId: "22222222-2222-4222-8222-222222222222",
      organizationId: "org-1",
      aggregateType: "integration_webhook_delivery",
      aggregateId: "77",
      aggregateVersion: 77,
      schemaVersion: 1,
      causationId: null,
      correlationId: null,
      actorMembershipId: null,
      audience: "INTERNAL" as const,
      lifecycleState: "ACTIVE" as const,
      deliveryState: "IN_FLIGHT" as const,
      eventType: "integrations.webhook.delivery.requested",
      payload: { deliveryId: 77, orgId: "org-1" },
      occurredAt: new Date(),
      publishedAt: null,
      leaseExpiresAt: new Date(Date.now() + 30_000),
      retryCount: 0,
      lastError: null,
      deadLetteredAt: null,
      createdAt: new Date(),
    };

    const service = new WebhookDeliveryService(db);
    await expect(service.handle(outboxEvent)).resolves.toBeUndefined();

    expect(post).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({
      status: "failed",
      lastError: MISSING_SIGNING_SECRET_ERROR,
    });
  });
});
