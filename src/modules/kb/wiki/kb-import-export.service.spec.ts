import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { KbImportExportService } from "./kb-import-export.service";
import { kbImportJobs } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import type { PlanLimitsService } from "../../billing/core/plan-limits.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { ImportPagesInput } from "./dto/kb-import-export.schemas";

jest.mock("../../../common/outbox/outbox-writer", () => ({
  OutboxWriter: { emit: jest.fn().mockResolvedValue(undefined) },
}));

function makeUser(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-A",
    role: "member",
    isOrgOwner: false,
    enabledModules: ["kb"],
  } as unknown as CurrentUserContext;
}

const sharedAudit = { log: jest.fn() } as unknown as AuditService;
const sharedPlanLimits = {
  assertWithinLimit: jest.fn().mockResolvedValue(undefined),
} as unknown as PlanLimitsService;

function makeSelectChain(rows: unknown[] = []) {
  const chain = Object.assign(Promise.resolve(rows), {
    from: jest.fn(),
    where: jest.fn(),
    groupBy: jest.fn(),
    limit: jest.fn(),
  });
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.groupBy.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  return chain;
}

describe("KbImportExportService.importPages — async handoff", () => {
  afterEach(() => jest.resetAllMocks());

  function makeAsyncDb() {
    let capturedEventType: string | null = null;
    const { OutboxWriter } = jest.requireMock("../../../common/outbox/outbox-writer") as {
      OutboxWriter: { emit: jest.Mock };
    };
    OutboxWriter.emit.mockImplementation((_tx: unknown, input: { eventType: string }) => {
      capturedEventType = input.eventType;
      return Promise.resolve();
    });

    const jobsInsertChain = {
      returning: jest.fn().mockResolvedValue([{ id: 7 }]),
    };

    const db = {
      select: jest.fn().mockReturnValue(makeSelectChain([])),
      insert: jest.fn().mockImplementation((table: unknown) => {
        if (table === kbImportJobs)
          return { values: jest.fn().mockReturnValue(jobsInsertChain) };
        return { values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) };
      }),
      transaction: jest.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(db)),
      query: {
        kbSpaces: { findFirst: jest.fn().mockResolvedValue(undefined) },
        kbPages: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
    } as unknown as Db;

    return { db, getEventType: () => capturedEventType };
  }

  it("creates a pending job, emits kb.import.process, and returns { jobId, status: 'pending' }", async () => {
    const { db, getEventType } = makeAsyncDb();
    const service = new KbImportExportService(db, sharedAudit, sharedPlanLimits);

    const input: ImportPagesInput = {
      sourceType: "markdown",
      items: [{ title: "My Doc", contentText: "body" }],
      visibility: "org",
      duplicatePolicy: "skip",
    } as unknown as ImportPagesInput;

    const result = await service.importPages(makeUser(), input);

    expect(result.status).toBe("pending");
    expect(typeof result.jobId).toBe("number");
    expect(getEventType()).toBe("kb.import.process");
  });

  it("does not insert kb_pages rows — all page inserts happen in the consumer", async () => {
    const { db } = makeAsyncDb();
    const insertMock = db.insert as jest.Mock;
    const service = new KbImportExportService(db, sharedAudit, sharedPlanLimits);

    const input: ImportPagesInput = {
      sourceType: "markdown",
      items: [{ title: "My Doc", contentText: "body" }],
      visibility: "org",
      duplicatePolicy: "skip",
    } as unknown as ImportPagesInput;

    await service.importPages(makeUser(), input);

    const insertedTables = insertMock.mock.calls.map(([table]) => table);
    expect(insertedTables.every((t: unknown) => t === kbImportJobs)).toBe(true);
  });
});

