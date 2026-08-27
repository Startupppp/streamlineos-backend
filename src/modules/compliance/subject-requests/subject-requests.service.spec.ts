import { ForbiddenException } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  clearRegionRegistry,
  RegionRegistry,
  setRegionRegistry,
  type RegionBinding,
} from "../../../common/region/region-registry";
import type { Db } from "../../../db/drizzle.types";
import type { RegionDefinition, RegionTopology } from "../../../common/region/region.config";
import { SubjectRequestsService } from "./subject-requests.service";
import type { AppConfig } from "../../../config/env.validation";
import type { TableOutcome } from "./subject-request-plan";

/**
 * The executor, against a database that answers but does not exist.
 *
 * Rendering each statement through Drizzle's own dialect rather than mocking a
 * query builder is deliberate: the claim worth asserting is "no DELETE was ever
 * issued against a table nobody decided about", and that claim is about SQL
 * text. A mock that counts calls cannot tell a DELETE from a SELECT, which is
 * precisely the distinction this service exists to get right.
 *
 * The region layer is a real `RegionRegistry` over fake bindings, for the reason
 * `subject-request.ts` gives about its own tests: the property that matters is
 * that every configured region was visited, and a single-region double reports
 * that as held for the wrong reason. Today's deployment configures one region;
 * these run two.
 */

const dialect = new PgDialect();

interface Canned {
  /** Text columns `information_schema` will admit to, per table. */
  readonly columns: Readonly<Record<string, readonly string[]>>;
  /** Rows matching the subject, per table. */
  readonly rows: Readonly<Record<string, readonly unknown[]>>;
}

class FakeRegionDb {
  readonly statements: string[] = [];

  constructor(
    private readonly canned: Canned,
    private readonly failWith?: Error,
  ) {}

  async execute(query: SQL): Promise<unknown> {
    if (this.failWith) throw this.failWith;

    const { sql: text } = dialect.sqlToQuery(query);
    this.statements.push(text);

    if (text.includes("information_schema.columns"))
      return Object.entries(this.canned.columns).flatMap(([table, columns]) =>
        columns.map((column) => ({ table, column })),
      );

    const table = /"public"\."([a-z0-9_]+)"/.exec(text)?.[1] ?? "";
    const rows = this.canned.rows[table] ?? [];

    if (text.startsWith("delete from")) return [...rows];
    if (text.startsWith("select count(")) return [{ matched: rows.length }];
    return [...rows];
  }

  deletes(): string[] {
    return this.statements.filter((statement) => statement.startsWith("delete from"));
  }
}

interface FiledRow {
  kind: string;
  subjectEmail: string;
  regionOutcomes: unknown;
  isComplete: string;
  totalRecordsAffected: number;
  completedAt: Date | null;
  dueBy: Date | null;
}

class FakeRecordDb {
  readonly filed: FiledRow[] = [];

  insert(): { values: (row: FiledRow) => { returning: () => Promise<unknown[]> } } {
    return {
      values: (row: FiledRow) => {
        this.filed.push(row);
        return { returning: async () => [{ subjectRequestId: "sr_test_1" }] };
      },
    };
  }
}

function definition(key: string): RegionDefinition {
  return { key, databaseUrl: `postgres://${key}/unused`, storage: { region: key } };
}

function registryOver(dbs: Record<string, FakeRegionDb>): RegionRegistry {
  const keys = Object.keys(dbs);
  const topology: RegionTopology = {
    primary: keys[0]!,
    regions: Object.fromEntries(keys.map((key) => [key, definition(key)])),
  };
  const bindings = new Map<string, RegionBinding>(
    keys.map((key) => [
      key,
      { definition: definition(key), db: dbs[key] as unknown as Db } satisfies RegionBinding,
    ]),
  );

  return new RegionRegistry(topology, bindings, async () => keys[0]!);
}

/**
 * A registry that holds the subject in three tables with three different
 * answers: one declared `erase`, one declared `retain`, one undeclared.
 */
