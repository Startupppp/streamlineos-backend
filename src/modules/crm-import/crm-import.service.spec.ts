import { ConflictException, Logger } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../db/drizzle.types";
import { businessParties, crmImportRows, crmImports } from "../../db/schema";
import { CrmImportService } from "./crm-import.service";

const ORG = "org-1";
const IMPORT = "import-1";

interface Statement {
  kind: "select" | "insert" | "update";
  table: unknown;
  values: Record<string, unknown>[];
  set: Record<string, unknown> | null;
  where: SQL | undefined;
  /** The savepoint it ran in. 0 is the request's own transaction. */
  savepoint: number;
  rolledBack: boolean;
}

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

interface FakeOptions {
  importStatus?: string;
  rows?: Record<string, unknown>[];
  parties?: Record<string, unknown>[];
  /** The statement Postgres refuses. */
  rejects?: (statement: Statement) => Error | null;
}

/**
 * A database that fails the way Postgres fails.
 *
 * The defect these tests are for is not "an insert threw" — it is what the NEXT
 * statement does after one did. Postgres aborts the whole transaction on a
 * statement error, so every later statement in it raises 25P02 until something
 * rolls back; a savepoint is what gives a caller a smaller thing to roll back
 * to. A fake where the error-recording UPDATE simply succeeds cannot see the
 * bug at all, which is why this one models both halves.
 *
 * Each handle carries the savepoint it writes through, so a service that reached
 * for the ambient `this.db` inside a savepoint — leaving writes behind that a
 * rollback was supposed to take with it — shows up as a statement that survives.
 */
class FakeDb {
  readonly statements: Statement[] = [];
  private readonly aborted = new Set<number>();
  private nextSavepoint = 1;
  private createdParties = 0;

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
      set: (payload: Record<string, unknown>) => {
        statement.set = payload;
        return self;
      },
      values: (payload: Record<string, unknown> | Record<string, unknown>[]) => {
        statement.values = Array.isArray(payload) ? payload : [payload];
        return self;
      },
      returning: () => self,
      orderBy: () => self,
      limit: () => self,
      for: () => self,
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

  private respond(statement: Statement): unknown {
    if (statement.kind === "select") {
      if (statement.table === crmImports)
        return [{ status: this.options.importStatus ?? "previewing" }];
      if (statement.table === crmImportRows) return this.options.rows ?? [];
      if (statement.table === businessParties) return this.options.parties ?? [];
    }

    if (statement.kind === "insert") {
      if (statement.table === businessParties) {
        this.createdParties += 1;
        return [{ partyId: `party-${this.createdParties}` }];
      }
      if (statement.table === crmImports) return [{ id: IMPORT }];
    }

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
    matchedPartyId: null,
    committedAt: null,
    ...over,
  };
}

beforeAll(() => {
  // The per-row failure is logged on purpose; the test output is not the place.
  jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});