describe("KbImportExportService.importPages — pre-flight validation", () => {
  afterEach(() => jest.resetAllMocks());

  it("rejects items with binary content before creating a job", async () => {
    const insertMock = jest.fn();
    const db = {
      select: jest.fn().mockReturnValue(makeSelectChain([])),
      insert: insertMock,
      transaction: jest.fn(),
      query: { kbSpaces: { findFirst: jest.fn() }, kbPages: { findFirst: jest.fn() } },
    } as unknown as Db;

    const service = new KbImportExportService(db, sharedAudit, sharedPlanLimits);
    const input: ImportPagesInput = {
      sourceType: "markdown",
      items: [{ title: "Bad", contentText: "bin\0ary" }],
      visibility: "org",
      duplicatePolicy: "skip",
    } as unknown as ImportPagesInput;

    await expect(service.importPages(makeUser(), input)).rejects.toBeInstanceOf(BadRequestException);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("rejects a parentPageId that does not belong to the caller's org", async () => {
    const insertMock = jest.fn();
    const db = {
      select: jest.fn().mockReturnValue(makeSelectChain([])),
      insert: insertMock,
      transaction: jest.fn(),
      query: { kbSpaces: { findFirst: jest.fn() }, kbPages: { findFirst: jest.fn() } },
    } as unknown as Db;

    const service = new KbImportExportService(db, sharedAudit, sharedPlanLimits);
    const input: ImportPagesInput = {
      sourceType: "markdown",
      items: [{ title: "X", contentText: "y", parentPageId: 999 }],
    } as unknown as ImportPagesInput;

    await expect(service.importPages(makeUser(), input)).rejects.toBeInstanceOf(BadRequestException);
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe("KbImportExportService.getImportJob", () => {
  afterEach(() => jest.resetAllMocks());

  it("returns the job row when found", async () => {
    const jobRow = {
      id: 3,
      orgId: "org-A",
      status: "completed",
      sourceType: "markdown",
      totalItems: 5,
      succeededItems: 5,
      failedItems: 0,
      duplicateItems: 0,
      processedItems: 5,
      fileKey: null,
      errorReport: null,
      createdById: "user-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = {
      select: jest.fn().mockReturnValue(makeSelectChain([jobRow])),
    } as unknown as Db;

    const service = new KbImportExportService(db, sharedAudit, sharedPlanLimits);
    const result = await service.getImportJob("org-A", 3);
    expect(result.id).toBe(3);
    expect(result.status).toBe("completed");
  });

  it("throws NotFoundException when job not found", async () => {
    const db = {
      select: jest.fn().mockReturnValue(makeSelectChain([])),
    } as unknown as Db;

    const service = new KbImportExportService(db, sharedAudit, sharedPlanLimits);
    await expect(service.getImportJob("org-A", 999)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("KbImportExportService.cancelImportJob", () => {
  afterEach(() => jest.resetAllMocks());

  it("cancels a pending job and returns the expected message", async () => {
    const updateSetWhere = jest.fn().mockResolvedValue(undefined);
    const updateSet = jest.fn().mockReturnValue({ where: updateSetWhere });
    const db = {
      select: jest.fn().mockReturnValue(makeSelectChain([{ status: "pending" }])),
      update: jest.fn().mockReturnValue({ set: updateSet }),
    } as unknown as Db;

    const service = new KbImportExportService(db, sharedAudit, sharedPlanLimits);
    const result = await service.cancelImportJob("org-A", 1);
    expect(result.status).toBe("cancelled");
    expect(updateSetWhere).toHaveBeenCalledTimes(1);
  });

  it("returns a truthful message when cancelling a job that is already processing", async () => {
    const db = {
      select: jest.fn().mockReturnValue(makeSelectChain([{ status: "processing" }])),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      }),
    } as unknown as Db;

    const service = new KbImportExportService(db, sharedAudit, sharedPlanLimits);
    const result = await service.cancelImportJob("org-A", 1);
    expect(result.status).toBe("cancelled");
    expect(result.message).toContain("processing has already begun");
  });

  it("throws ConflictException when the job is already completed", async () => {
    const db = {
      select: jest.fn().mockReturnValue(makeSelectChain([{ status: "completed" }])),
    } as unknown as Db;

    const service = new KbImportExportService(db, sharedAudit, sharedPlanLimits);
    await expect(service.cancelImportJob("org-A", 1)).rejects.toBeInstanceOf(ConflictException);
  });

  it("throws NotFoundException when job does not exist", async () => {
    const db = {
      select: jest.fn().mockReturnValue(makeSelectChain([])),
    } as unknown as Db;

    const service = new KbImportExportService(db, sharedAudit, sharedPlanLimits);
    await expect(service.cancelImportJob("org-A", 999)).rejects.toBeInstanceOf(NotFoundException);
  });
});
