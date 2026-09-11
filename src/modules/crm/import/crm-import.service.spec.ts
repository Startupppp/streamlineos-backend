import { ConflictException, Logger } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.types";
import type { WorkflowRunnerService } from "../../../common/workflow";
import {
  businessParties,
  crmImportRows,
  crmImports,
  dataQualityFindings,
  partyIdentifiers,
} from "../../../db/schema";
import { CrmImportService, REVERT_WINDOW_DAYS } from "./crm-import.service";
import { CrmImportPreviewService } from "./crm-import-preview.service";
import { CrmImportCommitService } from "./crm-import-commit.service";
import { CrmImportRevertService } from "./crm-import-revert.service";
import type { PlanLimitsService } from "../../billing/core/plan-limits.service";

const ORG = "org-1";
const IMPORT = "import-1";
const WHOLE_FILE = { fromRow: 1, toRow: 100 };

interface Statement {
  kind: "select" | "insert" | "update";
  table: unknown;
  values: Record<string, unknown>[];
  set: Record<string, unknown> | null;
  where: SQL | undefined;
  /** The savepoint it ran in. 0 is the step's own transaction. */
  savepoint: number;
  /** `SELECT ... FOR UPDATE`, which is how a row is claimed. */
  locking?: boolean;
  rolledBack: boolean;
}

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

interface FakeOptions {
  importStatus?: string;
  /** Which entity the import writes. Every import before 0281 was a party one. */
  targetEntity?: string;
  targetSubjectTypeId?: string | null;
  revertDeadlineAt?: Date | null;
  rows?: Record<string, unknown>[];
  parties?: Record<string, unknown>[];
  /** The statement Postgres refuses. */
  rejects?: (statement: Statement) => Error | null;
}

/**
 * A database that fails the way Postgres fails, and claims rows the way this
 * service does.
 *
 * The defect the savepoints are for is not "an insert threw" — it is what the
 * NEXT statement does after one did. Postgres aborts the whole transaction on a
 * statement error, so every later statement in it raises 25P02 until something
 * rolls back; a savepoint is what gives a caller a smaller thing to roll back
 * to. A fake where the error-recording UPDATE simply succeeds cannot see the bug
 * at all, which is why this one models both halves.
 *
 * It also models the row CLAIM, which is the whole idempotence story of the
 * durable importer: `UPDATE … SET committed_at = now() WHERE committed_at IS
 * NULL RETURNING *` hands back a row the first time and nothing every time
 * after. A claim taken inside a savepoint is released when that savepoint rolls
 * back, exactly as Postgres would — without that, a failed row would look
 * permanently done and be silently dropped from the import.
 */
class FakeDb {
  readonly statements: Statement[] = [];
  private readonly aborted = new Set<number>();
  private nextSavepoint = 1;
  private createdParties = 0;
  private filedFindings = 0;
  /** Row id → the savepoint that claimed it, so a rollback can release it. */
  private readonly committedRows = new Map<string, number>();
  private readonly revertedRows = new Map<string, number>();

  constructor(private readonly options: FakeOptions = {}) {}

  get db(): Db {
    return this.handle(0) as unknown as Db;
  }

  /** Statements that actually stuck, which is what "did it import?" means. */
  landed(kind: Statement["kind"], table: unknown): Statement[] {
    return this.statements.filter(
      (statement) => statement.kind === kind && statement.table === table && !statement.rolledBack,
    );
  }

