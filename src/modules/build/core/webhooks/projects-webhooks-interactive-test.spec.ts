import type { Db } from "../../../../db/drizzle.module";
import { postSafeWebhook } from "../../../../common/outbound/safe-webhook-transport";
import { ProjectsWebhooksDispatchService } from "./projects-webhooks-dispatch.service";

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

jest.mock("../../../../common/outbox/outbox-writer", () => ({
  OutboxWriter: { emit: jest.fn().mockResolvedValue(undefined) },
}));

const post = postSafeWebhook as jest.MockedFunction<typeof postSafeWebhook>;

function dispatchServiceWithOneEndpoint(): { service: ProjectsWebhooksDispatchService } {
  const endpointRow = {
    id: 5,
    url: "https://hooks.example.test/build",
    orgId: "org-1",
    integrationsEndpointId: 7,
  };
  const credentialRow = { signingSecret: "secret" };
  const db = {
    select: jest
      .fn()
      .mockReturnValueOnce({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([endpointRow]) }) }),
      })
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
  return { service: new ProjectsWebhooksDispatchService(db) };
}

describe("ProjectsWebhooksDispatchService interactive test delivery", () => {
  beforeEach(() => post.mockReset());

  it("makes exactly one attempt so an unresponsive customer URL cannot hold a pooled connection for minutes", async () => {
    const { service } = dispatchServiceWithOneEndpoint();
    post.mockRejectedValue(new Error("connection reset"));

    const result = await service.sendTest("org-1", 9, 5);

    expect(post).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
  }, 20_000);

  it("waits half as long as a background delivery, because a user is holding the connection open", async () => {
    const { service } = dispatchServiceWithOneEndpoint();
    post.mockResolvedValue({ statusCode: 204, responseBody: "" });

    await service.sendTest("org-1", 9, 5);

    const timeoutMs = post.mock.calls[0]![3];
    expect(timeoutMs).toBe(5_000);
    expect(timeoutMs).toBeLessThan(10_000);
  });

  it("still returns the response code on the happy path, so the interactive contract is unchanged", async () => {
    const { service } = dispatchServiceWithOneEndpoint();
    post.mockResolvedValue({ statusCode: 204, responseBody: "" });

    const result = await service.sendTest("org-1", 9, 5);

    expect(result).toEqual({ success: true, responseCode: 204 });
    expect(post).toHaveBeenCalledTimes(1);
  });
});
