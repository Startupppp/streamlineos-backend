import { AiJobsService } from "./ai-jobs.service";
import { AiJobsWorkerService } from "./ai-jobs-worker.service";
import { AiJobHandlerRegistry } from "./ai-job-handler";
import { PgDialect } from "drizzle-orm/pg-core";
import type { AiJob } from "../../../db/schema";
import type { SQL } from "drizzle-orm";

const dialect = new PgDialect();

function renderSql(cond: SQL): string {
  return dialect.sqlToQuery(cond).sql;
}

type MockQueryResult = Partial<AiJob>;

function makeJob(overrides: Partial<AiJob> = {}): AiJob {
  return {
    id: 1,
    orgId: "org-1",
    userId: null,
    userMembershipId: null,
    type: "test.job",
    payload: {},
    status: "QUEUED",
    priority: 0,
    attempts: 0,
    maxAttempts: 3,
    idempotencyKey: null,
    correlationId: null,
    runAt: new Date(),
    lockedBy: null,
    lockedAt: null,
    lastError: null,
    result: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildUpdateChain(returning?: MockQueryResult[]) {
  const ret = jest.fn().mockResolvedValue(returning ?? [{ id: 1 }]);
  const where = jest.fn().mockReturnValue({ returning: ret });
  const set = jest.fn().mockReturnValue({ where });
  return { set, where, returning: ret };
}

function buildInsertChain(rows: MockQueryResult[] = [{ id: 1 }]) {
  const ret = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ returning: ret });
  const values = jest.fn().mockReturnValue({ returning: ret, where });
  return { values };
}

type MockDb = {
  query: { aiJobs: { findFirst: jest.Mock; findMany: jest.Mock } };
  insert: jest.Mock;
  update: jest.Mock;
  select: jest.Mock;
  execute: jest.Mock;
};

function buildSelectChain(rows: Record<string, unknown>[] = [{ live: 0 }]) {
  const where = jest.fn().mockResolvedValue(rows);
  const from = jest.fn().mockReturnValue({ where });
  return jest.fn().mockReturnValue({ from });
}

function buildDb(overrides: Partial<MockDb> = {}): MockDb {
  return {
    query: {
      aiJobs: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
    },
    insert: jest.fn(),
    update: jest.fn(),
    select: buildSelectChain(),
    execute: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("AiJobsService — tenant predicate on write operations", () => {
  function buildCapturingDb(findFirstResult: AiJob | null = null) {
    const capturedConditions: SQL[] = [];
    const updateChain = {
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((cond: SQL) => {
          capturedConditions.push(cond);
          return Promise.resolve();
        }),
      }),
    };
    const db = {
      query: {
        aiJobs: {
          findFirst: jest.fn().mockResolvedValue(findFirstResult),
        },
      },
      update: jest.fn().mockReturnValue(updateChain),
    };
    return { db, capturedConditions };
  }

  it("complete where clause contains org_id", async () => {
    const { db, capturedConditions } = buildCapturingDb();
    const svc = new AiJobsService(db as never);
    await svc.complete("org-x", 1, {});
    expect(capturedConditions).toHaveLength(1);
    const rendered = renderSql(capturedConditions[0] as SQL);
    expect(rendered).toContain("org_id");
  });

  it("fail DEAD update where clause contains org_id", async () => {
    const job = makeJob({ id: 1, attempts: 2, maxAttempts: 3 });
    const { db, capturedConditions } = buildCapturingDb(job);
    const svc = new AiJobsService(db as never);
    await svc.fail("org-x", 1, "boom");
    expect(capturedConditions).toHaveLength(1);
    const rendered = renderSql(capturedConditions[0] as SQL);
    expect(rendered).toContain("org_id");
  });

  it("fail requeue update where clause contains org_id", async () => {
    const job = makeJob({ id: 1, attempts: 0, maxAttempts: 3 });
    const { db, capturedConditions } = buildCapturingDb(job);
    const svc = new AiJobsService(db as never);
    await svc.fail("org-x", 1, "timeout");
    expect(capturedConditions).toHaveLength(1);
    const rendered = renderSql(capturedConditions[0] as SQL);
    expect(rendered).toContain("org_id");
  });
});