  private handle(savepoint: number): Record<string, unknown> {
    return {
      select: () => this.builder(savepoint, "select"),
      insert: (table: unknown) => this.builder(savepoint, "insert", table),
      update: (table: unknown) => this.builder(savepoint, "update", table),
      // `withTenant` sets its GUCs this way; nothing here depends on the result.
      execute: () => Promise.resolve([]),
      transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
        const child = this.nextSavepoint++;
        const from = this.statements.length;

        try {
          return await fn(this.handle(child));
        } catch (error) {
          // ROLLBACK TO SAVEPOINT: this savepoint's writes are gone and the
          // transaction around it is usable again.
          this.aborted.delete(child);
          for (let index = from; index < this.statements.length; index += 1) {
            const statement = this.statements[index];
            if (statement && statement.savepoint === child) statement.rolledBack = true;
          }
          for (const [rowId, claimedBy] of [...this.committedRows])
            if (claimedBy === child) this.committedRows.delete(rowId);
          for (const [rowId, claimedBy] of [...this.revertedRows])
            if (claimedBy === child) this.revertedRows.delete(rowId);
          throw error;
        }
      },
    };
  }

  private builder(savepoint: number, kind: Statement["kind"], table?: unknown) {
    const statement: Statement = {
      kind,
      table,
      values: [],
      set: null,
      where: undefined,
      savepoint,
      locking: false,
      rolledBack: false,
    };

    const self: Record<string, unknown> = {
      from: (source: unknown) => {
        statement.table = source;
        return self;
      },
      where: (condition: SQL) => {
        statement.where = condition;
        return self;
      },
      /**
       * `SELECT ... FOR UPDATE` is the claim now.
       *
       * `commitRow` used to claim by stamping `committed_at` and returning the
       * row, which marked it done before it had done anything and failed
       * `chk_crm_import_rows_outcome` on its own first statement. The lock does
       * the same job — block a second claimer, then re-evaluate against
       * committed truth — without asserting an outcome that has not happened.
       */
      for: () => {
        statement.locking = true;
        return self;
      },
      set: (payload: Record<string, unknown>) => {
        statement.set = payload;
        return self;
      },
      values: (payload: Record<string, unknown> | Record<string, unknown>[]) => {
        statement.values = Array.isArray(payload) ? payload : [payload];
        return self;
      },
      returning: () => self,
      onConflictDoNothing: () => self,
      onConflictDoUpdate: () => self,
      orderBy: () => self,
      limit: () => self,
      then: (resolve: (value: unknown) => void, reject: (error: unknown) => void) =>
        Promise.resolve()
          .then(() => this.run(statement))
          .then(resolve, reject),
    };

    return self;
  }

  private run(statement: Statement): unknown {
    if (this.aborted.has(statement.savepoint))
      throw pgError(
        "25P02",
        "current transaction is aborted, commands ignored until end of transaction block",
      );

    this.statements.push(statement);

    const rejection = this.options.rejects?.(statement) ?? null;
    if (rejection) {
      this.aborted.add(statement.savepoint);
      throw rejection;
    }

    return this.respond(statement);
  }

  /** The row identifier named in a WHERE, found among its bound parameters. */
  private rowIdIn(statement: Statement): string | null {
    if (!statement.where) return null;
    const { params } = new PgDialect().sqlToQuery(statement.where);
    const known = new Set((this.options.rows ?? []).map((row) => String(row.crmImportRowId)));
    for (const param of params) if (typeof param === "string" && known.has(param)) return param;
    return null;
  }

  private rowById(rowId: string): Record<string, unknown> | undefined {
    return (this.options.rows ?? []).find((row) => row.crmImportRowId === rowId);
  }

  private respond(statement: Statement): unknown {
    if (statement.kind === "select") {
      if (statement.table === crmImports)
        return [
          {
            status: this.options.importStatus ?? "previewing",
            sourceFilename: "zoho.csv",
            targetEntity: this.options.targetEntity ?? "party",
            targetSubjectTypeId: this.options.targetSubjectTypeId ?? null,
            workflowRunId: null,
            revertWorkflowRunId: null,
            revertDeadlineAt: this.options.revertDeadlineAt ?? null,
          },
        ];
      if (statement.table === crmImportRows) {
        // The batch's own listing of the window: every row, unlocked.
        if (!statement.locking) return this.options.rows ?? [];

        // The claim. Modelled exactly as Postgres resolves it: a row another
        // claimer already holds is not returned, so the caller does nothing.
        const rowId = this.rowIdIn(statement);
        if (!rowId) return this.options.rows ?? [];
        if (this.committedRows.has(rowId)) return [];
        this.committedRows.set(rowId, statement.savepoint);
        return [this.rowById(rowId) ?? []].flat();
      }
      if (statement.table === businessParties) return this.options.parties ?? [];
    }

    if (statement.kind === "insert") {
      if (statement.table === businessParties) {
        this.createdParties += 1;
        return [{ partyId: `party-${String(this.createdParties)}`, ...statement.values[0] }];
      }
      if (statement.table === crmImports) return [{ id: IMPORT }];
      if (statement.table === dataQualityFindings) {
        this.filedFindings += 1;
        return [{ findingId: `finding-${String(this.filedFindings)}` }];
      }
      if (statement.table === partyIdentifiers) return [];
    }

    if (statement.kind === "update" && statement.table === crmImportRows) {
      const rowId = this.rowIdIn(statement);
      if (!rowId) return [];

      const claimsRevert =
        statement.set?.revertedAt !== undefined && statement.set.error === undefined;

      /**
       * `committed_at` is written by `stamp()` at the end of a row, together
       * with the column that says what the row did — never on its own, and never
       * as the claim. The claim is the locking select above.
       */
      if (statement.set?.committedAt !== undefined) {
        this.committedRows.set(rowId, statement.savepoint);
        return [];
      }

      if (claimsRevert) {
        if (this.revertedRows.has(rowId)) return [];
        const row = this.rowById(rowId);
        if (!row?.committedAt) return [];
        this.revertedRows.set(rowId, statement.savepoint);
        return [row];
      }

      return [];
    }

    // A party update reads its row back: the legacy mirror is derived from what
    // the party became, so the write cannot end at the UPDATE any more.
    if (statement.kind === "update" && statement.table === businessParties)
      return [{ partyId: "party-1", organizationId: ORG, ...statement.set }];

    return [];
  }
}

function plannedRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    crmImportRowId: "row-1",
    rowNumber: 1,
    action: "create",
    values: { name: "Acme" },
    customFields: {},
    matchedRecordId: null,
    match: null,
    committedAt: null,
    revertedAt: null,
    ...over,
  };
}

const workflows = { start: jest.fn(() => Promise.resolve("run-1")) };
/*
  Permissive by default: these cases are about import mechanics, not quotas, and
  a limit that refuses would mask what they assert. The refusal path has its own
  coverage in `party-creation-invariant.spec.ts`.
*/
const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
const service = (fake: FakeDb) =>
  new CrmImportService(
    fake.db,
    new CrmImportPreviewService(fake.db),
    new CrmImportCommitService(
      fake.db,
      workflows as unknown as WorkflowRunnerService,
      planLimits as unknown as PlanLimitsService,
    ),
    new CrmImportRevertService(fake.db, workflows as unknown as WorkflowRunnerService),
  );

beforeAll(() => {
  // The per-row failure is logged on purpose; the test output is not the place.
  jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});

beforeEach(() => workflows.start.mockClear());

describe("commitBatch", () => {
  /**
   * The scenario the per-row savepoint was written for: one cell Postgres
   * refuses, in the middle of a window. Without the savepoint the transaction is
   * already aborted by the time the `catch` runs, so recording the error raises
   * 25P02, that throw escapes the step, and the step's own rollback takes the
   * whole batch with it.
   */
  const withOneBadCell = () =>
    new FakeDb({
      rows: [
        plannedRow({ crmImportRowId: "row-1", rowNumber: 1, values: { name: "Acme" } }),
        plannedRow({
          crmImportRowId: "row-2",
          rowNumber: 2,
          values: { name: "Globex" },
          // A NUL byte reaches jsonb through any 5,000-character cell.
          customFields: { territory: "North\u0000" },
        }),
        plannedRow({ crmImportRowId: "row-3", rowNumber: 3, values: { name: "Initech" } }),
      ],
      rejects: (statement) =>
        statement.kind === "insert" &&
        statement.table === businessParties &&
        JSON.stringify(statement.values).includes("\\u0000")
          ? pgError("22P05", 'unsupported Unicode escape sequence: "\\u0000" cannot be converted to text')
          : null,
    });

  it("imports the rest of the batch when one row is rejected", async () => {
    const fake = withOneBadCell();

    const result = await service(fake).commitBatch(ORG, IMPORT, WHOLE_FILE);

    expect(result).toMatchObject({ created: 2, failed: 1 });
    expect(fake.landed("insert", businessParties).map((s) => s.values[0]?.name)).toEqual([
      "Acme",
      "Initech",
    ]);
  });

  it("records the failure on the row that caused it", async () => {
    const fake = withOneBadCell();

    await service(fake).commitBatch(ORG, IMPORT, WHOLE_FILE);

    const errors = fake
      .landed("update", crmImportRows)
      .map((statement) => statement.set?.error)
      .filter((error): error is string => typeof error === "string");

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Unicode escape/);
    // The failure this test exists for: recording the error used to be the
    // statement that raised 25P02, because the transaction was already gone.
    expect(errors[0]).not.toMatch(/25P02|transaction is aborted/);
  });

  /**
   * A row Postgres refused will be refused again. Left outstanding it would be
   * retried by every later attempt and by every later batch step, and the import
   * would never reach its own end.
   */
  it("marks the failed row done, so it does not hold the import open", async () => {
    const fake = withOneBadCell();

    await service(fake).commitBatch(ORG, IMPORT, WHOLE_FILE);

    const failed = fake
      .landed("update", crmImportRows)
      .filter((statement) => typeof statement.set?.error === "string");

    expect(failed[0]?.set?.committedAt).toBeInstanceOf(Date);
  });

  it("leaves nothing behind from the row that failed", async () => {
    const fake = withOneBadCell();

    await service(fake).commitBatch(ORG, IMPORT, WHOLE_FILE);

    // A create and its claim share a savepoint, so a party is never left over
    // without the record of how to undo it.
    const created = fake
      .landed("update", crmImportRows)
      .filter((statement) => statement.set?.createdRecordId !== undefined);
    expect(created).toHaveLength(2);
  });

  /**
   * The constraint the whole durable design rests on: `step.run` re-runs a step
   * whose previous attempt FAILED, and two runs can overlap after a dead-letter.
   * A batch that is not idempotent turns either into a second copy of every
   * party in it.
   */
  describe("running the same batch twice", () => {
    it("writes nothing the second time", async () => {
      const fake = new FakeDb({
        rows: [
          plannedRow({ crmImportRowId: "row-1", rowNumber: 1, values: { name: "Acme" } }),
          plannedRow({ crmImportRowId: "row-2", rowNumber: 2, values: { name: "Globex" } }),
        ],
      });

      const first = await service(fake).commitBatch(ORG, IMPORT, WHOLE_FILE);
      const again = await service(fake).commitBatch(ORG, IMPORT, WHOLE_FILE);

      expect(first).toMatchObject({ created: 2 });
      expect(again).toMatchObject({ created: 0 });
      expect(fake.landed("insert", businessParties)).toHaveLength(2);
    });

    it("does not count a row somebody else claimed", async () => {
      // Two runs overlapping: the second finds the claim taken and reports it as
      // nothing rather than as a failure, because it is neither.
      const fake = new FakeDb({
        rows: [plannedRow({ crmImportRowId: "row-1", rowNumber: 1 })],
      });

      await service(fake).commitBatch(ORG, IMPORT, WHOLE_FILE);
      const again = await service(fake).commitBatch(ORG, IMPORT, WHOLE_FILE);

      expect(again).toMatchObject({ created: 0, failed: 0, skipped: 0 });
    });

    it("releases the claim of a row that failed, so it is genuinely outstanding", async () => {
      // The claim shares the row's savepoint with the write. A claim that
      // outlived a rolled-back write would mark the row done for a party that
      // was never created.
      const fake = withOneBadCell();
      await service(fake).commitBatch(ORG, IMPORT, WHOLE_FILE);

      const claims = fake
        .landed("update", crmImportRows)
        .filter((statement) => statement.set?.committedAt !== undefined);

      // Two rows claimed and written, one claim rolled back and replaced by the
      // error record — never a fourth claim standing for work nobody did.
      expect(claims.filter((statement) => statement.set?.error === undefined)).toHaveLength(2);
    });
  });

  /**
   * `party_type` is an advertised import field with synonyms, so a file with a
   * Type column previews as VENDOR. The commit used to hard-code CUSTOMER and
   * import a supplier list as customers.
   */
  it("creates the party type the file asked for", async () => {
    const fake = new FakeDb({
      rows: [plannedRow({ values: { name: "Acme Supplies", partyType: "VENDOR", status: "prospect" } })],
    });

    await service(fake).commitBatch(ORG, IMPORT, WHOLE_FILE);

    expect(fake.landed("insert", businessParties)[0]?.values[0]).toMatchObject({
      name: "Acme Supplies",
      partyType: "VENDOR",
      status: "prospect",
    });
  });

  it("leaves the column default alone when the file says nothing", async () => {
    const fake = new FakeDb({ rows: [plannedRow({ values: { name: "Acme" } })] });

    await service(fake).commitBatch(ORG, IMPORT, WHOLE_FILE);

    const inserted = fake.landed("insert", businessParties)[0]?.values[0];
    expect(inserted?.partyType).toBeUndefined();
    expect(inserted?.status).toBeUndefined();
  });

  /**
   * Ticket 22 made `party_identifiers` the thing every inbound channel resolves
   * against, and `applyPartyPatch` claims on every update — but this insert
   * writes `business_parties` directly and would otherwise be the one uncovered
   * path. An imported party nothing had claimed matches no channel at all.
   */
  it("claims the identifiers of the party it creates", async () => {
    const fake = new FakeDb({
      rows: [plannedRow({ values: { name: "Acme", email: "ops@acme.example", phone: "+441234567890" } })],
    });

    await service(fake).commitBatch(ORG, IMPORT, WHOLE_FILE);

    const claimed = fake.landed("insert", partyIdentifiers)[0]?.values ?? [];
    expect(claimed.map((row) => row.kind)).toEqual(["email", "phone"]);
  });

  /**
   * Both columns are NOT NULL with a default, so `current` is never empty and
   * the gap-filling rule would never have filled either of them.
   */
  it("fills a party type still sitting at its default", async () => {
    const fake = new FakeDb({
      rows: [
        plannedRow({
          action: "update",
          matchedRecordId: "party-9",
          values: { name: "Acme", partyType: "VENDOR", email: "ops@acme.example" },
        }),
      ],
      parties: [
        {
          partyId: "party-9",
          name: "Acme",
          partyType: "CUSTOMER",
          status: "active",
          email: "curated@acme.example",
          customFields: null,
        },
      ],
    });

    await service(fake).commitBatch(ORG, IMPORT, WHOLE_FILE);

    const patch = fake.landed("update", businessParties)[0]?.set;
    expect(patch).toMatchObject({ partyType: "VENDOR" });
    // Still only fills gaps: a curated address is not overwritten by a file.
    expect(patch?.email).toBeUndefined();
  });

  it("refuses a party type the enum does not have", async () => {
    const fake = new FakeDb({
      rows: [
        plannedRow({
          action: "update",
          matchedRecordId: "party-9",
          values: { name: "Acme", partyType: "SOMETHING_ELSE" },
        }),
      ],
      parties: [{ partyId: "party-9", name: "Acme", partyType: "CUSTOMER", customFields: null }],
    });

    await service(fake).commitBatch(ORG, IMPORT, WHOLE_FILE);

    expect(fake.landed("update", businessParties)[0]?.set?.partyType).toBeUndefined();
  });

  it("writes nothing for a row folded into an earlier row of the same file", async () => {
    // Its values went into the row it repeats while the plan was made.
    const fake = new FakeDb({
      rows: [plannedRow({ action: "merge", duplicateOfRow: 1, values: { name: "Acme" } })],
    });

    const result = await service(fake).commitBatch(ORG, IMPORT, WHOLE_FILE);

    expect(result).toMatchObject({ merged: 1, created: 0 });
    expect(fake.landed("insert", businessParties)).toHaveLength(0);
  });
});

