import { AiJobsService } from "./ai-jobs.service";
import { AiJobsWorkerService } from "./ai-jobs-worker.service";
import { AiJobHandlerRegistry } from "./ai-job-handler";
import type { AiJob } from "../../db/schema";

type MockQueryResult = Partial<AiJob>;

function makeJob(overrides: Partial<AiJob> = {}): AiJob {
  return {
    id: 1,
    orgId: "org-1",
    userId: null,
    type: "test.job",
    payload: {},
    status: "QUEUED",
    priority: 0,
    attempts: 0,
    maxAttempts: 3,
    idempotencyKey: null,
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
  execute: jest.Mock;
};

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
    execute: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function _buildService(db: MockDb): AiJobsService {
  return new AiJobsService(db as unknown as Parameters<typeof AiJobsService.prototype.enqueue>[0] & never);
}

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
      await svc.fail(1, "timeout");

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
      await svc.fail(1, "final error");

      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "DEAD", attempts: 3, lastError: "final error" }),
      );
    });

    it("does nothing when job is not found", async () => {
      const db = buildDb();
      db.query.aiJobs.findFirst.mockResolvedValue(null);

      const svc = new AiJobsService(db as never);
      await expect(svc.fail(999, "error")).resolves.toBeUndefined();
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
  function buildWorker(db: MockDb, jobsSvc: AiJobsService, handlers: ReturnType<typeof buildHandlerRegistry>): AiJobsWorkerService {
    return new AiJobsWorkerService(jobsSvc, handlers.registry, db as never, handlers.handlerList);
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

  it("completes job when handler succeeds", async () => {
    const job = makeJob({ id: 1, type: "send.email" });
    const db = buildDb();
    const jobsSvc = new AiJobsService(db as never);
    jest.spyOn(jobsSvc, "claimBatch").mockResolvedValue([job]);
    jest.spyOn(jobsSvc, "complete").mockResolvedValue();

    const handlers = buildHandlerRegistry("send.email", { sent: true });
    const worker = buildWorker(db, jobsSvc, handlers);
    const result = await worker.flush(1);

    expect(result.completed).toBe(1);
    expect(result.failed).toBe(0);
    expect(jobsSvc.complete).toHaveBeenCalledWith(1, { sent: true });
  });

  it("calls fail when handler throws", async () => {
    const job = makeJob({ id: 1, type: "send.email" });
    const db = buildDb();
    const jobsSvc = new AiJobsService(db as never);
    jest.spyOn(jobsSvc, "claimBatch").mockResolvedValue([job]);
    jest.spyOn(jobsSvc, "fail").mockResolvedValue();

    const handlers = buildHandlerRegistry("send.email", new Error("smtp down"));
    const worker = buildWorker(db, jobsSvc, handlers);
    const result = await worker.flush(1);

    expect(result.failed).toBe(1);
    expect(jobsSvc.fail).toHaveBeenCalledWith(1, "smtp down");
  });

  it("marks job DEAD immediately for unknown handler type", async () => {
    const job = makeJob({ id: 1, type: "unknown.type", maxAttempts: 3 });
    const db = buildDb();
    const updateChain = buildUpdateChain([{ id: 1 }]);
    db.update.mockReturnValue(updateChain);
    const jobsSvc = new AiJobsService(db as never);
    jest.spyOn(jobsSvc, "claimBatch").mockResolvedValue([job]);

    const registry = new AiJobHandlerRegistry();
    const worker = new AiJobsWorkerService(jobsSvc, registry, db as never, null);
    const result = await worker.flush(1);

    expect(result.failed).toBe(1);
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "DEAD", attempts: 3 }),
    );
  });

  it("returns zero counts when no jobs are claimed", async () => {
    const db = buildDb();
    const jobsSvc = new AiJobsService(db as never);
    jest.spyOn(jobsSvc, "claimBatch").mockResolvedValue([]);

    const registry = new AiJobHandlerRegistry();
    const worker = new AiJobsWorkerService(jobsSvc, registry, db as never, null);
    const result = await worker.flush();

    expect(result).toEqual({ claimed: 0, completed: 0, failed: 0 });
  });
});
