import type { Db } from "../../../db/drizzle.module";
import { postSafeWebhook } from "../../../common/outbound/safe-webhook-transport";
import {
  MISSING_SIGNING_SECRET_ERROR,
  ProjectsWebhooksDispatchService,
} from "./projects-webhooks-dispatch.service";

jest.mock("../../../common/outbound/safe-webhook-transport", () => {
  const actual = jest.requireActual("../../../common/outbound/safe-webhook-transport");
  return { ...actual, postSafeWebhook: jest.fn() };
});

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(
    (_db: unknown, callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        insert: () => ({
          values: () => ({ returning: () => Promise.resolve([{ id: 77 }]) }),
        }),
      }),
  ),
}));

jest.mock("../../../common/outbox/outbox-writer", () => ({
  OutboxWriter: { emit: jest.fn().mockResolvedValue(undefined) },
}));

const post = postSafeWebhook as jest.MockedFunction<typeof postSafeWebhook>;

function dispatchServiceWithSecret(secret: string | null) {
  const endpointRow = {
    id: 5,
    url: "https://hooks.example.test/build",
    secret,
    orgId: "org-1",
    projectId: 9,
  };
  const deliveryRow = {
    deliveryId: 77,
    event: "webhook.test",
    payload: { id: 5, projectId: 9, actor: "system", timestamp: "now" },
    status: "pending",
    endpointId: 5,
    url: "https://hooks.example.test/build",
    secret,
    endpointOrgId: "org-1",
  };
  const set = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
  const db = {
    select: jest
      .fn()
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([endpointRow]) }),
          innerJoin: () => ({ where: () => ({ limit: () => Promise.resolve([deliveryRow]) }) }),
        }),
      })
      .mockReturnValue({
        from: () => ({
          innerJoin: () => ({ where: () => ({ limit: () => Promise.resolve([deliveryRow]) }) }),
        }),
      }),
    update: jest.fn().mockReturnValue({ set }),
  } as unknown as Db;
  return { service: new ProjectsWebhooksDispatchService(db), set };
}

describe("ProjectsWebhooksDispatchService signing secret", () => {
  beforeEach(() => post.mockReset());

  it("signs and sends when the endpoint has a secret", async () => {
    const { service } = dispatchServiceWithSecret("s3cret");
    post.mockResolvedValue({ statusCode: 204, responseBody: "" });

    const result = await service.sendTest("org-1", 9, 5);

    expect(post).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, responseCode: 204 });
  });

  it("sends a non-empty hex signature header when the endpoint has a secret", async () => {
    const { service } = dispatchServiceWithSecret("s3cret");
    post.mockResolvedValue({ statusCode: 204, responseBody: "" });

    await service.sendTest("org-1", 9, 5);

    const headers = post.mock.calls[0]![2] as Record<string, string>;
    expect(headers["X-StreamlineOS-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("refuses to deliver when the endpoint has no signing secret", async () => {
    const { service } = dispatchServiceWithSecret(null);

    const result = await service.sendTest("org-1", 9, 5);

    expect(post).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it("refuses to deliver when the signing secret is an empty string", async () => {
    const { service } = dispatchServiceWithSecret("");

    const result = await service.sendTest("org-1", 9, 5);

    expect(post).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it("records a readable failure reason on the delivery row instead of a silent drop", async () => {
    const { service, set } = dispatchServiceWithSecret(null);

    await service.sendTest("org-1", 9, 5);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", lastError: MISSING_SIGNING_SECRET_ERROR }),
    );
  });

  it("does not throw a retryable error for a missing secret, because no retry can mint one", async () => {
    const { service } = dispatchServiceWithSecret(null);

    await expect(service.handle({
      outboxEventId: 1,
      eventId: "11111111-1111-4111-8111-111111111111",
      organizationId: "org-1",
      aggregateType: "project_webhook_delivery",
      aggregateId: "77",
      aggregateVersion: 77,
      schemaVersion: 1,
      causationId: null,
      correlationId: null,
      actorMembershipId: null,
      audience: "INTERNAL",
      lifecycleState: "ACTIVE",
      deliveryState: "IN_FLIGHT",
      eventType: "build.project-webhook.delivery.requested",
      payload: { deliveryId: 77 },
      occurredAt: new Date(),
      publishedAt: null,
      leaseExpiresAt: new Date(Date.now() + 30_000),
      retryCount: 0,
      lastError: null,
      deadLetteredAt: null,
      createdAt: new Date(),
    })).resolves.toBeUndefined();
    expect(post).not.toHaveBeenCalled();
  });
});