/**
 * The criterion: rows the scorer was unsure about are not written speculatively.
 * Phase 1 created a second record and left the duplicate queue to catch it,
 * which at import scale silently doubles a customer list.
 */
describe("a row the scorer would not commit to", () => {
  const held = () =>
    new FakeDb({
      rows: [
        plannedRow({
          action: "review",
          matchedRecordId: "party-9",
          match: { score: 0.55, signals: ["phone"], candidateName: "Acme Trading Ltd" },
          values: { name: "Acme Trading", phone: "+441234567890" },
          reason: "Looks like something you already have.",
        }),
      ],
    });

  it("creates no party", async () => {
    const fake = held();
    const result = await service(fake).commitBatch(ORG, IMPORT, WHOLE_FILE);

    expect(result).toMatchObject({ review: 1, created: 0 });
    expect(fake.landed("insert", businessParties)).toHaveLength(0);
  });

  it("files it in the data-quality queue instead", async () => {
    const fake = held();
    await service(fake).commitBatch(ORG, IMPORT, WHOLE_FILE);

    const filed = fake.landed("insert", dataQualityFindings)[0]?.values[0];
    expect(filed).toMatchObject({
      organizationId: ORG,
      producer: "import-uncertainty",
      findingKind: "import-uncertainty.near-duplicate",
      partyId: "party-9",
      proposedAction: "none",
      reversibility: "instant",
    });
    expect(filed?.evidence).toMatchObject({ rowNumber: 1, sourceFilename: "zoho.csv" });
  });

  it("remembers which finding it filed, so the undo can close it", async () => {
    const fake = held();
    await service(fake).commitBatch(ORG, IMPORT, WHOLE_FILE);

    const recorded = fake
      .landed("update", crmImportRows)
      .map((statement) => statement.set?.dataQualityFindingId)
      .filter(Boolean);

    expect(recorded).toEqual(["finding-1"]);
  });

  it("fails the row rather than filing a question with nothing in it", async () => {
    const fake = new FakeDb({
      rows: [plannedRow({ action: "review", matchedRecordId: null, match: null })],
    });

    const result = await service(fake).commitBatch(ORG, IMPORT, WHOLE_FILE);

    expect(result).toMatchObject({ review: 0, failed: 1 });
    expect(fake.landed("insert", dataQualityFindings)).toHaveLength(0);
  });
});

