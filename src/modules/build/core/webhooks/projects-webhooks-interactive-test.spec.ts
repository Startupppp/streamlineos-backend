import type { Db } from "../../../../db/drizzle.module";
import { postSafeWebhook } from "../../../../common/outbound/safe-webhook-transport";
import { WebhookEndpointService } from "../../../integrations/core/webhook-endpoint.service";

jest.mock("../../../../common/outbound/safe-webhook-transport", () => {
  const actual = jest.requireActual("../../../../common/outbound/safe-webhook-transport");
  return { ...actual, postSafeWebhook: jest.fn() };
});

jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(
    (_db: unknown, callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        insert: () => ({
          values: () => ({ returning: () => Promise.resolve([{ id: 77 }]) }),
        }),
      }),
  ),
}));

const post = postSafeWebhook as jest.MockedFunction<typeof postSafeWebhook>;

function endpointServiceWithSecret(): { service: WebhookEndpointService } {
  const credentialRow = { signingSecret: "secret" };
  const db = {
    select: jest
      .fn()
      .mockReturnValueOnce({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([credentialRow]) }) }),
      })
      .mockReturnValue({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
      }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    }),
  } as unknown as Db;
  return { service: new WebhookEndpointService(db) };
}

describe("WebhookEndpointService interactive test delivery constraints", () => {
  beforeEach(() => post.mockReset());

  it("makes exactly one attempt so an unresponsive customer URL cannot hold a pooled connection for minutes", async () => {
    const { service } = endpointServiceWithSecret();
    post.mockRejectedValue(new Error("connection reset"));

    const result = await service.sendTestDelivery(
      "org-1", 5, 7, "https://hooks.example.test/build",
      { id: 5, projectId: 9, actor: "system", timestamp: new Date().toISOString() },
    );

    expect(post).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
  }, 20_000);

  it("waits half as long as a background delivery because a user is holding the connection open", async () => {
    const { service } = endpointServiceWithSecret();
    post.mockResolvedValue({ statusCode: 204, responseBody: "" });

    await service.sendTestDelivery(
      "org-1", 5, 7, "https://hooks.example.test/build",
      { id: 5, projectId: 9, actor: "system", timestamp: new Date().toISOString() },
    );

    const timeoutMs = post.mock.calls[0]![3];
    expect(timeoutMs).toBe(5_000);
    expect(timeoutMs).toBeLessThan(10_000);
  });

  it("returns the response code on the happy path so the interactive contract is unchanged", async () => {
    const { service } = endpointServiceWithSecret();
    post.mockResolvedValue({ statusCode: 204, responseBody: "" });

    const result = await service.sendTestDelivery(
      "org-1", 5, 7, "https://hooks.example.test/build",
      { id: 5, projectId: 9, actor: "system", timestamp: new Date().toISOString() },
    );

    expect(result).toEqual({ success: true, responseCode: 204 });
    expect(post).toHaveBeenCalledTimes(1);
  });
});
