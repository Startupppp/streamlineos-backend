import { NotFoundException } from "@nestjs/common";
import { KbImportExportService } from "./kb-import-export.service";
import { kbPages, kbImportJobs } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import type { PlanLimitsService } from "../../billing/core/plan-limits.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { ImportPagesInput } from "./dto/kb-import-export.schemas";

const emitMock = jest.fn().mockResolvedValue(undefined);
jest.mock("../../../common/outbox/outbox-writer", () => ({
  OutboxWriter: { emit: (...args: unknown[]) => emitMock(...args) },
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

function makeSelectChain(rows: unknown[] = []) {
  const chain = Object.assign(Promise.resolve(rows), {
    from: jest.fn(),
    where: jest.fn(),
    groupBy: jest.fn(),
  });
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.groupBy.mockReturnValue(chain);
  return chain;
}

function makeDb(options: {
  spaceRow?: { id: number } | null;
  existingRefRows?: Array<{ externalSource: string; externalId: string }>;
  insertedRefRows?: Array<{ id: number; contentRevision: number; aclRevision: number }>;
  insertedPlainRows?: Array<{ id: number; contentRevision: number; aclRevision: number }>;
  refThrows?: boolean;
  plainThrows?: boolean;
}) {
  const {
    spaceRow = { id: 1 },
    existingRefRows = [],
    insertedRefRows = [],
    insertedPlainRows = [],
    refThrows = false,
    plainThrows = false,
  } = options;

  const parentGroupChain = makeSelectChain([]);

  const refSelectChain = {
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue(existingRefRows),
    }),
  };

  let selectCallCount = 0;

  const refReturning = refThrows
    ? jest.fn().mockRejectedValue(new Error("insert failed"))
    : jest.fn().mockResolvedValue(insertedRefRows);
  const plainReturning = plainThrows
    ? jest.fn().mockRejectedValue(new Error("insert failed"))
    : jest.fn().mockResolvedValue(insertedPlainRows);

  const pagesInsertChain = {
    onConflictDoUpdate: jest.fn().mockReturnValue({ returning: refReturning }),
    onConflictDoNothing: jest.fn().mockReturnValue({ returning: plainReturning }),
  };

  const outboxInsertChain = { values: jest.fn().mockResolvedValue(undefined) };

  const jobsInsertChain = { returning: jest.fn().mockResolvedValue([{ id: 1 }]) };

  const db = {
    query: {
      kbSpaces: {
        findFirst: jest.fn().mockResolvedValue(spaceRow),
      },
    },
    select: jest.fn().mockImplementation(() => {
      selectCallCount += 1;
      return selectCallCount === 1 ? parentGroupChain : refSelectChain;
    }),
    insert: jest.fn().mockImplementation((table: unknown) => {
      if (table === kbImportJobs) return { values: jest.fn().mockReturnValue(jobsInsertChain) };
      if (table === kbPages) return { values: jest.fn().mockReturnValue(pagesInsertChain) };
      return { values: jest.fn().mockReturnValue(outboxInsertChain) };
    }),
    transaction: jest.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(db)),
  } as unknown as Db;

  return db;
}

const audit = { log: jest.fn() } as unknown as AuditService;
const planLimits = {
  assertWithinLimit: jest.fn().mockResolvedValue(undefined),
} as unknown as PlanLimitsService;

