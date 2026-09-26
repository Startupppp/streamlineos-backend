import { KbImportExportService } from "./kb-import-export.service";
import { kbImportJobs, kbPages } from "../../../db/schema";
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

describe("KbImportExportService.importPages — failedTitles in result", () => {
  afterEach(() => jest.clearAllMocks());

  it("returns failedTitles for pages that failed to insert", async () => {
    let selectCallCount = 0;
    const jobsInsertChain = { returning: jest.fn().mockResolvedValue([{ id: 1 }]) };

    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount += 1;
        return makeSelectChain([]);
      }),
      insert: jest.fn().mockImplementation((table: unknown) => {
        if (table === kbImportJobs) return { values: jest.fn().mockReturnValue(jobsInsertChain) };
        if (table === kbPages) {
          return {
            values: jest.fn().mockReturnValue({
              onConflictDoNothing: jest.fn().mockReturnValue({
                returning: jest.fn().mockRejectedValue(new Error("constraint violation")),
              }),
            }),
          };
        }
        return { values: jest.fn().mockResolvedValue(undefined) };
      }),
      transaction: jest.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(db)),
    } as unknown as Db;

    const service = new KbImportExportService(db, audit, planLimits, {} as never);
    const input: ImportPagesInput = {
      sourceType: "markdown",
      items: [{ title: "Will Fail", contentText: "body" }],
      visibility: "org",
      duplicatePolicy: "skip",
    } as ImportPagesInput;

    const result = await service.importPages(makeUser(), input);

    expect(result.failed).toBe(1);
    expect(result.failedTitles).toEqual(["Will Fail"]);
  });

  it("returns an empty failedTitles array when every item succeeds", async () => {
    let selectCallCount = 0;
    const jobsInsertChain = { returning: jest.fn().mockResolvedValue([{ id: 1 }]) };

    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount += 1;
        return makeSelectChain([]);
      }),
      insert: jest.fn().mockImplementation((table: unknown) => {
        if (table === kbImportJobs) return { values: jest.fn().mockReturnValue(jobsInsertChain) };
        if (table === kbPages) {
          return {
            values: jest.fn().mockReturnValue({
              onConflictDoNothing: jest.fn().mockReturnValue({
                returning: jest.fn().mockResolvedValue([{ id: 5, contentRevision: 1, aclRevision: 1 }]),
              }),
            }),
          };
        }
        return { values: jest.fn().mockResolvedValue(undefined) };
      }),
      transaction: jest.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(db)),
    } as unknown as Db;

    const service = new KbImportExportService(db, audit, planLimits, {} as never);
    const input: ImportPagesInput = {
      sourceType: "markdown",
      items: [{ title: "Will Succeed", contentText: "body" }],
      visibility: "org",
      duplicatePolicy: "skip",
    } as ImportPagesInput;

    const result = await service.importPages(makeUser(), input);

    expect(result.succeeded).toBe(1);
    expect(result.failedTitles).toEqual([]);
  });
});