describe("finishing and taking back", () => {
  it("stamps the window the import promised", async () => {
    const fake = new FakeDb({ importStatus: "committing" });
    const before = Date.now();

    await service(fake).finishCommit(ORG, IMPORT);

    const set = fake.landed("update", crmImports)[0]?.set;
    expect(set?.status).toBe("committed");
    const deadline = set?.revertDeadlineAt as Date;
    const days = (deadline.getTime() - before) / (24 * 60 * 60 * 1000);
    expect(Math.round(days)).toBe(REVERT_WINDOW_DAYS);
  });

  it("refuses an undo after the window has passed", async () => {
    const fake = new FakeDb({
      importStatus: "committed",
      revertDeadlineAt: new Date(Date.now() - 1000),
    });

    await expect(service(fake).startRevert(ORG, "user-1", IMPORT)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(workflows.start).not.toHaveBeenCalled();
  });

  it("starts the undo inside the window", async () => {
    const fake = new FakeDb({
      importStatus: "committed",
      revertDeadlineAt: new Date(Date.now() + 1000),
    });

    await expect(service(fake).startRevert(ORG, "user-1", IMPORT)).resolves.toBe("run-1");
  });

  it("refuses to commit an import that has already been committed", async () => {
    const fake = new FakeDb({ importStatus: "committed" });

    await expect(service(fake).startCommit(ORG, IMPORT)).rejects.toBeInstanceOf(ConflictException);
  });

  describe("revertBatch", () => {
    it("takes back what it created and puts back what it overwrote", async () => {
      const fake = new FakeDb({
        importStatus: "reverting",
        rows: [
          plannedRow({
            crmImportRowId: "row-1",
            rowNumber: 1,
            committedAt: new Date(),
            createdRecordId: "party-1",
          }),
          plannedRow({
            crmImportRowId: "row-2",
            rowNumber: 2,
            action: "update",
            matchedRecordId: "party-9",
            committedAt: new Date(),
            previous: { name: "Acme", email: "curated@acme.example" },
          }),
        ],
      });

      const result = await service(fake).revertBatch(ORG, IMPORT, WHOLE_FILE);

      expect(result).toMatchObject({ deleted: 1, restored: 1 });
      const patches = fake.landed("update", businessParties).map((statement) => statement.set);
      expect(patches.some((patch) => patch?.deletedAt instanceof Date)).toBe(true);
      expect(patches.some((patch) => patch?.email === "curated@acme.example")).toBe(true);
    });

    it("closes the question a held row asked", async () => {
      const fake = new FakeDb({
        importStatus: "reverting",
        rows: [
          plannedRow({
            action: "review",
            committedAt: new Date(),
            dataQualityFindingId: "finding-1",
          }),
        ],
      });

      const result = await service(fake).revertBatch(ORG, IMPORT, WHOLE_FILE);

      expect(result).toMatchObject({ dismissed: 1 });
      expect(fake.landed("update", dataQualityFindings)[0]?.set).toMatchObject({
        status: "dismissed",
      });
    });

    it("puts a row back exactly once", async () => {
      // The same claim the commit takes, for the same reasons: a batch step
      // re-runs after a failure, and an undo applied twice would soft-delete a
      // party the tenant re-created in between.
      const fake = new FakeDb({
        importStatus: "reverting",
        rows: [plannedRow({ committedAt: new Date(), createdRecordId: "party-1" })],
      });

      const first = await service(fake).revertBatch(ORG, IMPORT, WHOLE_FILE);
      const again = await service(fake).revertBatch(ORG, IMPORT, WHOLE_FILE);

      expect(first).toMatchObject({ deleted: 1 });
      expect(again).toMatchObject({ deleted: 0 });
    });
  });
});

describe("preview", () => {
  const preview = (fake: FakeDb, over: Record<string, unknown> = {}) =>
    service(fake).preview({
      organizationId: ORG,
      userId: "user-1",
      headers: ["Company Name", "Email"],
      rows: [["Acme", "ops@acme.example"]],
      ...over,
    });

  /**
   * `mapColumns` turns a second column claiming `name` into an ambiguous one so
   * a person decides. Answering that question used to be able to re-create the
   * collision it was asked about, and the rightmost column silently won every
   * row of the file.
   */
  it("refuses two columns answered onto one field", async () => {
    const fake = new FakeDb();

    await expect(
      preview(fake, {
        headers: ["Company", "Account Name"],
        rows: [["Acme", "Acme Trading"]],
        overrides: { Company: "name", "Account Name": "name" },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("says which columns collided and how to resolve it", async () => {
    const fake = new FakeDb();

    await expect(
      preview(fake, {
        headers: ["Company", "Account Name"],
        rows: [["Acme", "Acme Trading"]],
        overrides: { Company: "name", "Account Name": "name" },
      }),
    ).rejects.toThrow(/"Company" and "Account Name".*name.*__ignore__/s);
  });

  it("refuses an answer that is not a field this import can fill", async () => {
    const fake = new FakeDb();

    await expect(
      preview(fake, { overrides: { "Company Name": "partyId" } }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  /**
   * The candidate set used to be `LIMIT 10000` with no ORDER BY — an arbitrary
   * slice that shifts as rows are updated and vacuumed, so the same file could
   * plan a row as `update` on one day and `create` the next, quietly growing a
   * second copy of a customer.
   */
  it("asks for the parties this file could match, by identifier", async () => {
    const fake = new FakeDb();

    await preview(fake, {
      headers: ["Company Name", "Email", "GSTIN"],
      rows: [["Acme", "OPS@Acme.example", "gst-42"]],
    });

    const [lookup] = fake.statements.filter(
      (statement) => statement.kind === "select" && statement.table === businessParties,
    );
    const query = new PgDialect().sqlToQuery(lookup?.where as SQL);

    expect(query.sql).toMatch(/regexp_replace/);
    // Normalised on both sides, or the file's spelling would decide whether a
    // duplicate is found.
    expect(query.params).toEqual(expect.arrayContaining(["ops@acme.example", "GST42"]));
  });

  it("asks for nothing when the file carries no identifier to match on", async () => {
    const fake = new FakeDb();

    await preview(fake, { headers: ["Company Name"], rows: [["Acme"], ["Globex"]] });

    // No tax number, e-mail, phone or website means no party can score high
    // enough to change a row's action, so there is no candidate worth fetching.
    expect(
      fake.statements.filter(
        (statement) => statement.kind === "select" && statement.table === businessParties,
      ),
    ).toHaveLength(0);
  });

  it("stores what the scorer saw, so the commit need not re-derive it", async () => {
    const fake = new FakeDb({
      parties: [
        {
          partyId: "party-9",
          name: "Acme Trading Group",
          legalName: null,
          email: null,
          phone: "+441234567890",
          taxNumber: null,
          website: null,
        },
      ],
    });

    await preview(fake, {
      headers: ["Company Name", "Phone"],
      rows: [["Acme Trading", "+441234567890"]],
    });

    const planned = fake.landed("insert", crmImportRows)[0]?.values[0];
    expect(planned?.action).toBe("review");
    expect(planned?.match).toMatchObject({ candidateName: "Acme Trading Group" });
  });
});
