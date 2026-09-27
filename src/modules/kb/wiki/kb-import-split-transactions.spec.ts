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

describe("KbImportExportService.importPages — split transactions (BE-84 connection hold fix)", () => {
  afterEach(() => jest.clearAllMocks());

  it("queues the import job in exactly one transaction for mixed-ref and plain items, so batch processing does not hold a connection", async () => {
    const jobsInsertChain = { returning: jest.fn().mockResolvedValue([{ id: 1 }]) };
    const transactionSpy = jest.fn().mockImplementation(
      (cb: (tx: unknown) => Promise<unknown>) => cb({
        select: jest.fn().mockImplementation(() => makeSelectChain([])),
        insert: jest.fn().mockImplementation((table: unknown) => {
          if (table === kbImportJobs) return { values: jest.fn().mockReturnValue(jobsInsertChain) };
          if (table === kbPages) {
            return {
              values: jest.fn().mockReturnValue({
                onConflictDoUpdate: jest.fn().mockReturnValue({
                  returning: jest.fn().mockResolvedValue([]),
                }),
                onConflictDoNothing: jest.fn().mockReturnValue({
                  returning: jest.fn().mockResolvedValue([]),
                }),
              }),
            };
          }
          return { values: jest.fn().mockResolvedValue(undefined) };
        }),
      } as unknown),
    );

    const db = {
      select: jest.fn().mockImplementation(() => makeSelectChain([])),
      insert: jest.fn().mockResolvedValue(undefined),
      transaction: transactionSpy,
    } as unknown as Db;

    const service = new KbImportExportService(db, audit, planLimits);

    const input: ImportPagesInput = {
      sourceType: "markdown",
      items: [
        { title: "Ref Page", externalId: "ext-1", externalSource: "confluence" },
        { title: "Plain Page", contentText: "body" },
      ],
      visibility: "org",
      duplicatePolicy: "skip",
    } as ImportPagesInput;

    await service.importPages(makeUser(), input);

    expect(transactionSpy.mock.calls.length).toBe(1);
  });

  it("uses a single transaction for an all-plain import (no withRef batch)", async () => {
    const jobsInsertChain = { returning: jest.fn().mockResolvedValue([{ id: 1 }]) };
    const transactionSpy = jest.fn().mockImplementation(
      (cb: (tx: unknown) => Promise<unknown>) => cb({
        insert: jest.fn().mockImplementation((table: unknown) => {
          if (table === kbImportJobs) return { values: jest.fn().mockReturnValue(jobsInsertChain) };
          if (table === kbPages) {
            return {
              values: jest.fn().mockReturnValue({
                onConflictDoNothing: jest.fn().mockReturnValue({
                  returning: jest.fn().mockResolvedValue([]),
                }),
              }),
            };
          }
          return { values: jest.fn().mockResolvedValue(undefined) };
        }),
      } as unknown),
    );

    const db = {
      select: jest.fn().mockImplementation(() => makeSelectChain([])),
      insert: jest.fn().mockResolvedValue(undefined),
      transaction: transactionSpy,
    } as unknown as Db;

    const service = new KbImportExportService(db, audit, planLimits);

    const input: ImportPagesInput = {
      sourceType: "markdown",
      items: [{ title: "Only Plain Page", contentText: "body" }],
      visibility: "org",
      duplicatePolicy: "skip",
    } as ImportPagesInput;

    await service.importPages(makeUser(), input);

    expect(transactionSpy.mock.calls.length).toBe(1);
  });
});
