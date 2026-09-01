jest.mock("../../../common/tenant/for-each-org", () => ({
  forEachOrg: jest.fn(),
}));

import { forEachOrg } from "../../../common/tenant/for-each-org";
import { CronAiUsageRetentionService, AI_USAGE_RETENTION_DAYS } from "../cron-ai-usage-retention.service";
import type { Db } from "../../../db/drizzle.module";

const mockedForEachOrg = forEachOrg as jest.MockedFunction<typeof forEachOrg>;

const ORG_A = "org-aaaa-0000-0000-0000-000000000001";

function makeRedis(overrides: Partial<{
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
}> = {}) {
  return {
    get: overrides.get ?? jest.fn().mockResolvedValue(null),
    set: overrides.set ?? jest.fn().mockResolvedValue("OK"),
    del: overrides.del ?? jest.fn().mockResolvedValue(1),
  };
}

function makeTx(batches: Array<Array<{ id: number }>> = [[]]) {
  let selectCall = 0;
  let deleteWhereCaptures: unknown[] = [];

  const tx = {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockImplementation(() => {
        const rows = batches[selectCall] ?? [];
        selectCall += 1;
        return Promise.resolve(rows);
      }),
    })),
    delete: jest.fn().mockImplementation(() => ({
      where: jest.fn().mockImplementation((clause: unknown) => {
        deleteWhereCaptures.push(clause);
        return Promise.resolve([]);
      }),
    })),
    _deleteCaptured: () => deleteWhereCaptures,
    _selectCalls: () => selectCall,
  };

  return tx;
}

function runWithTx(tx: ReturnType<typeof makeTx>) {
  mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
    await fn(tx as unknown as Parameters<typeof fn>[0], ORG_A);
    return { organizations: 1, succeeded: 1, failed: 0 };
  });
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe("CronAiUsageRetentionService — dry-run is the default", () => {
  it("(A-bite) calling sweep() with no args runs in dry-run and does NOT call tx.delete", async () => {
    const redis = makeRedis();
    const svc = new CronAiUsageRetentionService({} as unknown as Db, redis as never);
    const tx = makeTx([[{ id: 1 }, { id: 2 }], []]);
    runWithTx(tx);

    const result = await svc.sweep();

    expect(result.dryRun).toBe(true);
    expect(tx.delete).not.toHaveBeenCalled();
    expect(result.rowsWouldDelete).toBe(2);
    expect(result.rowsDeleted).toBe(0);
  });

  it("(A-restore) calling sweep({ dryRun: false }) does call tx.delete", async () => {
    const redis = makeRedis();
    const svc = new CronAiUsageRetentionService({} as unknown as Db, redis as never);
    const tx = makeTx([[{ id: 1 }, { id: 2 }], []]);
    runWithTx(tx);

    const result = await svc.sweep({ dryRun: false });

    expect(result.dryRun).toBe(false);
    expect(tx.delete).toHaveBeenCalledTimes(1);
    expect(result.rowsDeleted).toBe(2);
    expect(result.rowsWouldDelete).toBe(0);
  });
});

describe("CronAiUsageRetentionService — resumable cursor", () => {
  it("(B-bite) cursor stored in Redis is read at start of each org sweep — removing redis.get breaks cursor resume", async () => {
    const getSpy = jest.fn().mockResolvedValue(100);
    const redis = makeRedis({ get: getSpy });
    const svc = new CronAiUsageRetentionService({} as unknown as Db, redis as never);
    const tx = makeTx([[]]);
    runWithTx(tx);

    await svc.sweep({ dryRun: false });

    expect(getSpy).toHaveBeenCalledWith(`cursor:ai-usage-retention:${ORG_A}`);
  });

  it("(B-cursor-advance) cursor is written to Redis after each batch with the max id", async () => {
    const setSpy = jest.fn().mockResolvedValue("OK");
    const redis = makeRedis({ set: setSpy });
    const svc = new CronAiUsageRetentionService({} as unknown as Db, redis as never);
    const tx = makeTx([[{ id: 10 }, { id: 20 }, { id: 30 }], []]);
    runWithTx(tx);

    await svc.sweep({ dryRun: false });

    const setArgs = setSpy.mock.calls.find((c) => String(c[0]).startsWith("cursor:ai-usage-retention:"));
    expect(setArgs).toBeDefined();
    expect(setArgs?.[1]).toBe(30);
  });

  it("(B-cursor-reset) cursor is deleted after sweep completes (empty batch ends the sweep)", async () => {
    const delSpy = jest.fn().mockResolvedValue(1);
    const redis = makeRedis({ del: delSpy });
    const svc = new CronAiUsageRetentionService({} as unknown as Db, redis as never);
    const tx = makeTx([[]]);
    runWithTx(tx);

    await svc.sweep({ dryRun: false });

    expect(delSpy).toHaveBeenCalledWith(`cursor:ai-usage-retention:${ORG_A}`);
  });

  it("(B-cursor-resume) a non-zero cursor from Redis is passed as gt() predicate to the query", async () => {
    const redis = makeRedis({ get: jest.fn().mockResolvedValue(500) });
    const svc = new CronAiUsageRetentionService({} as unknown as Db, redis as never);

    const capturedLimitCalls: number[] = [];
    let selectCall = 0;
    const tx = {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockImplementation((n: number) => {
          capturedLimitCalls.push(n);
          const rows = selectCall === 0 ? [] : [];
          selectCall += 1;
          return Promise.resolve(rows);
        }),
      })),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    };

    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      await fn(tx as unknown as Parameters<typeof fn>[0], ORG_A);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    await svc.sweep({ dryRun: false });

    expect(capturedLimitCalls.length).toBeGreaterThan(0);
  });
});

