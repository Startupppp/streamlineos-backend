import { NotificationRetentionService } from "./notification-retention.service";
import { NOTIFICATION_RETENTION_POLICY, expiredPartitions } from "./notification-retention-policy";

function makeDb(captured: string[]) {
  return {
    execute: jest.fn((stmt: unknown) => {
      captured.push(JSON.stringify(stmt));
      return Promise.resolve([]);
    }),
  };
}

const leaseRuns = {
  withLease: jest.fn(async (_key: string, _ttl: number, fn: () => Promise<unknown>) => ({
    ran: true as const,
    result: await fn(),
  })),
};

const leaseHeld = {
  withLease: jest.fn().mockResolvedValue({ ran: false as const }),
};

// Far enough past every retention window that both tables have expired partitions.
const WELL_PAST_RETENTION = new Date("2030-01-15T00:00:00Z");

describe("NotificationRetentionService", () => {
  beforeEach(() => jest.clearAllMocks());

  it("issues no DELETE — retention detaches and drops, it does not bulk-delete", async () => {
    const captured: string[] = [];
    const svc = new NotificationRetentionService(makeDb(captured) as never, leaseRuns as never);

    await svc.sweep(WELL_PAST_RETENTION);

    expect(captured.length).toBeGreaterThan(0);
    for (const statement of captured) {
      expect(statement.toUpperCase()).not.toContain("DELETE");
    }
  });

  it("does nothing when another worker holds the lease", async () => {
    const captured: string[] = [];
    const svc = new NotificationRetentionService(makeDb(captured) as never, leaseHeld as never);

    const result = await svc.sweep(WELL_PAST_RETENTION);

    expect(result).toBeNull();
    expect(captured).toHaveLength(0);
  });

  it("covers every table named in the retention policy", async () => {
    const captured: string[] = [];
    const svc = new NotificationRetentionService(makeDb(captured) as never, leaseRuns as never);

    const result = await svc.sweep(WELL_PAST_RETENTION);

    expect(result).not.toBeNull();
    expect(Object.keys(result!.tables).sort()).toEqual(
      Object.keys(NOTIFICATION_RETENTION_POLICY).sort(),
    );
  });

  it("does not schedule the pending notification outbox for partition deletion", () => {
    expect(Object.keys(NOTIFICATION_RETENTION_POLICY)).not.toContain("notification_outbox");
  });

  it("emits no DETACH PARTITION IF EXISTS — that is not valid Postgres", async () => {
    const captured: string[] = [];
    const dbWithPartitions = {
      execute: jest.fn((stmt: unknown) => {
        const text = JSON.stringify(stmt);
        captured.push(text);
        if (text.includes("to_regclass")) return Promise.resolve([{ present: true }]);
        return Promise.resolve([]);
      }),
    };
    const svc = new NotificationRetentionService(dbWithPartitions as never, leaseRuns as never);

    await svc.sweep(WELL_PAST_RETENTION);

    const detaches = captured.filter((c) => c.toUpperCase().includes("DETACH PARTITION"));
    expect(detaches.length).toBeGreaterThan(0);
    for (const statement of detaches)
      expect(statement.toUpperCase()).not.toContain("DETACH PARTITION IF EXISTS");
  });

  it("probes for the partition before claiming it detached one", async () => {
    const captured: string[] = [];
    const svc = new NotificationRetentionService(makeDb(captured) as never, leaseRuns as never);

    const result = await svc.sweep(WELL_PAST_RETENTION);

    expect(captured.some((c) => c.includes("to_regclass"))).toBe(true);
    expect(result?.partitionsDetached).toBe(0);
  });

  it("retains partitions that are still inside their window", async () => {
    for (const table of Object.keys(NOTIFICATION_RETENTION_POLICY)) {
      const justCreated = expiredPartitions(
        table as keyof typeof NOTIFICATION_RETENTION_POLICY,
        new Date("2020-01-15T00:00:00Z"),
      );
      expect(justCreated).toEqual([]);
    }
  });
});
