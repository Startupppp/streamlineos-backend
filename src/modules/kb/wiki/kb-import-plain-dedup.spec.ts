import { KbImportExportService } from "./kb-import-export.service";
import { kbImportJobs, kbPages } from "../../../db/schema";
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

const audit = { log: jest.fn() } as unknown as AuditService;
const planLimits = {
  assertWithinLimit: jest.fn().mockResolvedValue(undefined),
} as unknown as PlanLimitsService;

function makeSelectChain(rows: unknown[]) {
  return Object.assign(Promise.resolve(rows), {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
  });
}

function buildDb(options: {
  existingTitles?: string[];
  insertedRows?: Array<{ id: number; contentRevision: number; aclRevision: number }>;
}) {
  const { existingTitles = [], insertedRows = [] } = options;
  let selectCallCount = 0;
  const jobsInsertChain = { returning: jest.fn().mockResolvedValue([{ id: 1 }]) };

  const db = {
    select: jest.fn().mockImplementation(() => {
      selectCallCount += 1;
      if (selectCallCount === 1) return makeSelectChain([]);
      if (selectCallCount === 2) return makeSelectChain(existingTitles.map((t) => ({ title: t })));
      return makeSelectChain([]);
    }),
    insert: jest.fn().mockImplementation((table: unknown) => {
      if (table === kbImportJobs) return { values: jest.fn().mockReturnValue(jobsInsertChain) };
      if (table === kbPages) {
        return {
          values: jest.fn().mockReturnValue({
            onConflictDoNothing: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue(insertedRows),
            }),
          }),
        };
      }
      return { values: jest.fn().mockResolvedValue(undefined) };
    }),
    transaction: jest.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(db)),
  } as unknown as Db;

  return db;
}

describe("KbImportExportService.importPages — plain item deduplication by title", () => {
  afterEach(() => jest.clearAllMocks());

  it("counts a plain item as duplicate and skips insert when matching title exists in same org", async () => {
    const db = buildDb({ existingTitles: ["My Doc"] });
    const service = new KbImportExportService(db, audit, planLimits, {} as never);
    const input: ImportPagesInput = {
      sourceType: "markdown",
      items: [{ title: "My Doc", contentText: "body" }],
      visibility: "org",
      duplicatePolicy: "skip",
    } as ImportPagesInput;

    const result = await service.importPages(makeUser(), input);

    expect(result.duplicates).toBe(1);
    expect(result.succeeded).toBe(0);
  });

  it("inserts a plain item and does not count it as duplicate when title is absent from org", async () => {
    const db = buildDb({
      existingTitles: [],
      insertedRows: [{ id: 7, contentRevision: 1, aclRevision: 1 }],
    });
    const service = new KbImportExportService(db, audit, planLimits, {} as never);
    const input: ImportPagesInput = {
      sourceType: "markdown",
      items: [{ title: "Brand New Page", contentText: "body" }],
      visibility: "org",
      duplicatePolicy: "skip",
    } as ImportPagesInput;

    const result = await service.importPages(makeUser(), input);

    expect(result.succeeded).toBe(1);
    expect(result.duplicates).toBe(0);
  });

  it("does not skip a plain item when duplicatePolicy is update even if the title exists", async () => {
    const db = buildDb({
      existingTitles: ["Existing"],
      insertedRows: [{ id: 9, contentRevision: 1, aclRevision: 1 }],
    });
    const service = new KbImportExportService(db, audit, planLimits, {} as never);
    const input: ImportPagesInput = {
      sourceType: "markdown",
      items: [{ title: "Existing", contentText: "updated body" }],
      visibility: "org",
      duplicatePolicy: "update",
    } as ImportPagesInput;

    const result = await service.importPages(makeUser(), input);

    expect(result.duplicates).toBe(0);
    expect(result.succeeded).toBe(1);
  });
});
