import { NotificationDeliveryWorker } from "./notification-delivery-worker.service";

jest.mock("../../common/tenant", () => ({
  forEachOrg: jest.fn().mockImplementation(
    async (_db: unknown, _tag: string, fn: (tx: unknown, orgId: string) => Promise<void>) => {
      await fn(mockTx, "org-a");
    },
  ),
  withTenant: jest.fn().mockImplementation((_db: unknown, _opts: unknown, fn: () => Promise<unknown>) => fn()),
  runWithTenantContext: jest.fn().mockImplementation((_ctx: unknown, fn: () => Promise<unknown>) => fn()),
}));

jest.mock("../../common/tenant/org-membership", () => ({
  filterOrgMemberIds: jest.fn().mockResolvedValue(["user-1"]),
}));

const ORG = "org-a";
const DELIVERY_ID = 10;
const QUEUE_JOB_ID = 20;
const MAX_ATTEMPTS = 3;

const updatedSets: Array<Record<string, unknown>> = [];

const mockTx = {
  update: jest.fn().mockImplementation(() => ({
    set: jest.fn().mockImplementation((v: Record<string, unknown>) => {
      updatedSets.push(v);
      return { where: jest.fn().mockResolvedValue([]) };
    }),
  })),
  select: jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue([]),
      }),
    }),
  }),
  insert: jest.fn().mockReturnValue({
    values: jest.fn().mockResolvedValue([]),
  }),
};

function makeDelivery(attemptCount: number) {
  return {
    id: DELIVERY_ID,
    orgId: ORG,
    userId: "user-1",
    membershipId: null,
    eventKey: "build.ticket.comment",
    channel: "EMAIL",
    provider: "SMTP",
    priority: "NORMAL",
    status: "QUEUED",
    recipientAddress: "user@example.com",
    attemptCount,
    maxAttempts: MAX_ATTEMPTS,
    expiresAt: null,
    failureCode: null,
    failureMessage: null,
    nextAttemptAt: null,
    metadata: { title: "New comment", message: "body", link: null },
    costAmount: null,
    costCurrency: null,
  };
}

function makeDb(delivery: ReturnType<typeof makeDelivery>) {
  return {
    query: {
      notificationDeliveries: {
        findFirst: jest.fn().mockResolvedValue(delivery),
      },
      notificationQueue: {
        findFirst: jest.fn().mockResolvedValue({ id: QUEUE_JOB_ID }),
      },
    },
    update: jest.fn().mockImplementation(() => ({
      set: jest.fn().mockImplementation((v: Record<string, unknown>) => {
        updatedSets.push(v);
        return { where: jest.fn().mockResolvedValue([]) };
      }),
    })),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockResolvedValue([]),
    }),
  };
}

const config = { NOTIFICATIONS_INPROCESS_WORKER: "false", VAPID_PUBLIC_KEY: "" } as never;

describe("NotificationDeliveryWorker — retry bounded and non-duplicating", () => {
  const provider = {
    send: jest.fn(),
  };
  const registry = { get: jest.fn().mockReturnValue(provider) };
  const events = { getBaseDefinition: jest.fn().mockReturnValue({ mandatory: false }) };

  beforeEach(() => {
    jest.clearAllMocks();
    updatedSets.length = 0;
  });

  it("moves to DEAD when the maximum attempt count is reached instead of requeueing", async () => {
    const delivery = makeDelivery(MAX_ATTEMPTS - 1);
    const db = makeDb(delivery);
    provider.send.mockResolvedValue({ status: "FAILED", retryable: true, failureCode: "TIMEOUT", failureMessage: "timed out" });

    const svc = new NotificationDeliveryWorker(db as never, registry as never, events as never, config);

    const claimed = [{ id: QUEUE_JOB_ID, deliveryId: DELIVERY_ID, orgId: ORG }];
    const { forEachOrg } = jest.requireMock("../../common/tenant") as { forEachOrg: jest.Mock };
    forEachOrg.mockImplementationOnce(
      async (_db: unknown, _tag: string, fn: (tx: typeof mockTx, orgId: string) => Promise<void>) => {
        await fn(
          {
            ...mockTx,
            update: jest.fn().mockImplementation(() => ({
              set: jest.fn().mockImplementation((v: Record<string, unknown>) => ({
                where: jest.fn().mockImplementation(() => {
                  updatedSets.push(v);
                  return { returning: jest.fn().mockResolvedValue(claimed) };
                }),
                returning: jest.fn().mockResolvedValue(claimed),
              })),
            })),
          } as unknown as typeof mockTx,
          ORG,
        );
      },
    );

    const result = await svc.processQueue();

    expect(result.dead).toBe(1);
    expect(result.failed).toBe(0);
    const deadUpdate = updatedSets.find((s) => s["status"] === "DEAD");
    expect(deadUpdate).toBeDefined();
  });

  it("requeues with backoff below the maximum attempt count, not dead-letters", async () => {
    const delivery = makeDelivery(0);
    const db = makeDb(delivery);
    provider.send.mockResolvedValue({ status: "FAILED", retryable: true, failureCode: "TIMEOUT", failureMessage: "timed out" });

    const svc = new NotificationDeliveryWorker(db as never, registry as never, events as never, config);

    const claimed = [{ id: QUEUE_JOB_ID, deliveryId: DELIVERY_ID, orgId: ORG }];
    const { forEachOrg } = jest.requireMock("../../common/tenant") as { forEachOrg: jest.Mock };
    forEachOrg.mockImplementationOnce(
      async (_db: unknown, _tag: string, fn: (tx: typeof mockTx, orgId: string) => Promise<void>) => {
        await fn(
          {
            ...mockTx,
            update: jest.fn().mockImplementation(() => ({
              set: jest.fn().mockImplementation((v: Record<string, unknown>) => ({
                where: jest.fn().mockImplementation(() => {
                  updatedSets.push(v);
                  return { returning: jest.fn().mockResolvedValue(claimed) };
                }),
                returning: jest.fn().mockResolvedValue(claimed),
              })),
            })),
          } as unknown as typeof mockTx,
          ORG,
        );
      },
    );

    const result = await svc.processQueue();

    expect(result.dead).toBe(0);
    const pendingUpdate = updatedSets.find((s) => s["status"] === "PENDING");
    expect(pendingUpdate).toBeDefined();
    const runAt = pendingUpdate?.["runAt"];
    expect(runAt instanceof Date ? runAt.getTime() : 0).toBeGreaterThan(Date.now());
  });
});
