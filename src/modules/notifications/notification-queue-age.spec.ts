/**
 * PIPE-012: a delivery past its expiresAt is cancelled, not delivered.
 * PIPE-015: a delivery whose recipient lost membership is cancelled at delivery time.
 *
 * These two paths share the same "cancel rather than fail" posture: nothing broke,
 * the delivery is simply no longer valid.  Both are tested here so that a refactor
 * that removes one check cannot slide past the other's coverage.
 */

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
};

jest.mock("../../common/tenant", () => ({
  forEachOrg: jest.fn().mockImplementation(
    async (_db: unknown, _tag: string, fn: (tx: typeof mockTx, orgId: string) => Promise<void>) => {
      await fn(mockTx, "org-a");
    },
  ),
  withTenant: jest.fn().mockImplementation((_db: unknown, _opts: unknown, fn: () => Promise<unknown>) => fn()),
  runWithTenantContext: jest.fn().mockImplementation((_ctx: unknown, fn: () => Promise<unknown>) => fn()),
}));

jest.mock("../../common/tenant/org-membership", () => ({
  filterOrgMemberIds: jest.fn().mockResolvedValue(["user-1"]),
}));

import { NotificationDeliveryWorker } from "./notification-delivery-worker.service";

const ORG = "org-a";
const DELIVERY_ID = 10;
const QUEUE_JOB_ID = 20;

function makeDelivery(expiresAt: Date | null): Record<string, unknown> {
  return {
    id: DELIVERY_ID,
    orgId: ORG,
    userId: "user-1",
    eventKey: "build.ticket.comment",
    channel: "EMAIL",
    provider: "SMTP",
    priority: "NORMAL",
    status: "QUEUED",
    recipientAddress: "user@example.com",
    attemptCount: 0,
    maxAttempts: 5,
    expiresAt,
    failureCode: null,
    failureMessage: null,
    nextAttemptAt: null,
    metadata: { title: "New comment", message: "body", link: null },
    costAmount: null,
    costCurrency: null,
  };
}

function makeDb(delivery: ReturnType<typeof makeDelivery>): Record<string, unknown> {
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
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
      }),
    }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
    execute: jest.fn().mockResolvedValue([]),
  };
}

const config = { NOTIFICATIONS_INPROCESS_WORKER: "false", VAPID_PUBLIC_KEY: "" } as never;

describe("NotificationDeliveryWorker — PIPE-012: queue-age expiry", () => {
  const provider = { send: jest.fn() };
  const registry = { get: jest.fn().mockReturnValue(provider) };
  const events = { getBaseDefinition: jest.fn().mockReturnValue({ mandatory: false }) };

  beforeEach(() => {
    jest.clearAllMocks();
    updatedSets.length = 0;
  });

  it("cancels a delivery whose expiresAt is in the past — status CANCELLED, failureCode EXPIRED", async () => {
    const pastExpiry = new Date(Date.now() - 60_000);
    const db = makeDb(makeDelivery(pastExpiry));
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

    await svc.processQueue();

    const expiredUpdate = updatedSets.find(
      (s) => s["status"] === "CANCELLED" && s["failureCode"] === "EXPIRED",
    );
    expect(expiredUpdate).toBeDefined();
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("does not cancel a delivery whose expiresAt is in the future", async () => {
    const futureExpiry = new Date(Date.now() + 60_000);
    const delivery = makeDelivery(futureExpiry);
    const db = makeDb(delivery);
    provider.send.mockResolvedValue({ status: "SENT" });
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

    await svc.processQueue();

    const expiredUpdate = updatedSets.find(
      (s) => s["status"] === "CANCELLED" && s["failureCode"] === "EXPIRED",
    );
    expect(expiredUpdate).toBeUndefined();
  });

  it("does not cancel a delivery with no expiresAt", async () => {
    const delivery = makeDelivery(null);
    const db = makeDb(delivery);
    provider.send.mockResolvedValue({ status: "SENT" });
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

    await svc.processQueue();

    const expiredUpdate = updatedSets.find(
      (s) => s["status"] === "CANCELLED" && s["failureCode"] === "EXPIRED",
    );
    expect(expiredUpdate).toBeUndefined();
  });
});

describe("NotificationDeliveryWorker — PIPE-015: membership re-check at delivery time", () => {
  const provider = { send: jest.fn() };
  const registry = { get: jest.fn().mockReturnValue(provider) };
  const events = { getBaseDefinition: jest.fn().mockReturnValue({ mandatory: false }) };

  beforeEach(() => {
    jest.clearAllMocks();
    updatedSets.length = 0;
  });

  it("cancels a delivery when membership is no longer active — status CANCELLED, failureCode MEMBERSHIP_INACTIVE", async () => {
    const { filterOrgMemberIds } = jest.requireMock("../../common/tenant/org-membership") as { filterOrgMemberIds: jest.Mock };
    filterOrgMemberIds.mockResolvedValue([]);

    const delivery = makeDelivery(null);
    const db = makeDb(delivery);
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

    await svc.processQueue();

    const inactiveUpdate = updatedSets.find(
      (s) => s["status"] === "CANCELLED" && s["failureCode"] === "MEMBERSHIP_INACTIVE",
    );
    expect(inactiveUpdate).toBeDefined();
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("delivers when membership is still active", async () => {
    const { filterOrgMemberIds } = jest.requireMock("../../common/tenant/org-membership") as { filterOrgMemberIds: jest.Mock };
    filterOrgMemberIds.mockResolvedValue(["user-1"]);
    provider.send.mockResolvedValue({ status: "SENT" });

    const delivery = makeDelivery(null);
    const db = makeDb(delivery);
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

    await svc.processQueue();

    const inactiveUpdate = updatedSets.find(
      (s) => s["status"] === "CANCELLED" && s["failureCode"] === "MEMBERSHIP_INACTIVE",
    );
    expect(inactiveUpdate).toBeUndefined();
  });
});
