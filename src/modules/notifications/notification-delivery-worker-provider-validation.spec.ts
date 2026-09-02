import { NotificationDeliveryWorker, ORG_BATCH_CAP } from "./notification-delivery-worker.service";

jest.mock("../../common/tenant", () => ({
  forEachOrg: jest.fn().mockImplementation(
    async (_db: unknown, _tag: string, fn: (tx: unknown, orgId: string) => Promise<void>) => {
      await fn(makeClaimingTx([{ id: 20, deliveryId: 10 }]), "org-a");
    },
  ),
  withTenant: jest.fn().mockImplementation((_db: unknown, _opts: unknown, fn: () => Promise<unknown>) => fn()),
  runWithTenantContext: jest.fn().mockImplementation((_ctx: unknown, fn: () => Promise<unknown>) => fn()),
}));

jest.mock("../../common/tenant/org-membership", () => ({
  filterOrgMemberIds: jest.fn().mockResolvedValue(["user-1"]),
}));

const updatedSets: Array<Record<string, unknown>> = [];

function makeClaimingTx(rows: Array<{ id: number; deliveryId: number }>) {
  return {
    update: jest.fn().mockImplementation(() => ({
      set: jest.fn().mockImplementation((v: Record<string, unknown>) => ({
        where: jest.fn().mockImplementation(() => {
          updatedSets.push(v);
          return { returning: jest.fn().mockResolvedValue(rows) };
        }),
        returning: jest.fn().mockResolvedValue(rows),
      })),
    })),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
      }),
    }),
  };
}

function makeDelivery() {
  return {
    id: 10,
    orgId: "org-a",
    userId: "user-1",
    membershipId: null,
    eventKey: "build.ticket.comment",
    channel: "EMAIL",
    provider: "SMTP",
    priority: "NORMAL",
    status: "QUEUED",
    recipientAddress: "user@example.com",
    attemptCount: 0,
    maxAttempts: 3,
    expiresAt: null,
    failureCode: null,
    failureMessage: null,
    nextAttemptAt: null,
    metadata: { title: "msg", message: "body", link: null },
    costAmount: null,
    costCurrency: null,
  };
}

function makeDb(delivery: ReturnType<typeof makeDelivery> | null = makeDelivery()) {
  return {
    query: {
      notificationDeliveries: { findFirst: jest.fn().mockResolvedValue(delivery) },
      notificationQueue: { findFirst: jest.fn().mockResolvedValue(undefined) },
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
  };
}

const config = { NOTIFICATIONS_INPROCESS_WORKER: "false", VAPID_PUBLIC_KEY: "" } as never;

describe("NotificationDeliveryWorker — provider response validation", () => {
  const provider = { send: jest.fn() };
  const registry = { get: jest.fn().mockReturnValue(provider) };
  const events = { getBaseDefinition: jest.fn().mockReturnValue({ mandatory: false }) };

  beforeEach(() => {
    jest.clearAllMocks();
    updatedSets.length = 0;
  });

  it("treats an empty provider response ({}) as retryable failure — delivery not SENT, queue requeued", async () => {
    provider.send.mockResolvedValue({});
    const db = makeDb();
    const svc = new NotificationDeliveryWorker(db as never, registry as never, events as never, config);

    const { forEachOrg } = jest.requireMock("../../common/tenant") as { forEachOrg: jest.Mock };
    forEachOrg.mockImplementationOnce(
      async (_db: unknown, _tag: string, fn: (tx: unknown, orgId: string) => Promise<void>) => {
        await fn(makeClaimingTx([{ id: 20, deliveryId: 10 }]), "org-a");
      },
    );

    await svc.processQueue();

    expect(updatedSets.find((s) => s["status"] === "SENT")).toBeUndefined();
    expect(updatedSets.find((s) => s["status"] === "PENDING")).toBeDefined();
  });

  it("treats a provider response with wrong status type ({status: 123}) as retryable failure", async () => {
    provider.send.mockResolvedValue({ status: 123 });
    const db = makeDb();
    const svc = new NotificationDeliveryWorker(db as never, registry as never, events as never, config);

    const { forEachOrg } = jest.requireMock("../../common/tenant") as { forEachOrg: jest.Mock };
    forEachOrg.mockImplementationOnce(
      async (_db: unknown, _tag: string, fn: (tx: unknown, orgId: string) => Promise<void>) => {
        await fn(makeClaimingTx([{ id: 20, deliveryId: 10 }]), "org-a");
      },
    );

    await svc.processQueue();

    expect(updatedSets.find((s) => s["status"] === "SENT")).toBeUndefined();
    expect(updatedSets.find((s) => s["status"] === "PENDING")).toBeDefined();
  });
});

describe("NotificationDeliveryWorker — per-org fairness cap", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updatedSets.length = 0;
  });

  it("still claims the small org's rows in the same tick even when the large org has far more rows than BATCH_SIZE", async () => {
    const orgARows = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, deliveryId: i + 100 }));
    const orgBRows = [
      { id: 61, deliveryId: 200 },
      { id: 62, deliveryId: 201 },
    ];

    const db = makeDb(null);
    const svc = new NotificationDeliveryWorker(db as never, {} as never, {} as never, config);

    const { forEachOrg } = jest.requireMock("../../common/tenant") as { forEachOrg: jest.Mock };
    forEachOrg.mockImplementationOnce(
      async (_db: unknown, _tag: string, fn: (tx: unknown, orgId: string) => Promise<void>) => {
        await fn(makeClaimingTx(orgARows), "org-a");
        await fn(makeClaimingTx(orgBRows), "org-b");
      },
    );

    const result = await svc.processQueue();

    expect(result.processed).toBe(ORG_BATCH_CAP + 2);
  });
});
