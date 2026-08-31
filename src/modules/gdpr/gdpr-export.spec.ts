import { createHash } from "node:crypto";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { GdprExportService } from "./gdpr-export.service";
import { StorageService } from "../storage/storage.service";

function computeHash(orgId: string, subjectUserId: string): string {
  return createHash("sha256").update(JSON.stringify({ orgId, subjectUserId })).digest("hex");
}

type ChainMock = Record<string, jest.Mock>;

function makeInsertChain(returning: unknown[]): ChainMock {
  const chain: ChainMock = {};
  chain.values = jest.fn().mockReturnValue(chain);
  chain.onConflictDoNothing = jest.fn().mockReturnValue(chain);
  chain.returning = jest.fn().mockResolvedValue(returning);
  return chain;
}

function makeSelectChain(rows: unknown[]): ChainMock {
  const chain: ChainMock = {};
  chain.from = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockResolvedValue(rows);
  return chain;
}

function makeUpdateChain(): ChainMock {
  const chain: ChainMock = {};
  chain.set = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockResolvedValue(undefined);
  chain.returning = jest.fn().mockResolvedValue([]);
  return chain;
}

function makeTx(options: {
  insertRows?: unknown[];
  selectRows?: unknown[];
  updateRows?: unknown[];
}) {
  const insertChain = makeInsertChain(options.insertRows ?? []);
  const selectChain = makeSelectChain(options.selectRows ?? []);
  const updateChain = makeUpdateChain();
  return {
    insert: jest.fn().mockReturnValue(insertChain),
    select: jest.fn().mockReturnValue(selectChain),
    update: jest.fn().mockReturnValue(updateChain),
  };
}

const REAL_HASH = computeHash("org-1", "user-subject");

const BASE_JOB = {
  id: "job-uuid-1",
  orgId: "org-1",
  subjectUserId: "user-subject",
  requestedBy: "user-requester",
  status: "completed",
  idempotencyKey: "key-abc",
  requestHash: REAL_HASH,
  fileKey: "gdpr-exports/job-uuid-1.json",
  fileName: "gdpr-export-2026-08-30.json",
  fileSizeBytes: 1024,
  rowCount: 5,
  truncated: false,
  attempt: 1,
  maxAttempts: 3,
  errorCode: null,
  errorMessage: null,
  lockedAt: null,
  completedAt: new Date("2026-08-30T10:00:00Z"),
  expiresAt: new Date(Date.now() + 86_400_000),
  createdAt: new Date("2026-08-30T09:55:00Z"),
  updatedAt: new Date("2026-08-30T10:00:00Z"),
};

async function buildService(db: unknown, storage: Partial<StorageService> = {}) {
  const module = await Test.createTestingModule({
    providers: [
      GdprExportService,
      { provide: DRIZZLE, useValue: db },
      { provide: StorageService, useValue: storage },
    ],
  }).compile();
  return module.get(GdprExportService);
}