describe("AiJobsService", () => {
  describe("enqueue", () => {
    it("inserts a new job and returns its id", async () => {
      const db = buildDb();
      const insertChain = buildInsertChain([{ id: 42 }]);
      db.insert.mockReturnValue(insertChain);

      const svc = new AiJobsService(db as never);
      const result = await svc.enqueue({ orgId: "org-1", type: "send.email", payload: { to: "a@b.com" } });

      expect(result.jobId).toBe(42);
      expect(db.insert).toHaveBeenCalled();
    });

    it("returns existing job id when idempotency key conflicts", async () => {
      const existing = makeJob({ id: 99, idempotencyKey: "key-abc" });
      const db = buildDb();
      db.query.aiJobs.findFirst.mockResolvedValue(existing);

      const svc = new AiJobsService(db as never);
      const result = await svc.enqueue({
        orgId: "org-1",
        type: "send.email",
        payload: {},
        idempotencyKey: "key-abc",
      });

      expect(result.jobId).toBe(99);
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe("fail", () => {
    it("requeues with exponential backoff when attempts < maxAttempts", async () => {
      const job = makeJob({ id: 1, attempts: 0, maxAttempts: 3 });
      const db = buildDb();
      db.query.aiJobs.findFirst.mockResolvedValue(job);
      const updateChain = buildUpdateChain([]);
      db.update.mockReturnValue(updateChain);

      const svc = new AiJobsService(db as never);
      await svc.fail("org-1", 1, "timeout");

      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "QUEUED", attempts: 1 }),
      );
    });

    it("marks job DEAD when attempts reach maxAttempts", async () => {
      const job = makeJob({ id: 1, attempts: 2, maxAttempts: 3 });
      const db = buildDb();
      db.query.aiJobs.findFirst.mockResolvedValue(job);
      const updateChain = buildUpdateChain([]);
      db.update.mockReturnValue(updateChain);

      const svc = new AiJobsService(db as never);
      await svc.fail("org-1", 1, "final error");

      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "DEAD", attempts: 3, lastError: "final error" }),
      );
    });

    it("does nothing when job is not found", async () => {
      const db = buildDb();
      db.query.aiJobs.findFirst.mockResolvedValue(null);

      const svc = new AiJobsService(db as never);
      await expect(svc.fail("org-1", 999, "error")).resolves.toBeUndefined();
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe("cancel", () => {
    it("cancels a QUEUED job scoped to the org", async () => {
      const db = buildDb();
      const updateChain = buildUpdateChain([{ id: 1 }]);
      db.update.mockReturnValue(updateChain);

      const svc = new AiJobsService(db as never);
      await svc.cancel("org-1", 1);

      expect(updateChain.set).toHaveBeenCalledWith({ status: "CANCELLED" });
      const whereCall = updateChain.where.mock.calls[0];
      expect(whereCall).toBeDefined();
    });

    it("does not cancel a job from a different org (no rows returned)", async () => {
      const db = buildDb();
      const updateChain = buildUpdateChain([]);
      db.update.mockReturnValue(updateChain);

      const svc = new AiJobsService(db as never);
      await svc.cancel("org-2", 1);

      expect(updateChain.set).toHaveBeenCalledWith({ status: "CANCELLED" });
    });
  });

  describe("releaseStaleLocks", () => {
    it("returns the count of released locks", async () => {
      const db = buildDb();
      const updateChain = buildUpdateChain([{ id: 1 }, { id: 2 }]);
      db.update.mockReturnValue(updateChain);

      const svc = new AiJobsService(db as never);
      const count = await svc.releaseStaleLocks(10);

      expect(count).toBe(2);
    });

    it("returns 0 when no stale locks exist", async () => {
      const db = buildDb();
      const updateChain = buildUpdateChain([]);
      db.update.mockReturnValue(updateChain);

      const svc = new AiJobsService(db as never);
      const count = await svc.releaseStaleLocks(10);

      expect(count).toBe(0);
    });
  });
});

describe("AiJobsWorkerService", () => {
  function makeClaimRow(job: AiJob): Record<string, unknown> {
    return {
      id: job.id,
      org_id: job.orgId,
      user_id: job.userId,
      user_membership_id: job.userMembershipId,
      type: job.type,
      payload: job.payload,
      status: job.status,
      priority: job.priority,
      attempts: job.attempts,
      max_attempts: job.maxAttempts,
      idempotency_key: job.idempotencyKey,
      correlation_id: job.correlationId,
      run_at: job.runAt.toISOString(),
      locked_by: job.lockedBy,
      locked_at: job.lockedAt?.toISOString() ?? null,
      last_error: job.lastError,
      result: job.result,
      created_at: job.createdAt.toISOString(),
      updated_at: job.updatedAt.toISOString(),
    };
  }

  function buildExecuteDb(job: AiJob | null, updateChain?: ReturnType<typeof buildUpdateChain>): MockDb {
    let execCallCount = 0;
    const claimRow = job ? makeClaimRow(job) : null;
    const db = buildDb({
      execute: jest.fn(() => {
        const idx = execCallCount++;
        if (idx === 0) return Promise.resolve(claimRow ? [{ org_id: (claimRow["org_id"] as string) }] : []);
        return Promise.resolve(claimRow ? [claimRow] : []);
      }),
    });
    if (updateChain) db.update.mockReturnValue(updateChain);
    return db;
  }

  function buildHandlerRegistry(type: string, result: Record<string, unknown> | Error) {
    const registry = new AiJobHandlerRegistry();
    const handlerList = [
      {
        type,
        handle: jest.fn().mockImplementation(() =>
          result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
        ),
      },
    ];
    for (const h of handlerList) registry.register(h);
    return { registry, handlerList };
  }

  function buildWorker(db: MockDb, jobsSvc: AiJobsService, handlers: ReturnType<typeof buildHandlerRegistry>): AiJobsWorkerService {
    return new AiJobsWorkerService(jobsSvc, handlers.registry, db as never, handlers.handlerList);
  }

  it("completes job when handler succeeds — passes orgId to complete()", async () => {
    const job = makeJob({ id: 1, orgId: "org-abc", type: "send.email" });
    const db = buildExecuteDb(job);
    const jobsSvc = new AiJobsService(db as never);
    jest.spyOn(jobsSvc, "reclaimExpiredLeases").mockResolvedValue(0);
    jest.spyOn(jobsSvc, "complete").mockResolvedValue();

    const handlers = buildHandlerRegistry("send.email", { sent: true });
    const worker = buildWorker(db, jobsSvc, handlers);
    const result = await worker.flush(1);

    expect(result.completed).toBe(1);
    expect(result.failed).toBe(0);
    expect(jobsSvc.complete).toHaveBeenCalledWith("org-abc", 1, { sent: true });
  });

  it("calls fail with orgId when handler throws", async () => {
    const job = makeJob({ id: 1, orgId: "org-abc", type: "send.email" });
    const db = buildExecuteDb(job);
    const jobsSvc = new AiJobsService(db as never);
    jest.spyOn(jobsSvc, "reclaimExpiredLeases").mockResolvedValue(0);
    jest.spyOn(jobsSvc, "fail").mockResolvedValue();

    const handlers = buildHandlerRegistry("send.email", new Error("smtp down"));
    const worker = buildWorker(db, jobsSvc, handlers);
    const result = await worker.flush(1);

    expect(result.failed).toBe(1);
    expect(jobsSvc.fail).toHaveBeenCalledWith("org-abc", 1, "smtp down");
  });

  it("marks job DEAD immediately for unknown handler type", async () => {
    const job = makeJob({ id: 1, orgId: "org-1", type: "unknown.type", maxAttempts: 3 });
    const updateChain = buildUpdateChain([{ id: 1 }]);
    const db = buildExecuteDb(job, updateChain);
    const jobsSvc = new AiJobsService(db as never);
    jest.spyOn(jobsSvc, "reclaimExpiredLeases").mockResolvedValue(0);

    const registry = new AiJobHandlerRegistry();
    const worker = new AiJobsWorkerService(jobsSvc, registry, db as never, null);
    const result = await worker.flush(1);

    expect(result.failed).toBe(1);
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "DEAD", attempts: 3 }),
    );
  });

  it("returns zero counts when no jobs are claimed", async () => {
    const db = buildExecuteDb(null);
    const jobsSvc = new AiJobsService(db as never);
    jest.spyOn(jobsSvc, "reclaimExpiredLeases").mockResolvedValue(0);

    const registry = new AiJobHandlerRegistry();
    const worker = new AiJobsWorkerService(jobsSvc, registry, db as never, null);
    const result = await worker.flush();

    expect(result).toEqual({ claimed: 0, completed: 0, failed: 0 });
  });
});