describe("KbImportExportService.importPages — target space validation", () => {
  afterEach(() => jest.clearAllMocks());

  it("throws NotFoundException when the requested space does not belong to the caller's org", async () => {
    const db = makeDb({ spaceRow: null });
    const service = new KbImportExportService(db, audit, planLimits, {} as never);
    const input: ImportPagesInput = {
      sourceType: "markdown",
      items: [{ title: "X", contentText: "y" }],
      spaceId: 999,
      visibility: "org",
      duplicatePolicy: "skip",
    } as ImportPagesInput;

    await expect(service.importPages(makeUser(), input)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("KbImportExportService.importPages — duplicate policy", () => {
  afterEach(() => jest.clearAllMocks());

  it("counts an existing external-ref match as a duplicate and skips it when duplicatePolicy is skip", async () => {
    const db = makeDb({
      existingRefRows: [{ externalSource: "confluence", externalId: "doc-1" }],
    });
    const service = new KbImportExportService(db, audit, planLimits, {} as never);
    const input: ImportPagesInput = {
      sourceType: "markdown",
      items: [{ title: "Doc", externalId: "doc-1", externalSource: "confluence" }],
      visibility: "org",
      duplicatePolicy: "skip",
    } as ImportPagesInput;

    const result = await service.importPages(makeUser(), input);

    expect(result.duplicates).toBe(1);
    expect(result.succeeded).toBe(0);
  });

  it("updates an existing external-ref match instead of skipping it when duplicatePolicy is update", async () => {
    const db = makeDb({
      existingRefRows: [{ externalSource: "confluence", externalId: "doc-1" }],
      insertedRefRows: [{ id: 5, contentRevision: 1, aclRevision: 1 }],
    });
    const service = new KbImportExportService(db, audit, planLimits, {} as never);
    const input: ImportPagesInput = {
      sourceType: "markdown",
      items: [{ title: "Doc", externalId: "doc-1", externalSource: "confluence" }],
      visibility: "org",
      duplicatePolicy: "update",
    } as ImportPagesInput;

    const result = await service.importPages(makeUser(), input);

    expect(result.duplicates).toBe(0);
    expect(result.succeeded).toBe(1);
  });
});

describe("KbImportExportService.importPages — indexing", () => {
  afterEach(() => jest.clearAllMocks());

  it("emits a kb.content.index outbox event for every page actually created", async () => {
    const db = makeDb({
      insertedPlainRows: [{ id: 7, contentRevision: 1, aclRevision: 1 }],
    });
    const service = new KbImportExportService(db, audit, planLimits, {} as never);
    const input: ImportPagesInput = {
      sourceType: "markdown",
      items: [{ title: "New Page", contentText: "body" }],
      visibility: "org",
      duplicatePolicy: "skip",
    } as ImportPagesInput;

    await service.importPages(makeUser(), input);

    expect(emitMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "kb.content.index",
        payload: expect.objectContaining({ contentType: "page", contentId: 7 }),
      }),
    );
  });

  it("emits no index event when nothing was actually inserted", async () => {
    const db = makeDb({ insertedPlainRows: [] });
    const service = new KbImportExportService(db, audit, planLimits, {} as never);
    const input: ImportPagesInput = {
      sourceType: "markdown",
      items: [{ title: "New Page", contentText: "body" }],
      visibility: "org",
      duplicatePolicy: "skip",
    } as ImportPagesInput;

    await service.importPages(makeUser(), input);

    expect(emitMock).not.toHaveBeenCalled();
  });
});

describe("KbImportExportService.importPages — error reporting", () => {
  afterEach(() => jest.clearAllMocks());

  it("records only the titles of items that actually failed, not every item in the batch", async () => {
    const db = makeDb({ plainThrows: true });
    let capturedJobValues: unknown = null;
    const insertMock = db.insert as jest.Mock;
    insertMock.mockImplementation((table: unknown) => {
      if (table === kbImportJobs) {
        return {
          values: jest.fn().mockImplementation((values: unknown) => {
            capturedJobValues = values;
            return { returning: jest.fn().mockResolvedValue([{ id: 1 }]) };
          }),
        };
      }
      if (table === kbPages) {
        return {
          values: jest.fn().mockReturnValue({
            onConflictDoUpdate: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([]),
            }),
            onConflictDoNothing: jest.fn().mockReturnValue({
              returning: jest.fn().mockRejectedValue(new Error("boom")),
            }),
          }),
        };
      }
      return { values: jest.fn().mockResolvedValue(undefined) };
    });

    const service = new KbImportExportService(db, audit, planLimits, {} as never);
    const input: ImportPagesInput = {
      sourceType: "markdown",
      items: [
        { title: "Will Fail One", contentText: "a" },
        { title: "Will Fail Two", contentText: "b" },
      ],
      visibility: "org",
      duplicatePolicy: "skip",
    } as ImportPagesInput;

    await service.importPages(makeUser(), input);

    expect(capturedJobValues).toMatchObject({
      errorReport: { failedTitles: ["Will Fail One", "Will Fail Two"] },
    });
  });

  it("reports no errorReport when every item succeeds", async () => {
    const db = makeDb({ insertedPlainRows: [{ id: 3, contentRevision: 1, aclRevision: 1 }] });
    let capturedJobValues: unknown = null;
    const insertMock = db.insert as jest.Mock;
    const originalImplementation = insertMock.getMockImplementation();
    insertMock.mockImplementation((table: unknown) => {
      if (table === kbImportJobs) {
        return {
          values: jest.fn().mockImplementation((values: unknown) => {
            capturedJobValues = values;
            return { returning: jest.fn().mockResolvedValue([{ id: 1 }]) };
          }),
        };
      }
      return originalImplementation!(table);
    });

    const service = new KbImportExportService(db, audit, planLimits, {} as never);
    const input: ImportPagesInput = {
      sourceType: "markdown",
      items: [{ title: "Succeeds", contentText: "a" }],
      visibility: "org",
      duplicatePolicy: "skip",
    } as ImportPagesInput;

    await service.importPages(makeUser(), input);

    expect(capturedJobValues).toMatchObject({ errorReport: null });
  });
});
