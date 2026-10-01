import type { Db } from "../../../../db/drizzle.module";
import { postSafeWebhook } from "../../../../common/outbound/safe-webhook-transport";
import {
  MISSING_SIGNING_SECRET_ERROR,
  ProjectsWebhooksDispatchService,
} from "./projects-webhooks-dispatch.service";
import { INTEGRATIONS_WEBHOOK_DELIVERY_EVENT } from "../../../integrations/core/webhook-delivery.service";

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
  OutboxWriter: { emit: jest.fn().mockResolvedValue(undefined) },
}));

const post = postSafeWebhook as jest.MockedFunction<typeof postSafeWebhook>;

function dispatchServiceWith(
  signingSecret: string | null,
  integrationsEndpointId: number | null = signingSecret !== null ? 5 : null,
) {
  const endpointRow = {
    id: 5,
    url: "https://hooks.example.test/build",
    orgId: "org-1",
    integrationsEndpointId,
  };
  const credentialRow = signingSecret !== null ? { signingSecret } : undefined;
  const set = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
  const db = {
    select: jest
      .fn()
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve(integrationsEndpointId !== null ? [endpointRow] : [endpointRow]),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve(credentialRow ? [credentialRow] : []) }),
        }),
      })
      .mockReturnValue({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([]) }),
        }),
      }),
    update: jest.fn().mockReturnValue({ set }),
  } as unknown as Db;
  return { service: new ProjectsWebhooksDispatchService(db), set };
}

describe("ProjectsWebhooksDispatchService signing secret", () => {
  beforeEach(() => post.mockReset());

  it("signs and sends when the endpoint has a signing secret in the credentials store", async () => {
    const { service } = dispatchServiceWith("s3cret");
    post.mockResolvedValue({ statusCode: 204, responseBody: "" });

    const result = await service.sendTest("org-1", 9, 5);

    expect(post).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, responseCode: 204 });
  });

  it("sends a non-empty hex signature header when the endpoint has a signing secret", async () => {
    const { service } = dispatchServiceWith("s3cret");
    post.mockResolvedValue({ statusCode: 204, responseBody: "" });

    await service.sendTest("org-1", 9, 5);

    const headers = post.mock.calls[0]![2] as Record<string, string>;
    expect(headers["X-StreamlineOS-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("refuses to deliver and records the error when the endpoint has no integrations_endpoint_id", async () => {
    const { service } = dispatchServiceWith(null, null);

    const result = await service.sendTest("org-1", 9, 5);

    expect(post).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it("refuses to deliver when the credentials store returns no row for the endpoint", async () => {
    const { service } = dispatchServiceWith(null, 5);

    const result = await service.sendTest("org-1", 9, 5);

    expect(post).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it("records a readable failure reason on the delivery row instead of a silent drop", async () => {
    const { service, set } = dispatchServiceWith(null, null);

    await service.sendTest("org-1", 9, 5);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", lastError: MISSING_SIGNING_SECRET_ERROR }),
    );
  });

  it("emits the delivery outbox event with the integrations event type, not the legacy build type", async () => {
    const { OutboxWriter } = jest.requireMock(
      "../../../../common/outbox/outbox-writer",
    ) as { OutboxWriter: { emit: jest.Mock } };
    OutboxWriter.emit.mockClear();
    const { service } = dispatchServiceWith("s3cret");
    post.mockResolvedValue({ statusCode: 204, responseBody: "" });

    await service.sendTest("org-1", 9, 5);

    const emittedEvent = OutboxWriter.emit.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(emittedEvent?.eventType).toBe(INTEGRATIONS_WEBHOOK_DELIVERY_EVENT);
  });
});
