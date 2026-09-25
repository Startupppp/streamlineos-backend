import { BadRequestException } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
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

describe("KbImportExportService.importPages parent validation", () => {
  it("rejects a parentPageId that does not belong to the caller's org", async () => {
    const where = jest.fn().mockResolvedValue([]);
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    const db = { select } as unknown as Db;

    const audit = { log: jest.fn() } as unknown as AuditService;
    const planLimits = {
      assertWithinLimit: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlanLimitsService;
    const authMock = {
      visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
      assertPageAccess: jest.fn().mockResolvedValue({ orgId: "o1", pageId: 1, action: "view", via: "admin" }),
    };

    const service = new KbImportExportService(db, audit, planLimits, authMock as never);

    const input: ImportPagesInput = {
      sourceType: "markdown",
      items: [{ title: "X", contentText: "y", parentPageId: 999 }],
    } as unknown as ImportPagesInput;

    await expect(service.importPages(makeUser(), input)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(planLimits.assertWithinLimit).toHaveBeenCalledWith("org-A", "kbPages", 1);
    expect(select).toHaveBeenCalledTimes(1);
  });
});

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

function makeCapturingInsertDb() {
  let capturedUpsertOpts: unknown = null;
  let noConflictCalled = false;

  const selectChain = makeSelectChain([]);
  const pagesReturning = jest.fn().mockResolvedValue([]);

  const pagesInsertChain = {
    onConflictDoUpdate: jest.fn().mockImplementation((opts: unknown) => {
      capturedUpsertOpts = opts;
      return { returning: pagesReturning };
    }),
    onConflictDoNothing: jest.fn().mockImplementation(() => {
      noConflictCalled = true;
      return { returning: pagesReturning };
    }),
  };

  const jobsInsertChain = {
    returning: jest.fn().mockResolvedValue([{ id: 1 }]),
  };

  const db = {
    select: jest.fn().mockReturnValue(selectChain),
    insert: jest.fn().mockImplementation((table: unknown) =>
      table === kbImportJobs
        ? { values: jest.fn().mockReturnValue(jobsInsertChain) }
        : { values: jest.fn().mockReturnValue(pagesInsertChain) },
    ),
    transaction: jest.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(db)),
  } as unknown as Db;

  return {
    db,
    getCapturedUpsertOpts: () => capturedUpsertOpts,
    wasNoConflictCalled: () => noConflictCalled,
    wasUpsertCalled: () => capturedUpsertOpts !== null,
  };
}

const sharedAudit = { log: jest.fn() } as unknown as AuditService;
const sharedPlanLimits = {
  assertWithinLimit: jest.fn().mockResolvedValue(undefined),
} as unknown as PlanLimitsService;
const sharedAuth = {
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  assertPageAccess: jest.fn().mockResolvedValue(undefined),
};

describe("KbImportExportService.importPages — external-ref idempotency", () => {
  afterEach(() => jest.resetAllMocks());

  it("uses onConflictDoUpdate for an item carrying externalId, and does not fall through to onConflictDoNothing", async () => {
    const { db, wasUpsertCalled, wasNoConflictCalled } = makeCapturingInsertDb();
    const service = new KbImportExportService(db, sharedAudit, sharedPlanLimits, sharedAuth as never);

    const input: ImportPagesInput = {
      sourceType: "markdown",
      items: [{ title: "My Doc", contentText: "body", externalId: "ext-123", externalSource: "confluence" }],
    } as unknown as ImportPagesInput;

    await service.importPages(makeUser(), input);

    expect(wasUpsertCalled()).toBe(true);
    expect(wasNoConflictCalled()).toBe(false);
  });

  it("conflict target names org_id, external_source, and external_id so one tenant cannot overwrite another tenant's page", async () => {
    const { db, getCapturedUpsertOpts } = makeCapturingInsertDb();
    const service = new KbImportExportService(db, sharedAudit, sharedPlanLimits, sharedAuth as never);

    const input: ImportPagesInput = {
      sourceType: "markdown",
      items: [{ title: "My Doc", externalId: "ext-123", externalSource: "confluence" }],
    } as unknown as ImportPagesInput;

    await service.importPages(makeUser(), input);

    const opts = getCapturedUpsertOpts() as { target: unknown[]; targetWhere: SQL };
    expect(opts).not.toBeNull();

    function colName(col: unknown): string {
      if (col !== null && typeof col === "object" && "name" in col && typeof (col as { name: unknown }).name === "string") {
        return (col as { name: string }).name;
      }
      return "";
    }
    const targetNames = opts.target.map(colName);

    expect(targetNames).toContain("org_id");
    expect(targetNames).toContain("external_source");
    expect(targetNames).toContain("external_id");

    const dialect = new PgDialect();
    const renderedWhere = dialect.sqlToQuery(opts.targetWhere).sql;
    expect(renderedWhere).toContain("external_id");
    expect(renderedWhere).toContain("IS NOT NULL");
  });

  it("uses onConflictDoNothing for an item without externalId, so the plain-insert path is not regressed", async () => {
    const { db, wasUpsertCalled, wasNoConflictCalled } = makeCapturingInsertDb();
    const service = new KbImportExportService(db, sharedAudit, sharedPlanLimits, sharedAuth as never);

    const input: ImportPagesInput = {
      sourceType: "markdown",
      items: [{ title: "Plain Doc", contentText: "body" }],
    } as unknown as ImportPagesInput;

    await service.importPages(makeUser(), input);

    expect(wasNoConflictCalled()).toBe(true);
    expect(wasUpsertCalled()).toBe(false);
  });
});

describe("KbImportExportService.importPages — withoutRef title dedup inside the transaction", () => {
  afterEach(() => jest.resetAllMocks());

  function makeConditionalSelectDb(existingTitle: string) {
    const insideTxRef = { value: false };

    function makeWhereChain(): { groupBy: jest.Mock } & PromiseLike<Array<{ title?: string }>> {
      const groupBy = jest.fn().mockResolvedValue([]);
      const thenable: { groupBy: jest.Mock } & PromiseLike<Array<{ title?: string }>> = {
        groupBy,
        then: <T>(
          onFulfilled: (rows: Array<{ title?: string }>) => T,
          onRejected?: (e: unknown) => T,
        ) =>
          Promise.resolve(
            insideTxRef.value ? [{ title: existingTitle }] : [],
          ).then(onFulfilled, onRejected),
      };
      return thenable;
    }

    const jobsInsert = { returning: jest.fn().mockResolvedValue([{ id: 1 }]) };
    const pagesInsert = {
      onConflictDoNothing: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([]),
      }),
    };

    const db: Partial<Db> & {
      transaction: jest.Mock;
      select: jest.Mock;
      insert: jest.Mock;
    } = {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation(() => makeWhereChain()),
        }),
      })),
      insert: jest.fn().mockImplementation((table: unknown) => {
        if (table === kbImportJobs) return { values: jest.fn().mockReturnValue(jobsInsert) };
        return { values: jest.fn().mockReturnValue(pagesInsert) };
      }),
      transaction: jest.fn().mockImplementation(async (cb: (tx: typeof db) => Promise<unknown>) => {
        insideTxRef.value = true;
        try {
          return await cb(db as typeof db);
        } finally {
          insideTxRef.value = false;
        }
      }),
    };

    return db as unknown as Db;
  }

  it("counts a plain-title match as a duplicate when duplicatePolicy is skip and the check runs inside the transaction", async () => {
    const db = makeConditionalSelectDb("Existing Doc");
    const service = new KbImportExportService(db, sharedAudit, sharedPlanLimits, sharedAuth as never);

    const input: ImportPagesInput = {
      sourceType: "markdown",
      items: [{ title: "Existing Doc", contentText: "body" }],
      duplicatePolicy: "skip",
    } as unknown as ImportPagesInput;

    const result = await service.importPages(makeUser(), input);

    expect(result.duplicates).toBe(1);
    expect(result.succeeded).toBe(0);
  });

  it("inserts a plain-title item when no collision is found inside the transaction", async () => {
    const insideTxRef = { value: false };

    function makeEmptyWhereChain(): { groupBy: jest.Mock } & PromiseLike<unknown[]> {
      const groupBy = jest.fn().mockResolvedValue([]);
      const thenable: { groupBy: jest.Mock } & PromiseLike<unknown[]> = {
        groupBy,
        then: <T>(onFulfilled: (rows: unknown[]) => T, onRejected?: (e: unknown) => T) =>
          Promise.resolve([]).then(onFulfilled, onRejected),
      };
      return thenable;
    }

    const jobsInsert = { returning: jest.fn().mockResolvedValue([{ id: 1 }]) };
    const pagesInsert = {
      onConflictDoNothing: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 9, contentRevision: 1, aclRevision: 1 }]),
      }),
    };

    const db: Partial<Db> & {
      transaction: jest.Mock;
      select: jest.Mock;
      insert: jest.Mock;
    } = {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation(() => makeEmptyWhereChain()),
        }),
      })),
      insert: jest.fn().mockImplementation((table: unknown) => {
        if (table === kbImportJobs) return { values: jest.fn().mockReturnValue(jobsInsert) };
        return { values: jest.fn().mockReturnValue(pagesInsert) };
      }),
      transaction: jest.fn().mockImplementation(async (cb: (tx: typeof db) => Promise<unknown>) => {
        insideTxRef.value = true;
        try {
          return await cb(db as typeof db);
        } finally {
          insideTxRef.value = false;
        }
      }),
    };

    const service = new KbImportExportService(
      db as unknown as Db,
      sharedAudit,
      sharedPlanLimits,
      sharedAuth as never,
    );

    const input: ImportPagesInput = {
      sourceType: "markdown",
      items: [{ title: "New Doc", contentText: "body" }],
      duplicatePolicy: "skip",
    } as unknown as ImportPagesInput;

    const result = await service.importPages(makeUser(), input);

    expect(result.succeeded).toBe(1);
    expect(result.duplicates).toBe(0);
  });
});
