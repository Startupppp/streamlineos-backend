import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { ExpenseExportWorkerService } from "./expense-export-worker.service";
import { ExpenseExportService, EXPORT_BATCH_SIZE } from "./expense-export.service";
import { StorageService } from "../storage/storage.service";
import type { ExpenseExportJobRow } from "./expense-export.service";

const EXPORT_ROW_CAP = 50_000;

function makeJob(overrides: Partial<ExpenseExportJobRow> = {}): ExpenseExportJobRow {
  return {
    id: "job-1",
    orgId: "org-a",
    requestedByMembershipId: 1,
    status: "running",
    filters: { scope: "all" } as ExpenseExportJobRow["filters"],
    idempotencyKey: "idem-1",
    requestHash: "hash-1",
    attempt: 1,
    maxAttempts: 3,
    processedRows: 0,
    rowCount: null,
    truncated: false,
    fileKey: null,
    fileName: null,
    fileSizeBytes: null,
    errorCode: null,
    errorMessage: null,
    lockedAt: new Date(),
    completedAt: null,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ExpenseExportJobRow;
}

function makeRow(id: number) {
  return {
    id,
    date: "2026-01-01",
    employee: "Alice",
    email: "alice@example.com",
    category: "TRAVEL",
    amount: "100.00",
    description: "trip",
    status: "APPROVED" as const,
    rejection: null,
  };
}

function buildBatch(startId: number, size: number) {
  return Array.from({ length: size }, (_, i) => makeRow(startId + i));
}

async function buildWorker(jobsMock: Partial<ExpenseExportService>, storageMock: Partial<StorageService>) {
  const db = {} as never;
  const module = await Test.createTestingModule({
    providers: [
      ExpenseExportWorkerService,
      { provide: DRIZZLE, useValue: db },
      { provide: ExpenseExportService, useValue: jobsMock },
      { provide: StorageService, useValue: storageMock },
    ],
  }).compile();
  return module.get(ExpenseExportWorkerService);
}

describe("ExpenseExportWorkerService — row cap", () => {
  it("sets truncated=true and caps count at EXPORT_ROW_CAP when the source has more rows", async () => {
    const job = makeJob();
    let callCount = 0;

    const jobs = {
      rows: jest.fn().mockImplementation(async () => {
        callCount++;
        return buildBatch((callCount - 1) * EXPORT_BATCH_SIZE, EXPORT_BATCH_SIZE);
      }),
      progress: jest.fn().mockResolvedValue(undefined),
      complete: jest.fn().mockResolvedValue(undefined),
      fail: jest.fn().mockResolvedValue(undefined),
    } as unknown as ExpenseExportService;

    const storage = {
      isConfigured: () => true,
      uploadFile: jest.fn().mockResolvedValue({ key: "k.csv", size: 1024 }),
    } as unknown as StorageService;

    const worker = await buildWorker(jobs, storage);
    await (worker as unknown as { process: (job: ExpenseExportJobRow) => Promise<void> }).process(job);

    expect(jobs.complete).toHaveBeenCalledTimes(1);
    const [, , , , count, truncated] = (jobs.complete as jest.Mock).mock.calls[0] as [string, string, string, number, number, boolean];
    expect(count).toBe(EXPORT_ROW_CAP);
    expect(truncated).toBe(true);
  });

  it("sets truncated=false when the source has fewer rows than the cap", async () => {
    const job = makeJob();
    const SMALL_COUNT = 42;

    const jobs = {
      rows: jest.fn()
        .mockResolvedValueOnce(buildBatch(0, SMALL_COUNT))
        .mockResolvedValueOnce([]),
      progress: jest.fn().mockResolvedValue(undefined),
      complete: jest.fn().mockResolvedValue(undefined),
      fail: jest.fn().mockResolvedValue(undefined),
    } as unknown as ExpenseExportService;

    const storage = {
      isConfigured: () => true,
      uploadFile: jest.fn().mockResolvedValue({ key: "k.csv", size: 512 }),
    } as unknown as StorageService;

    const worker = await buildWorker(jobs, storage);
    await (worker as unknown as { process: (job: ExpenseExportJobRow) => Promise<void> }).process(job);

    expect(jobs.complete).toHaveBeenCalledTimes(1);
    const [, , , , count, truncated] = (jobs.complete as jest.Mock).mock.calls[0] as [string, string, string, number, number, boolean];
    expect(count).toBe(SMALL_COUNT);
    expect(truncated).toBe(false);
  });

  it("discriminates: a mock returning exactly EXPORT_BATCH_SIZE rows per call triggers the cap", async () => {
    const job = makeJob();
    let rowsSeen = 0;

    const jobs = {
      rows: jest.fn().mockImplementation(async () => {
        if (rowsSeen >= EXPORT_ROW_CAP) return [];
        const batch = buildBatch(rowsSeen, EXPORT_BATCH_SIZE);
        rowsSeen += EXPORT_BATCH_SIZE;
        return batch;
      }),
      progress: jest.fn().mockResolvedValue(undefined),
      complete: jest.fn().mockResolvedValue(undefined),
      fail: jest.fn().mockResolvedValue(undefined),
    } as unknown as ExpenseExportService;

    const storage = {
      isConfigured: () => true,
      uploadFile: jest.fn().mockResolvedValue({ key: "k.csv", size: 2048 }),
    } as unknown as StorageService;

    const worker = await buildWorker(jobs, storage);
    await (worker as unknown as { process: (job: ExpenseExportJobRow) => Promise<void> }).process(job);

    const [, , , , count, truncated] = (jobs.complete as jest.Mock).mock.calls[0] as [string, string, string, number, number, boolean];
    expect(count).toBe(EXPORT_ROW_CAP);
    expect(truncated).toBe(true);
  });

  it("truncated=false is achievable when the source has fewer rows than cap (discriminator)", async () => {
    const job = makeJob();

    const jobs = {
      rows: jest.fn()
        .mockResolvedValueOnce(buildBatch(0, 10))
        .mockResolvedValueOnce([]),
      progress: jest.fn().mockResolvedValue(undefined),
      complete: jest.fn().mockResolvedValue(undefined),
      fail: jest.fn().mockResolvedValue(undefined),
    } as unknown as ExpenseExportService;

    const storage = {
      isConfigured: () => true,
      uploadFile: jest.fn().mockResolvedValue({ key: "k.csv", size: 128 }),
    } as unknown as StorageService;

    const worker = await buildWorker(jobs, storage);
    await (worker as unknown as { process: (job: ExpenseExportJobRow) => Promise<void> }).process(job);

    const [, , , , , truncated] = (jobs.complete as jest.Mock).mock.calls[0] as [string, string, string, number, number, boolean];
    expect(truncated).toBe(false);
  });
});
