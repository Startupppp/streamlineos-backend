import type { Db } from "../../../../db/drizzle.module";
import { postSafeWebhook } from "../../../../common/outbound/safe-webhook-transport";
import {
  MISSING_SIGNING_SECRET_ERROR,
} from "../../../integrations/core/webhook-delivery.service";
import { WebhookEndpointService } from "../../../integrations/core/webhook-endpoint.service";

jest.mock("../../../../common/outbound/safe-webhook-transport", () => {
  const actual = jest.requireActual("../../../../common/outbound/safe-webhook-transport");
  return { ...actual, postSafeWebhook: jest.fn() };
});

jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(
    (_db: unknown, callback: (tx: unknown) => Promise<unknown>, _opts: unknown) =>
      callback({
        insert: () => ({
          values: () => ({ returning: () => Promise.resolve([{ id: 77 }]) }),
        }),
      }),
  ),
}));

jest.mock("../../../../common/outbox/outbox-writer", () => ({
  OutboxWriter: { emit: jest.fn().mockResolvedValue(undefined), emitMany: jest.fn().mockResolvedValue(undefined) },
}));

const post = postSafeWebhook as jest.MockedFunction<typeof postSafeWebhook>;

function endpointServiceWith(
  signingSecret: string | null,
  credentialId: number | null = signingSecret !== null ? 5 : null,
) {
  const credentialRow = signingSecret !== null ? { signingSecret } : undefined;
  const set = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
  const db = {
    select: jest
      .fn()
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(credentialRow ? [credentialRow] : []),
          }),
        }),
      })
      .mockReturnValue({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([]) }),
        }),
      }),
    update: jest.fn().mockReturnValue({ set }),
  } as unknown as Db;
  return { service: new WebhookEndpointService(db), set, credentialId };
}

describe("WebhookEndpointService interactive test delivery", () => {
  beforeEach(() => post.mockReset());

  it("signs and sends when the endpoint has a signing secret in the credentials store", async () => {
    const { service, credentialId } = endpointServiceWith("s3cret");
    post.mockResolvedValue({ statusCode: 204, responseBody: "" });

    const result = await service.sendTestDelivery("org-1", 5, credentialId, "https://hooks.example.test/build", {
      id: 5, projectId: 9, actor: "system", timestamp: new Date().toISOString(),
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, responseCode: 204 });
  });

  it("sends a non-empty hex signature header when the endpoint has a signing secret", async () => {
    const { service, credentialId } = endpointServiceWith("s3cret");
    post.mockResolvedValue({ statusCode: 204, responseBody: "" });

    await service.sendTestDelivery("org-1", 5, credentialId, "https://hooks.example.test/build", {
      id: 5, projectId: 9, actor: "system", timestamp: new Date().toISOString(),
    });

    const headers = post.mock.calls[0]![2] as Record<string, string>;
    expect(headers["X-StreamlineOS-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("refuses to deliver and records the error when credentialId is null so no secret can be fetched", async () => {
    const { service, set } = endpointServiceWith(null, null);

    const result = await service.sendTestDelivery("org-1", 5, null, "https://hooks.example.test/build", {
      id: 5, projectId: 9, actor: "system", timestamp: new Date().toISOString(),
    });

    expect(post).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", lastError: MISSING_SIGNING_SECRET_ERROR }),
    );
  });

  it("refuses to deliver when the credentials store returns no row for the credential id", async () => {
    const { service } = endpointServiceWith(null, 5);

    const result = await service.sendTestDelivery("org-1", 5, 5, "https://hooks.example.test/build", {
      id: 5, projectId: 9, actor: "system", timestamp: new Date().toISOString(),
    });

    expect(post).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it("does not emit an outbox event so the test endpoint receives exactly one delivery and never a background retry", async () => {
    const { OutboxWriter } = jest.requireMock(
      "../../../../common/outbox/outbox-writer",
    ) as { OutboxWriter: { emit: jest.Mock; emitMany: jest.Mock } };
    OutboxWriter.emit.mockClear();
    OutboxWriter.emitMany.mockClear();

    const { service, credentialId } = endpointServiceWith("s3cret");
    post.mockResolvedValue({ statusCode: 204, responseBody: "" });

    await service.sendTestDelivery("org-1", 5, credentialId, "https://hooks.example.test/build", {
      id: 5, projectId: 9, actor: "system", timestamp: new Date().toISOString(),
    });

    expect(OutboxWriter.emit).not.toHaveBeenCalled();
    expect(OutboxWriter.emitMany).not.toHaveBeenCalled();
  });
});
