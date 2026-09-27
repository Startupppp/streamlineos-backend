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
    const service = new KbImportExportService(db, audit, planLimits);
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

