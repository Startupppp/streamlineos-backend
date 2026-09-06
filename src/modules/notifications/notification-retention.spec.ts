import { Logger } from "@nestjs/common";
import { NotificationRetentionService } from "./notification-retention.service";
import { PartitionMaintenanceService } from "./partition-maintenance.service";
import { NOTIFICATION_RETENTION_POLICY, expiredPartitions } from "./notification-retention-policy";

jest.mock("postgres");

import postgres from "postgres";

const mockedPostgresFactory = postgres as jest.Mock;

const leaseRuns = {
  withLease: jest.fn(async (_key: string, _ttl: number, fn: () => Promise<unknown>) => ({
    ran: true as const,
    result: await fn(),
  })),
};

const leaseHeld = {
  withLease: jest.fn().mockResolvedValue({ ran: false as const }),
};

const WELL_PAST_RETENTION = new Date("2030-01-15T00:00:00Z");

function makeMaintenanceMock(result = { detached: 0, dropped: 0 }) {
  return { sweepParent: jest.fn().mockResolvedValue(result) };
}

describe("NotificationRetentionService", () => {
  beforeEach(() => jest.clearAllMocks());

  it("delegates to PartitionMaintenanceService — issues no DELETE itself", async () => {
    const maintenance = makeMaintenanceMock();
    const svc = new NotificationRetentionService(maintenance as never, leaseRuns as never);

    await svc.sweep(WELL_PAST_RETENTION);

    expect(maintenance.sweepParent).toHaveBeenCalled();
  });

  it("does nothing when another worker holds the lease", async () => {
    const maintenance = makeMaintenanceMock();
    const svc = new NotificationRetentionService(maintenance as never, leaseHeld as never);

    const result = await svc.sweep(WELL_PAST_RETENTION);

    expect(result).toBeNull();
    expect(maintenance.sweepParent).not.toHaveBeenCalled();
  });

  it("covers every table named in the retention policy", async () => {
    const maintenance = makeMaintenanceMock();
    const svc = new NotificationRetentionService(maintenance as never, leaseRuns as never);

    const result = await svc.sweep(WELL_PAST_RETENTION);

    expect(result).not.toBeNull();
    expect(Object.keys(result!.tables).sort()).toEqual(
      Object.keys(NOTIFICATION_RETENTION_POLICY).sort(),
    );
  });

  it("does not schedule the pending notification outbox for partition deletion", () => {
    expect(Object.keys(NOTIFICATION_RETENTION_POLICY)).not.toContain("notification_outbox");
  });

  it("passes the full expired-partition list per table to sweepParent", async () => {
    const maintenance = makeMaintenanceMock();
    const svc = new NotificationRetentionService(maintenance as never, leaseRuns as never);

    await svc.sweep(WELL_PAST_RETENTION);

    for (const [table] of Object.entries(NOTIFICATION_RETENTION_POLICY)) {
      const expected = expiredPartitions(table as keyof typeof NOTIFICATION_RETENTION_POLICY, WELL_PAST_RETENTION);
      const call = maintenance.sweepParent.mock.calls.find(([t]) => t === table);
      expect(call).toBeDefined();
      expect(call![1]).toEqual(expected);
    }
  });

  it("probes via sweepParent and returns 0 detached when maintenance returns 0", async () => {
    const maintenance = makeMaintenanceMock({ detached: 0, dropped: 0 });
    const svc = new NotificationRetentionService(maintenance as never, leaseRuns as never);

    const result = await svc.sweep(WELL_PAST_RETENTION);

    expect(maintenance.sweepParent).toHaveBeenCalled();
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

  it("accumulates detach/drop counts across tables", async () => {
    const maintenance = { sweepParent: jest.fn().mockResolvedValue({ detached: 3, dropped: 3 }) };
    const svc = new NotificationRetentionService(maintenance as never, leaseRuns as never);

    const result = await svc.sweep(WELL_PAST_RETENTION);

    expect(result?.partitionsDetached).toBeGreaterThan(0);
    expect(result?.partitionsDropped).toBeGreaterThan(0);
  });
});

function makePostgresClient(opts: {
  hasDefault?: boolean;
  probeResult?: boolean;
  throwOnDetach?: boolean;
  detachError?: Error & { code?: string };
} = {}) {
  const unsafeStatements: string[] = [];
  const tagStatements: string[] = [];
  const end = jest.fn().mockResolvedValue(undefined);

  const unsafe = jest.fn().mockImplementation(async (sql: string) => {
    unsafeStatements.push(sql);
    if ((opts.throwOnDetach || opts.detachError) && sql.toUpperCase().includes("DETACH PARTITION")) {
      throw opts.detachError ?? new Error("must be owner of table notifications");
    }
    return [];
  });

  const tag = jest.fn().mockImplementation(async (strings: TemplateStringsArray) => {
    const stmt = strings.raw.join("$?");
    tagStatements.push(stmt);
    if (stmt.includes("has_default") || stmt.includes("pg_get_expr")) {
      return [{ has_default: opts.hasDefault ?? false }];
    }
    if (stmt.includes("to_regclass")) {
      return [{ present: opts.probeResult ?? true }];
    }
    return [];
  });

  Object.assign(tag, { unsafe, end });

  return {
    client: tag as unknown as ReturnType<typeof postgres>,
    unsafe,
    end,
    unsafeStatements,
    tagStatements,
  };
}

describe("PartitionMaintenanceService", () => {
  const validPartition = "notifications_y2024_m01";
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    jest.clearAllMocks();
    savedEnv["DATABASE_URL"] = process.env["DATABASE_URL"];
    savedEnv["APP_DATABASE_URL"] = process.env["APP_DATABASE_URL"];
    process.env["DATABASE_URL"] = "postgresql://neondb_owner@127.0.0.1:5432/scratch_local?sslmode=disable";
    process.env["APP_DATABASE_URL"] = "postgresql://streamline_app@127.0.0.1:5432/scratch_local?sslmode=disable";
  });

  afterEach(() => {
    process.env["DATABASE_URL"] = savedEnv["DATABASE_URL"];
    process.env["APP_DATABASE_URL"] = savedEnv["APP_DATABASE_URL"];
  });

  it("rejects a partition name containing SQL injection", async () => {
    const svc = new PartitionMaintenanceService();
    await expect(
      svc.sweepParent("notifications", ["notifications_y2024_m01; DROP TABLE users"]),
    ).rejects.toThrow("invalid partition name");
  });

  it("rejects a partition name that does not match the parent prefix", async () => {
    const svc = new PartitionMaintenanceService();
    await expect(
      svc.sweepParent("notifications", ["chat_messages_y2024_m01"]),
    ).rejects.toThrow("invalid partition name");
  });

  it("warns and returns 0/0 when DATABASE_URL is absent", async () => {
    delete process.env["DATABASE_URL"];
    const svc = new PartitionMaintenanceService();
    const result = await svc.sweepParent("notifications", [validPartition]);
    expect(result).toEqual({ detached: 0, dropped: 0 });
  });

  it("warns and returns 0/0 when DATABASE_URL user matches APP_DATABASE_URL user", async () => {
    process.env["DATABASE_URL"] = "postgresql://streamline_app@127.0.0.1:5432/scratch_local?sslmode=disable";
    const svc = new PartitionMaintenanceService();
    const result = await svc.sweepParent("notifications", [validPartition]);
    expect(result).toEqual({ detached: 0, dropped: 0 });
  });

  it("returns 0/0 with no client call when partition list is empty", async () => {
    const svc = new PartitionMaintenanceService();
    const result = await svc.sweepParent("notifications", []);
    expect(result).toEqual({ detached: 0, dropped: 0 });
    expect(mockedPostgresFactory).not.toHaveBeenCalled();
  });

  it("uses plain DETACH (no CONCURRENTLY) when the parent has a DEFAULT partition", async () => {
    const { client, unsafeStatements } = makePostgresClient({ hasDefault: true, probeResult: true });
    mockedPostgresFactory.mockReturnValue(client);

    const svc = new PartitionMaintenanceService();
    await svc.sweepParent("notifications", [validPartition]);

    const detaches = unsafeStatements.filter((s) => s.toUpperCase().includes("DETACH PARTITION"));
    expect(detaches.length).toBeGreaterThan(0);
    for (const stmt of detaches) {
      expect(stmt.toUpperCase()).not.toContain("CONCURRENTLY");
    }
  });

  it("uses DETACH PARTITION CONCURRENTLY when the parent has no DEFAULT partition", async () => {
    const { client, unsafeStatements } = makePostgresClient({ hasDefault: false, probeResult: true });
    mockedPostgresFactory.mockReturnValue(client);

    const svc = new PartitionMaintenanceService();
    await svc.sweepParent("notifications", [validPartition]);

    const detaches = unsafeStatements.filter((s) => s.toUpperCase().includes("DETACH PARTITION"));
    expect(detaches.length).toBeGreaterThan(0);
    for (const stmt of detaches) {
      expect(stmt.toUpperCase()).toContain("CONCURRENTLY");
    }
  });

  it("emits no DETACH PARTITION IF EXISTS in either mode", async () => {
    for (const hasDefault of [true, false]) {
      jest.clearAllMocks();
      const { client, unsafeStatements } = makePostgresClient({ hasDefault, probeResult: true });
      mockedPostgresFactory.mockReturnValue(client);

      const svc = new PartitionMaintenanceService();
      await svc.sweepParent("notifications", [validPartition]);

      const detaches = unsafeStatements.filter((s) => s.toUpperCase().includes("DETACH PARTITION"));
      expect(detaches.length).toBeGreaterThan(0);
      for (const stmt of detaches)
        expect(stmt.toUpperCase()).not.toContain("DETACH PARTITION IF EXISTS");
    }
  });

  it("closes the client even when DETACH throws", async () => {
    const { client, end } = makePostgresClient({ probeResult: true, throwOnDetach: true });
    mockedPostgresFactory.mockReturnValue(client);

    const svc = new PartitionMaintenanceService();
    const result = await svc.sweepParent("notifications", [validPartition]);

    expect(end).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ detached: 0, dropped: 0 });
  });

  it("returns 0/0 when the partition is absent (probe returns false)", async () => {
    const { client } = makePostgresClient({ probeResult: false });
    mockedPostgresFactory.mockReturnValue(client);

    const svc = new PartitionMaintenanceService();
    const result = await svc.sweepParent("notifications", [validPartition]);

    expect(result).toEqual({ detached: 0, dropped: 0 });
  });

  it("returns detached=1 dropped=1 on a successful full sweep (no-default mode)", async () => {
    const { client } = makePostgresClient({ hasDefault: false, probeResult: true });
    mockedPostgresFactory.mockReturnValue(client);

    const svc = new PartitionMaintenanceService();
    const result = await svc.sweepParent("notifications", [validPartition]);

    expect(result).toEqual({ detached: 1, dropped: 1 });
  });

  it("returns detached=1 dropped=1 on a successful full sweep (has-default mode)", async () => {
    const { client } = makePostgresClient({ hasDefault: true, probeResult: true });
    mockedPostgresFactory.mockReturnValue(client);

    const svc = new PartitionMaintenanceService();
    const result = await svc.sweepParent("notifications", [validPartition]);

    expect(result).toEqual({ detached: 1, dropped: 1 });
  });

  it("sets lock_timeout before the mode query", async () => {
    const { client, unsafeStatements, tagStatements } = makePostgresClient({ probeResult: true });
    mockedPostgresFactory.mockReturnValue(client);

    const svc = new PartitionMaintenanceService();
    await svc.sweepParent("notifications", [validPartition]);

    expect(unsafeStatements[0]).toMatch(/SET lock_timeout/i);
    expect(tagStatements[0]).toMatch(/has_default/i);
  });

  it("opens the postgres client only once per sweepParent call regardless of partition count", async () => {
    const { client } = makePostgresClient({ probeResult: true });
    mockedPostgresFactory.mockReturnValue(client);

    const svc = new PartitionMaintenanceService();
    await svc.sweepParent("notifications", [
      "notifications_y2024_m01",
      "notifications_y2024_m02",
    ]);

    expect(mockedPostgresFactory).toHaveBeenCalledTimes(1);
  });

  it("plain mode attempts only the first (oldest) partition when multiple are expired", async () => {
    const { client, unsafeStatements } = makePostgresClient({ hasDefault: true, probeResult: true });
    mockedPostgresFactory.mockReturnValue(client);

    const svc = new PartitionMaintenanceService();
    await svc.sweepParent("notifications", [
      "notifications_y2024_m01",
      "notifications_y2024_m02",
      "notifications_y2024_m03",
    ]);

    const detaches = unsafeStatements.filter((s) => s.toUpperCase().includes("DETACH PARTITION"));
    expect(detaches.length).toBe(1);
    expect(detaches[0]).toContain("notifications_y2024_m01");
  });

  it("sets lock_timeout='1s' in plain mode (parent has DEFAULT partition)", async () => {
    const { client, unsafeStatements } = makePostgresClient({ hasDefault: true, probeResult: true });
    mockedPostgresFactory.mockReturnValue(client);

    const svc = new PartitionMaintenanceService();
    await svc.sweepParent("notifications", [validPartition]);

    const setStmt = unsafeStatements.find((s) => /SET lock_timeout/i.test(s));
    expect(setStmt).toContain("'1s'");
    expect(setStmt).not.toContain("'5s'");
  });

  it("sets lock_timeout='5s' in concurrent mode (parent has no DEFAULT partition)", async () => {
    const { client, unsafeStatements } = makePostgresClient({ hasDefault: false, probeResult: true });
    mockedPostgresFactory.mockReturnValue(client);

    const svc = new PartitionMaintenanceService();
    await svc.sweepParent("notifications", [validPartition]);

    const setStmt = unsafeStatements.find((s) => /SET lock_timeout/i.test(s));
    expect(setStmt).toContain("'5s'");
    expect(setStmt).not.toContain("'1s'");
  });

  it("classifies a 55P03 lock-timeout error as debug, not warn", async () => {
    const lockErr = Object.assign(
      new Error("canceling statement due to lock timeout"),
      { code: "55P03" },
    );
    const { client } = makePostgresClient({ hasDefault: false, probeResult: true, detachError: lockErr });
    mockedPostgresFactory.mockReturnValue(client);

    const debugSpy = jest.spyOn(Logger.prototype, "debug");
    const warnSpy = jest.spyOn(Logger.prototype, "warn");

    const svc = new PartitionMaintenanceService();
    const result = await svc.sweepParent("notifications", [validPartition]);

    expect(result).toEqual({ detached: 0, dropped: 0 });
    expect(debugSpy).toHaveBeenCalled();
    const allDebug = debugSpy.mock.calls.flat().join(" ");
    expect(allDebug).toContain("skipped");
    const detachWarnCount = warnSpy.mock.calls
      .flat()
      .filter((a): a is string => typeof a === "string" && a.includes("detach of"))
      .length;
    expect(detachWarnCount).toBe(0);
  });

  it("concurrent mode attempts every partition in the list", async () => {
    const { client, unsafeStatements } = makePostgresClient({ hasDefault: false, probeResult: true });
    mockedPostgresFactory.mockReturnValue(client);

    const svc = new PartitionMaintenanceService();
    await svc.sweepParent("notifications", [
      "notifications_y2024_m01",
      "notifications_y2024_m02",
      "notifications_y2024_m03",
    ]);

    const detaches = unsafeStatements.filter(
      (s) => s.toUpperCase().includes("DETACH PARTITION") && s.toUpperCase().includes("CONCURRENTLY"),
    );
    expect(detaches.length).toBe(3);
  });
});