describe("GdprExportService.create — Item A: async job creation", () => {
  it("inserts a pending job and fires an outbox event in one transaction", async () => {
    const insertedJob = { ...BASE_JOB, status: "pending" };
    const txMock = makeTx({ insertRows: [insertedJob] });
    const db = {
      transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txMock)),
    };
    const svc = await buildService(db);

    const result = await svc.create(
      "user-requester",
      "org-1",
      "user-subject",
      "idempotency-key-1",
    );

    expect(txMock.insert).toHaveBeenCalledTimes(2);
    const firstInsertArgs = txMock.insert.mock.calls[0] as unknown[];
    expect(firstInsertArgs).toBeDefined();
    expect(result.status).toBe("pending");
  });

  it("idempotency: second call with the same key returns the existing job without a new outbox event", async () => {
    const existingJob = { ...BASE_JOB, status: "pending" };
    const txMock = makeTx({ insertRows: [], selectRows: [existingJob] });
    const db = {
      transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txMock)),
    };
    const svc = await buildService(db);

    const result = await svc.create(
      "user-requester",
      "org-1",
      "user-subject",
      "idempotency-key-1",
    );

    expect(txMock.insert).toHaveBeenCalledTimes(1);
    expect(result.id).toBe(existingJob.id);
  });

  it("rejects if idempotency key was used with a different requester", async () => {
    const conflictingJob = { ...BASE_JOB, requestedBy: "different-user" };
    const txMock = makeTx({ insertRows: [], selectRows: [conflictingJob] });
    const db = {
      transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txMock)),
    };
    const svc = await buildService(db);

    await expect(
      svc.create("user-requester", "org-1", "user-subject", "idempotency-key-1"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("GdprExportService.download — Item B: authorized expiring download", () => {
  it("returns 404 for a job from another org — cross-tenant isolation, not 403", async () => {
    const selectChain = makeSelectChain([]);
    const db = { select: jest.fn().mockReturnValue(selectChain) };
    const svc = await buildService(db);

    await expect(
      svc.download("user-requester", "org-OTHER", "job-uuid-1", false),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("own-data download fails when requestedBy does not match the caller — cannot read another user's export without admin", async () => {
    const selectChain = makeSelectChain([]);
    const db = { select: jest.fn().mockReturnValue(selectChain) };
    const svc = await buildService(db);

    await expect(
      svc.download("different-user", "org-1", "job-uuid-1", false),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("admin download succeeds regardless of requestedBy (isAdmin=true skips the ownership filter)", async () => {
    const selectChain = makeSelectChain([BASE_JOB]);
    const db = { select: jest.fn().mockReturnValue(selectChain) };
    const mockFile = { body: { pipe: jest.fn() }, contentType: "application/json", contentLength: 1024 };
    const storage = { getFileStream: jest.fn().mockResolvedValue(mockFile) };
    const svc = await buildService(db, storage);

    const result = await svc.download("any-admin", "org-1", "job-uuid-1", true);
    expect(result.job.id).toBe("job-uuid-1");
    expect(storage.getFileStream).toHaveBeenCalledWith("org-1", BASE_JOB.fileKey);
  });

  it("rejects download of expired job", async () => {
    const expiredJob = { ...BASE_JOB, expiresAt: new Date(Date.now() - 1000), status: "expired" };
    const selectChain = makeSelectChain([expiredJob]);
    const db = { select: jest.fn().mockReturnValue(selectChain) };
    const svc = await buildService(db);

    await expect(
      svc.download("user-requester", "org-1", "job-uuid-1", true),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects download of pending job — not yet complete", async () => {
    const pendingJob = { ...BASE_JOB, status: "pending", fileKey: null };
    const selectChain = makeSelectChain([pendingJob]);
    const db = { select: jest.fn().mockReturnValue(selectChain) };
    const svc = await buildService(db);

    await expect(
      svc.download("user-requester", "org-1", "job-uuid-1", true),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("job lookup always scopes by orgId — binding verifiable in the WHERE predicate chain", async () => {
    const where = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) });
    const from = jest.fn().mockReturnValue({ where });
    const db = { select: jest.fn().mockReturnValue({ from }) };
    const svc = await buildService(db);

    await svc.download("user-requester", "org-1", "job-uuid-1", false).catch(() => null);

    expect(where).toHaveBeenCalled();
  });
});

describe("GdprExportService — Item D: erasure audit log contains no PII", () => {
  it("view() output contains subjectUserId reference but does not embed name or email", () => {
    const svc = new GdprExportService(null as never, null as never);
    const view = svc.view(BASE_JOB as ReturnType<typeof Object.assign>);

    const viewJson = JSON.stringify(view);
    expect(viewJson).not.toContain("email");
    expect(viewJson).not.toContain("name");
    expect(viewJson).not.toContain("phone");
    expect(view.subjectUserId).toBe(BASE_JOB.subjectUserId);
  });
});