describe("commit", () => {
  /**
   * The scenario the per-row `catch` was written for and could not survive: one
   * cell Postgres refuses, in the middle of a file, inside the request's own
   * transaction. Before the savepoint, the transaction was already aborted by
   * the time the `catch` ran, so recording the error raised 25P02, that throw
   * escaped `commit`, every row rolled back and the import stayed `previewing`.
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

  it("imports the rest of the file when one row is rejected", async () => {
    const fake = withOneBadCell();

    const result = await new CrmImportService(fake.db).commit(ORG, IMPORT);

    expect(result).toMatchObject({ created: 2, failed: 1, complete: true });
    expect(fake.landed("insert", businessParties).map((s) => s.values[0]?.name)).toEqual([
      "Acme",
      "Initech",
    ]);
  });

  it("records the failure on the row that caused it", async () => {
    const fake = withOneBadCell();

    await new CrmImportService(fake.db).commit(ORG, IMPORT);

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

  it("leaves nothing behind from the row that failed", async () => {
    const fake = withOneBadCell();

    await new CrmImportService(fake.db).commit(ORG, IMPORT);

    // A create and its `committed_at` share a savepoint, so a party is never
    // left over without the record of how to undo it.
    const done = fake
      .landed("update", crmImportRows)
      .filter((statement) => statement.set?.committedAt !== undefined);
    expect(done).toHaveLength(2);
  });

  it("marks the import committed once it has been through the file", async () => {
    const fake = withOneBadCell();

    await new CrmImportService(fake.db).commit(ORG, IMPORT);

    expect(
      fake.landed("update", crmImports).map((statement) => statement.set?.status),
    ).toEqual(["committing", "committed"]);
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

    await new CrmImportService(fake.db).commit(ORG, IMPORT);

    expect(fake.landed("insert", businessParties)[0]?.values[0]).toMatchObject({
      name: "Acme Supplies",
      partyType: "VENDOR",
      status: "prospect",
    });
  });

  it("leaves the column default alone when the file says nothing", async () => {
    const fake = new FakeDb({ rows: [plannedRow({ values: { name: "Acme" } })] });

    await new CrmImportService(fake.db).commit(ORG, IMPORT);

    const inserted = fake.landed("insert", businessParties)[0]?.values[0];
    expect(inserted?.partyType).toBeUndefined();
    expect(inserted?.status).toBeUndefined();
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
          matchedPartyId: "party-9",
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

    await new CrmImportService(fake.db).commit(ORG, IMPORT);

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
          matchedPartyId: "party-9",
          values: { name: "Acme", partyType: "SOMETHING_ELSE" },
        }),
      ],
      parties: [{ partyId: "party-9", name: "Acme", partyType: "CUSTOMER", customFields: null }],
    });

    await new CrmImportService(fake.db).commit(ORG, IMPORT);

    expect(fake.landed("update", businessParties)[0]?.set?.partyType).toBeUndefined();
  });

  describe("when a request runs out of time", () => {
    /**
     * The commit runs inline in one HTTP request. Reporting what is left is
     * what lets the caller finish the file in another call instead of retrying
     * into the same wall — see the note in `crm-import.workflow`.
     */
    it("reports the rows it did not reach and leaves the import open", async () => {
      const fake = new FakeDb({
        rows: [
          plannedRow({ crmImportRowId: "row-1", rowNumber: 1 }),
          plannedRow({ crmImportRowId: "row-2", rowNumber: 2 }),
          plannedRow({ crmImportRowId: "row-3", rowNumber: 3 }),
        ],
      });

      // Fifteen seconds pass on every reading of the clock, so the budget
      // survives the first row and not the second. A deadline that had expired
      // before any work would be a deadlock rather than a deadline.
      const start = Date.now();
      let readings = 0;
      const clock = jest.spyOn(Date, "now").mockImplementation(() => {
        readings += 1;
        return start + (readings - 1) * 15_000;
      });

      try {
        const result = await new CrmImportService(fake.db).commit(ORG, IMPORT);
        expect(result).toMatchObject({ created: 1, remaining: 2, complete: false });
      } finally {
        clock.mockRestore();
      }

      expect(
        fake.landed("update", crmImports).map((statement) => statement.set?.status),
      ).toEqual(["committing"]);
    });

    it("carries on from where it stopped", async () => {
      // Only the outstanding rows come back, and `committing` is resumable
      // rather than a wall.
      const fake = new FakeDb({
        importStatus: "committing",
        rows: [plannedRow({ crmImportRowId: "row-3", rowNumber: 3 })],
      });

      const result = await new CrmImportService(fake.db).commit(ORG, IMPORT);

      expect(result).toMatchObject({ created: 1, remaining: 0, complete: true });
    });
  });

  it("refuses an import that has already been committed", async () => {
    const fake = new FakeDb({ importStatus: "committed" });

    await expect(new CrmImportService(fake.db).commit(ORG, IMPORT)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe("preview", () => {
  const preview = (fake: FakeDb, over: Record<string, unknown> = {}) =>
    new CrmImportService(fake.db).preview({
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
});