const HELD_EVERYWHERE: Canned = {
  columns: {
    platform_waitlist: ["email"],
    candidates: ["email", "first_name"],
    invoices: ["customer_gstin"],
    subject_requests: ["subject_email"],
    login_history: ["ip_address"],
  },
  rows: {
    platform_waitlist: [{ email: "subject@example.test" }],
    candidates: [{ email: "subject@example.test" }, { email: "subject@example.test" }],
    subject_requests: [{ subject_email: "subject@example.test" }],
  },
};

const OPERATOR = "user_operator_1";

/** Only the one field this service reads; the rest of AppConfig is irrelevant here. */
/** A deployment that has named no operators at all — see `serviceOver`. */
const NOBODY = Symbol("no operators declared");

function configDeclaring(operators: string | undefined): AppConfig {
  return { COMPLIANCE_SUBJECT_REQUEST_OPERATORS: operators } as unknown as AppConfig;
}

describe("SubjectRequestsService", () => {
  afterEach(() => {
    clearRegionRegistry();
  });

  /**
   * `NOBODY` rather than `undefined`, and this cost a red test to learn.
   *
   * A default parameter fires on an explicit `undefined` as readily as on an
   * absent argument, so `serviceOver({ india }, undefined)` handed the service
   * `OPERATOR` and the fail-closed test asserted against a deployment that had,
   * in fact, declared somebody. It reported the gate as broken while the gate
   * was correct — the more dangerous direction is the same bug hiding a gate
   * that really was open, which is why the case gets a value of its own rather
   * than a comment telling the next person not to pass `undefined`.
   */
  function serviceOver(
    dbs: Record<string, FakeRegionDb>,
    operators: string | typeof NOBODY = OPERATOR,
  ): {
    service: SubjectRequestsService;
    record: FakeRecordDb;
  } {
    setRegionRegistry(registryOver(dbs));
    const record = new FakeRecordDb();
    return {
      service: new SubjectRequestsService(
        record as unknown as Db,
        configDeclaring(operators === NOBODY ? undefined : operators),
      ),
      record,
    };
  }

  const outcomeFor = (
    tables: Readonly<Record<string, readonly TableOutcome[]>>,
    region: string,
    table: string,
  ): TableOutcome | undefined => tables[region]?.find((entry) => entry.table === table);

  describe("erasure", () => {
    it("deletes only where a disposition was declared, and counts the rest", async () => {
      const india = new FakeRegionDb(HELD_EVERYWHERE);
      const { service } = serviceOver({ india });

      const execution = await service.execute(OPERATOR, {
        kind: "erasure",
        subjectEmail: "Subject@Example.test",
      });

      // Exactly one DELETE, and it is the one table with a declared `erase`.
      // This is the assertion the whole design turns on: `candidates` holds two
      // of the subject's rows and is not touched, because nobody has decided
      // what happens to it, and inventing that decision is what the registry
      // refuses to do.
      expect(india.deletes()).toEqual([
        'delete from "public"."platform_waitlist" where lower("email") = $1 returning 1 as "erased"',
      ]);

      expect(outcomeFor(execution.tables, "india", "candidates")).toEqual({
        table: "candidates",
        disposition: "undeclared",
        status: "scanned",
        rowsMatched: 2,
        rowsErased: 0,
      });
    });

    it("never deletes the record a regulator reads", async () => {
      const india = new FakeRegionDb(HELD_EVERYWHERE);
      const { service } = serviceOver({ india });

      const result = await service.execute(OPERATOR, {
        kind: "erasure",
        subjectEmail: "subject@example.test",
      });

      // `subject_requests` holds the subject's address globally and forever, on
      // purpose -- it is the evidence the erasure happened. It is found, counted
      // and left alone, so the DELETE that would destroy the record of the run
      // doing the deleting is never issued.
      expect(india.deletes().join(" ")).not.toContain("subject_requests");
      expect(outcomeFor(result.tables, "india", "subject_requests")).toEqual({
        table: "subject_requests",
        disposition: "retain",
        status: "scanned",
        rowsMatched: 1,
        rowsErased: 0,
      });
    });

    it("refuses to report complete while an undeclared table holds the subject", async () => {
      const india = new FakeRegionDb(HELD_EVERYWHERE);
      const { service, record } = serviceOver({ india });

      const result = await service.execute(OPERATOR, {
        kind: "erasure",
        subjectEmail: "subject@example.test",
      });

      // One region, visited, succeeded -- `complete` is true as a fact about the
      // run. It is still not something we may tell the subject, because two of
      // their rows are in `candidates` and nobody has decided about them.
      expect(result.result.complete).toBe(true);
      expect(result.mayReportComplete).toBe(false);
      expect(result.undeclared).toEqual(["candidates"]);

      // And the record says so, in the column somebody will read.
      expect(record.filed[0]?.isComplete).toBe("false");
      expect(record.filed[0]?.completedAt).toBeNull();
    });

    it("files the undeclared tables into the record rather than summarising them away", async () => {
      const india = new FakeRegionDb(HELD_EVERYWHERE);
      const { service, record } = serviceOver({ india });

      await service.execute(OPERATOR, { kind: "erasure", subjectEmail: "subject@example.test" });

      const outcomes = record.filed[0]?.regionOutcomes as Array<{
        region: string;
        tables: TableOutcome[];
      }>;
      const candidates = outcomes[0]?.tables.find((entry) => entry.table === "candidates");

      // The gap has to be legible in the row, not only in the HTTP response the
      // operator saw once. A record that says "complete: false" without saying
      // WHERE the data still is answers none of the questions it will be asked.
      expect(candidates).toEqual({
        table: "candidates",
        disposition: "undeclared",
        status: "scanned",
        rowsMatched: 2,
        rowsErased: 0,
      });
    });

    it("distinguishes a table it could not search from one holding nothing", async () => {
      const india = new FakeRegionDb(HELD_EVERYWHERE);
      const { service } = serviceOver({ india });

      const result = await service.execute(OPERATOR, {
        kind: "erasure",
        subjectEmail: "subject@example.test",
      });

      // `login_history` has an IP address and a user agent and no address column,
      // so the subject cannot be located in it at all. Reporting that as
      // "0 rows" would be a claim nobody checked.
      expect(outcomeFor(result.tables, "india", "login_history")?.status).toBe("not-identifiable");
      expect(result.notIdentifiable).toContain("login_history");

      // `invoices` is declared `retain`, and separately cannot be searched --
      // its registry columns are all GSTINs. Both facts survive.
      expect(outcomeFor(result.tables, "india", "invoices")).toEqual({
        table: "invoices",
        disposition: "retain",
        status: "not-identifiable",
        rowsMatched: 0,
        rowsErased: 0,
      });

      // A table this region does not have is `absent`, which is not the same
      // as either of the above.
      expect(outcomeFor(result.tables, "india", "crm_people")?.status).toBe("absent");
    });
  });

  describe("export", () => {
    it("hands over the rows and keeps them out of the record", async () => {
      const canned: Canned = {
        columns: { candidates: ["email"] },
        rows: { candidates: [{ email: "subject@example.test", notes: "PAYLOAD-SENTINEL" }] },
      };
      const india = new FakeRegionDb(canned);
      const { service, record } = serviceOver({ india });

      const result = await service.execute(OPERATOR, {
        kind: "export",
        subjectEmail: "subject@example.test",
      });

      expect(result.data?.["india"]?.["candidates"]).toEqual([
        { email: "subject@example.test", notes: "PAYLOAD-SENTINEL" },
      ]);

      // `subject_requests` is on GLOBAL_PERSONAL_DATA_TABLES and is retained
      // forever. Writing the export into it would answer a subject request by
      // copying the subject's data into the one table nothing may erase.
      expect(JSON.stringify(record.filed[0])).not.toContain("PAYLOAD-SENTINEL");
      expect(india.deletes()).toEqual([]);
    });

    it("may report complete over tables an erasure could not", async () => {
      const india = new FakeRegionDb(HELD_EVERYWHERE);
      const { service, record } = serviceOver({ india });

      const result = await service.execute(OPERATOR, {
        kind: "export",
        subjectEmail: "subject@example.test",
      });

      // Ticket 18's asymmetry, asserted: "give the subject what you hold" needs
      // no per-table legal decision, so the same `candidates` rows that block an
      // erasure are simply rows that were handed over.
      expect(result.mayReportComplete).toBe(true);
      expect(record.filed[0]?.isComplete).toBe("true");
      // 1 waitlist + 2 candidates + 1 subject_requests row.
      expect(result.result.totalRecordsAffected).toBe(4);
    });
  });

  describe("across regions", () => {
    it("visits every configured region and reports each separately", async () => {
      const india = new FakeRegionDb(HELD_EVERYWHERE);
      const eu = new FakeRegionDb({
        columns: { platform_waitlist: ["email"] },
        rows: { platform_waitlist: [{ email: "subject@example.test" }] },
      });
      const { service } = serviceOver({ india, eu });

      const result = await service.execute(OPERATOR, {
        kind: "erasure",
        subjectEmail: "subject@example.test",
      });

      expect(result.result.regions.map((outcome) => outcome.region)).toEqual(["india", "eu"]);
      expect(india.deletes()).toHaveLength(1);
      expect(eu.deletes()).toHaveLength(1);
      // One waitlist row erased in each. A single-region run would report 1 and
      // leave the EU copy of the subject's data where it was.
      expect(result.result.totalRecordsAffected).toBe(2);
    });

    it("lets a failing region fail without stopping or silently joining the others", async () => {
      const india = new FakeRegionDb(HELD_EVERYWHERE);
      const eu = new FakeRegionDb(HELD_EVERYWHERE, new Error("connection refused"));
      const { service, record } = serviceOver({ india, eu });

      const result = await service.execute(OPERATOR, {
        kind: "erasure",
        subjectEmail: "subject@example.test",
      });

      expect(india.deletes()).toHaveLength(1);
      expect(result.failureSummary).toBe("eu: connection refused");
      expect(result.mayReportComplete).toBe(false);
      expect(record.filed[0]?.isComplete).toBe("false");

      // The failed region contributes an EMPTY table list, not the previous
      // region's. Copying india's outcomes onto eu would put "erased, 1 row" in
      // the record for a region that was never reached.
      expect(result.tables["eu"]).toEqual([]);
    });
  });

  describe("the operator gate", () => {
    it("refuses a caller the deployment has not declared, before touching a region", async () => {
      const india = new FakeRegionDb(HELD_EVERYWHERE);
      const { service, record } = serviceOver({ india });

      await expect(
        service.execute("user_some_tenant_owner", {
          kind: "erasure",
          subjectEmail: "subject@example.test",
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // Nothing was read and nothing was filed. Every organisation owner on the
      // platform holds the permission key (access.service.ts:655 returns scope
      // "all" for isOrgOwner before any grant is consulted), so this is the gate
      // that actually stands between them and a cross-tenant erasure.
      expect(india.statements).toEqual([]);
      expect(record.filed).toEqual([]);
    });

    it("refuses everybody when the deployment named nobody", async () => {
      const india = new FakeRegionDb(HELD_EVERYWHERE);
      const { service } = serviceOver({ india }, NOBODY);

      // Fails closed. An unconfigured deployment authorising everyone is the
      // failure mode; refusing until somebody states who may run these is the
      // correct answer for a destructive cross-tenant operation.
      await expect(
        service.execute(OPERATOR, { kind: "export", subjectEmail: "subject@example.test" }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(india.statements).toEqual([]);
    });
  });
});