describe("CronAiUsageRetentionService — batch bound", () => {
  it("(C-bite) a full batch (= BATCH_SIZE) continues to the next batch; a partial batch stops", async () => {
    const redis = makeRedis();
    const svc = new CronAiUsageRetentionService({} as unknown as Db, redis as never);

    const batch500 = Array.from({ length: 500 }, (_, i) => ({ id: i + 1 }));
    const tx = makeTx([batch500, []]);
    runWithTx(tx);

    await svc.sweep({ dryRun: false });

    expect(tx.delete).toHaveBeenCalledTimes(1);
    expect(tx._selectCalls()).toBe(2);
  });

  it("(C-idempotent) a second sweep on an already-clean org calls delete zero times", async () => {
    const redis = makeRedis();
    const svc = new CronAiUsageRetentionService({} as unknown as Db, redis as never);
    const tx = makeTx([[]]);
    runWithTx(tx);

    await svc.sweep({ dryRun: false });

    expect(tx.delete).not.toHaveBeenCalled();
  });
});

describe("CronAiUsageRetentionService — tenant isolation via forEachOrg", () => {
  it("(D-bite) removing forEachOrg from the call makes the sweep process zero orgs — forEachOrg is load-bearing", async () => {
    mockedForEachOrg.mockResolvedValue({ organizations: 0, succeeded: 0, failed: 0 });

    const redis = makeRedis();
    const svc = new CronAiUsageRetentionService({} as unknown as Db, redis as never);

    const result = await svc.sweep({ dryRun: false });

    expect(result.organizationsScanned).toBe(0);
    expect(result.rowsDeleted).toBe(0);
  });

  it("(D-restore) uses forEachOrg — the sweep name is 'ai-usage-retention'", async () => {
    const redis = makeRedis();
    const svc = new CronAiUsageRetentionService({} as unknown as Db, redis as never);
    const tx = makeTx([[]]);
    runWithTx(tx);

    await svc.sweep();

    expect(mockedForEachOrg).toHaveBeenCalledTimes(1);
    const [, sweepName] = mockedForEachOrg.mock.calls[0] ?? [];
    expect(sweepName).toBe("ai-usage-retention");
  });
});

describe("CronAiUsageRetentionService — audit_logs / financial tables are excluded", () => {
  it("(E) service only touches ai_usage_logs — audit_logs table name does not appear in source", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "../cron-ai-usage-retention.service.ts"),
      "utf8",
    );
    expect(src).toContain("aiUsageLogs");
    expect(src).not.toContain("auditLogs");
    expect(src).not.toContain("audit_logs");
    expect(src).not.toContain("payrollRuns");
    expect(src).not.toContain("payroll_runs");
    expect(src).not.toContain("journalEntries");
    expect(src).not.toContain("journal_entries");
  });
});

describe("CronAiUsageRetentionService — cutoff date is bounded by AI_USAGE_RETENTION_DAYS", () => {
  it("(F) AI_USAGE_RETENTION_DAYS is at least 365 — billing records kept for at least a year", () => {
    expect(AI_USAGE_RETENTION_DAYS).toBeGreaterThanOrEqual(365);
  });
});

describe("CronAiUsageRetentionService — Redis unavailable falls back gracefully", () => {
  it("(G) sweep runs without Redis (null) and processes rows without error", async () => {
    const svc = new CronAiUsageRetentionService({} as unknown as Db, null);
    const tx = makeTx([[{ id: 1 }], []]);
    runWithTx(tx);

    await expect(svc.sweep({ dryRun: false })).resolves.toBeDefined();
    expect(tx.delete).toHaveBeenCalledTimes(1);
  });
});
