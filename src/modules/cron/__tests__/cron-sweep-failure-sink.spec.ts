import { CronSweepFailureSinkService } from "../cron-sweep-failure-sink.service";
import { LAST_ERROR_KEY_PREFIX } from "../cron-lease.service";
import { RETENTION_JOBS } from "../retention-schedule";
import {
  forEachOrg,
  registerSweepFailureSink,
  type SweepPartialFailure,
} from "../../../common/tenant";
import type { Db } from "../../../db/drizzle.module";

const ORG_COUNT = 250;

interface SelectChain {
  from: jest.Mock<SelectChain, []>;
  where: jest.Mock<SelectChain, [unknown]>;
  orderBy: jest.Mock<SelectChain, []>;
  limit: jest.Mock<Promise<{ id: string }[]>, [number]>;
}

function makeMockDb(orgIds: string[]): Db {
  const rows = orgIds.map((id) => ({ id }));
  const chain: SelectChain = {
    from: jest.fn((): SelectChain => chain),
    where: jest.fn((_condition: unknown): SelectChain => chain),
    orderBy: jest.fn((): SelectChain => chain),
    limit: jest.fn((pageSize: number) => Promise.resolve(rows.slice(0, pageSize))),
  };
  const db = {
    select: jest.fn(() => chain),
    transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn({ execute: jest.fn() })),
  };
  return db as unknown as Db;
}

function makeRedis() {
  return { set: jest.fn().mockResolvedValue("OK") };
}

function event(overrides: Partial<SweepPartialFailure> = {}): SweepPartialFailure {
  return {
    sweep: "mail-metadata-retention",
    organizations: ORG_COUNT,
    succeeded: ORG_COUNT - 3,
    failed: 3,
    failedOrgIds: ["org-0007", "org-0113", "org-0250"],
    at: new Date().toISOString(),
    ...overrides,
  };
}

afterEach(() => {
  registerSweepFailureSink(null);
  jest.clearAllMocks();
});

describe("CronSweepFailureSinkService — a swallowed tenant failure becomes alertable", () => {
  it("writes the record under the retention job key, so it joins its own heartbeat", async () => {
    const redis = makeRedis();
    const service = new CronSweepFailureSinkService(redis as never);

    await service.record(event());

    expect(redis.set).toHaveBeenCalledTimes(1);
    const [key, raw] = redis.set.mock.calls[0] as [string, string];
    expect(key).toBe(`${LAST_ERROR_KEY_PREFIX}mail-metadata-retention-sweep`);
    const payload: unknown = JSON.parse(raw);
    expect(payload).toMatchObject({
      sweep: "mail-metadata-retention",
      organizations: ORG_COUNT,
      failed: 3,
      partial: true,
      failedOrgIds: ["org-0007", "org-0113", "org-0250"],
    });
  });

  it("keeps the {error, ts} shape the lease's own failure record already uses", async () => {
    const redis = makeRedis();
    const service = new CronSweepFailureSinkService(redis as never);

    await service.record(event());

    const [, raw] = redis.set.mock.calls[0] as [string, string];
    const payload = JSON.parse(raw) as { error?: unknown; ts?: unknown };
    expect(typeof payload.error).toBe("string");
    expect(typeof payload.ts).toBe("string");
    expect(String(payload.error)).toContain("3 of 250 organisation(s) failed");
  });

  it("maps every retention job's forEachOrg sweep name back to its job key", () => {
    for (const job of RETENTION_JOBS) {
      if (job.sweepName === null) continue;
      expect(CronSweepFailureSinkService.recordKey(job.sweepName)).toBe(job.jobKey);
    }
  });

  it("falls back to the sweep name for a sweep that is not a declared retention job", () => {
    expect(CronSweepFailureSinkService.recordKey("billing-dunning")).toBe("billing-dunning");
  });

  it("caps the recorded tenant list rather than writing an unbounded value", async () => {
    const redis = makeRedis();
    const service = new CronSweepFailureSinkService(redis as never);
    const many = Array.from({ length: ORG_COUNT }, (_, i) => `org-${String(i)}`);

    await service.record(event({ failed: many.length, failedOrgIds: many }));

    const [, raw] = redis.set.mock.calls[0] as [string, string];
    const payload = JSON.parse(raw) as { failed: number; failedOrgIds: string[] };
    expect(payload.failed).toBe(ORG_COUNT);
    expect(payload.failedOrgIds).toHaveLength(50);
  });

  it("does not throw when Redis is absent or rejects", async () => {
    await expect(
      new CronSweepFailureSinkService(null).record(event()),
    ).resolves.toBeUndefined();

    const redis = { set: jest.fn().mockRejectedValue(new Error("ECONNRESET")) };
    await expect(
      new CronSweepFailureSinkService(redis as never).record(event()),
    ).resolves.toBeUndefined();
  });
});

describe("CronSweepFailureSinkService — wired end to end from forEachOrg", () => {
  it("a 250-org sweep with three failing tenants writes exactly one durable record", async () => {
    const redis = makeRedis();
    const service = new CronSweepFailureSinkService(redis as never);
    service.onModuleInit();

    const ids = Array.from(
      { length: ORG_COUNT },
      (_, i) => `org-${String(i + 1).padStart(4, "0")}`,
    );
    const failing = new Set(["org-0007", "org-0113", "org-0250"]);

    const result = await forEachOrg(makeMockDb(ids), "helpdesk-retention", async (_tx, orgId) => {
      if (failing.has(orgId)) throw new Error("boom");
    });

    expect(result.failed).toBe(3);
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.set.mock.calls[0][0]).toBe(
      `${LAST_ERROR_KEY_PREFIX}helpdesk-retention-sweep`,
    );
    service.onModuleDestroy();
  });

  it("(bite proof) with the sink unregistered the same sweep writes nothing at all", async () => {
    const redis = makeRedis();
    const service = new CronSweepFailureSinkService(redis as never);
    service.onModuleInit();
    service.onModuleDestroy();

    const ids = Array.from({ length: ORG_COUNT }, (_, i) => `org-${String(i)}`);
    const result = await forEachOrg(makeMockDb(ids), "helpdesk-retention", async (_tx, orgId) => {
      if (orgId === "org-5") throw new Error("boom");
    });

    expect(result.failed).toBe(1);
    expect(redis.set).not.toHaveBeenCalled();
  });
});
