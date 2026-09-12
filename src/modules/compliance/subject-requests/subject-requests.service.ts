/**
 * The executor: a subject request, actually carried out.
 *
 * Phase 3, tickets 17 and 18. `subject-request.ts` had been pure and callerless
 * — the mechanism for visiting every region existed and nothing ever visited
 * one. This is the thin impure shell around it: enumerate the configured
 * regions, do the per-region work over the personal-data registry, and file the
 * result in `subject_requests`.
 *
 * Three decisions are worth arguing before reading the code.
 *
 * THE ENUMERATION IS THE REGISTRY, NOT THE `scope` FIELD. Every table is
 * located by matching an address against its own columns, never by the
 * registry's `scope`. That field is a scan artefact and it is wrong in places:
 * `users` is listed `org_id` and the table has no `org_id` column at all
 * (`db/schema/common/auth.ts:109`). A locator built on it would silently miss
 * every table it mislabels.
 *
 * THE PLAN IS INTERSECTED WITH `information_schema`. The registry lists
 * `verification_tokens.email`; that table has three columns and none of them is
 * `email` — it keys on `identifier`. A predicate built from the registry alone
 * raises 42703 and fails a whole region over one stale line. Asking the
 * database which of the planned columns actually exist, per region, also
 * handles the case a multi-region deployment always has: regions are migrated
 * one at a time, so a table present in one is not yet present in the next.
 *
 * THE FILED RECORD HOLDS COUNTS, NEVER THE EXPORTED ROWS. An export payload is
 * returned to the caller and is not written to `subject_requests` — that table
 * is on `GLOBAL_PERSONAL_DATA_TABLES` and is retained forever by design, so
 * storing the export there would answer "erase my data" by copying all of it
 * into the one table nothing may erase.
 */

import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { desc, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { subjectRequests } from "../../../db/schema";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env.validation";
import { getRegionRegistry } from "../../../common/region/region-registry";
import {
  failureSummary,
  runAcrossRegions,
  type RegionWork,
  type SubjectRequestKind,
  type SubjectRequestResult,
} from "./subject-request";
import {
  mayFileAsComplete,
  SUBJECT_REQUEST_PLAN,
  undeclaredTablesHoldingData,
  type TableOutcome,
} from "./subject-request-plan";
import {
  isDeclaredOperator,
  parseOperators,
  SUBJECT_REQUEST_OPERATORS_ENV,
} from "./subject-request-operators";

/**
 * How many rows one table may contribute to one region's export.
 *
 * A cap exists because `select *` over an unbounded table is how an export
 * request becomes an outage. Exceeding it is not silent: the table is marked
 * `truncated`, and `mayFileAsComplete` refuses to call a truncated export
 * complete, because a capped table is data we hold and did not hand over.
 */
export const EXPORT_ROW_CAP = 5_000;

export interface SubjectRequestInput {
  readonly kind: SubjectRequestKind;
  readonly subjectEmail: string;
  /** The statutory window this is tracked against. */
  readonly dueBy?: Date | null;
  readonly backupsExpireBy?: string | null;
}

export interface SubjectRequestExecution {
  readonly subjectRequestId: string;
  readonly result: SubjectRequestResult;
  /** The decision, not the fact. See `mayFileAsComplete`. */
  readonly mayReportComplete: boolean;
  readonly failureSummary: string | null;
  /** Per-region table breakdown, in region order. */
  readonly tables: Readonly<Record<string, readonly TableOutcome[]>>;
  /** Tables holding the subject that nobody has decided the disposition of. */
  readonly undeclared: readonly string[];
  /** Tables the subject cannot be located in by address. */
  readonly notIdentifiable: readonly string[];
  /** Export only. Never written to `subject_requests`. */
  readonly data?: Readonly<Record<string, Record<string, unknown[]>>>;
}

export interface FiledSubjectRequest {
  readonly subjectRequestId: string;
  readonly kind: string;
  readonly subjectEmail: string;
  readonly isComplete: boolean;
  readonly totalRecordsAffected: number;
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly dueBy: string | null;
}

interface RegionRun {
  readonly tables: TableOutcome[];
  readonly rows: Record<string, unknown[]>;
}

@Injectable()
export class SubjectRequestsService {
  /**
   * `DRIZZLE` is the primary region's connection and is used only to file the
   * record. The per-region work goes through the region registry instead —
   * writing the evidence into whichever region happened to be visited last
   * would scatter one request's record across the deployment.
   */
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Refuses unless the caller is a declared operator.
   *
   * Called before any work, not after: a cross-tenant read of somebody's
   * personal data is already the harm, so an export must be refused on the same
   * line an erasure is.
   */
  private assertOperator(userId: string): void {
    const operators = parseOperators(this.config.COMPLIANCE_SUBJECT_REQUEST_OPERATORS);
    if (isDeclaredOperator(userId, operators)) return;

    throw new ForbiddenException(
      `Subject requests may only be run by a declared operator. Set ${SUBJECT_REQUEST_OPERATORS_ENV} ` +
        "to the user ids permitted to run them; unset authorises nobody.",
    );
  }

  async execute(userId: string, input: SubjectRequestInput): Promise<SubjectRequestExecution> {
    this.assertOperator(userId);

    const subjectEmail = input.subjectEmail.trim().toLowerCase();
    const registry = getRegionRegistry();
    /*
      `registry.keys`, not a literal and not the tenant's own region. Passing
      anything else to `mayReportComplete` defeats the single failure that
      function exists to catch -- a region was added and the enumeration was
      not updated -- and would report the request complete while the subject's
      data sat in the region nobody looked at.
    */
    const configuredRegions = registry.keys;

    /*
      `RegionWork.run` returns one number by contract, and `RegionOutcome` has no
      per-table channel. Widening either would change a file whose spec pins the
      current shape in fifteen tests, so the table breakdown is collected
      alongside and re-joined to its region below.
    */
    const runs = new Map<string, RegionRun>();

    const work: RegionWork[] = configuredRegions.map((region) => ({
      region,
      run: async () => {
        const binding = registry.bindingFor(region);
        const run = await this.runInRegion(binding.db, input.kind, subjectEmail);
        runs.set(region, run);

        return input.kind === "erasure"
          ? run.tables.reduce((total, outcome) => total + outcome.rowsErased, 0)
          : run.tables.reduce((total, outcome) => total + outcome.rowsMatched, 0);
      },
    }));

    const result = await runAcrossRegions(
      input.kind,
      subjectEmail,
      work,
      () => new Date(),
      input.backupsExpireBy ?? null,
    );

    const tables: Record<string, readonly TableOutcome[]> = {};
    const flattened: TableOutcome[] = [];
    for (const outcome of result.regions) {
      const run = runs.get(outcome.region);
      // A failed region leaves no run behind. An empty list is the honest
      // record of that: no table in it was looked at, not "no table held data".
      tables[outcome.region] = run?.tables ?? [];
      if (run) flattened.push(...run.tables);
    }

    const mayComplete = mayFileAsComplete(input.kind, result, configuredRegions, flattened);

    const subjectRequestId = await this.file(result, mayComplete, tables, input.dueBy ?? null);

    const notIdentifiable = [
      ...new Set(
        flattened.filter((o) => o.status === "not-identifiable").map((o) => o.table),
      ),
    ].sort();

    const execution: SubjectRequestExecution = {
      subjectRequestId,
      result,
      mayReportComplete: mayComplete,
      failureSummary: failureSummary(result),
      tables,
      undeclared: undeclaredTablesHoldingData(flattened),
      notIdentifiable,
    };

    if (input.kind !== "export") return execution;

    const data: Record<string, Record<string, unknown[]>> = {};
    for (const [region, run] of runs) data[region] = run.rows;
    return { ...execution, data };
  }

  /**
   * One region's pass over the enumeration.
   *
   * Every planned table produces an outcome, including the ones that could not
   * be looked inside. A filtered list would make "we cannot find you in
   * `login_history`" indistinguishable from "you are not in `login_history`".
   */
  private async runInRegion(
    db: Db,
    kind: SubjectRequestKind,
    subjectEmail: string,
  ): Promise<RegionRun> {
    const present = await this.textColumnsPresent(db);
    const tables: TableOutcome[] = [];
    const rows: Record<string, unknown[]> = {};

    for (const plan of SUBJECT_REQUEST_PLAN) {
      const columns = present.get(plan.table);

      if (!columns) {
        tables.push({
          table: plan.table,
          disposition: plan.disposition,
          status: "absent",
          rowsMatched: 0,
          rowsErased: 0,
        });
        continue;
      }

      const usable = plan.emailColumns.filter((column) => columns.has(column));
      if (usable.length === 0) {
        tables.push({
          table: plan.table,
          disposition: plan.disposition,
          status: "not-identifiable",
          rowsMatched: 0,
          rowsErased: 0,
        });
        continue;
      }

      const where = sql.join(
        usable.map((column) => sql`lower(${sql.identifier(column)}) = ${subjectEmail}`),
        sql` or `,
      );
      const relation = sql`${sql.identifier("public")}.${sql.identifier(plan.table)}`;

      if (kind === "erasure" && plan.disposition === "erase") {
        /*
          `returning 1` rather than trusting the driver's affected-row count:
          the number that goes into the regulator's record is the number of rows
          the database says it removed, counted here.
        */
        const deleted = (await db.execute(
          sql`delete from ${relation} where ${where} returning 1 as "erased"`,
        )) as unknown as unknown[];

        tables.push({
          table: plan.table,
          disposition: plan.disposition,
          status: "scanned",
          rowsMatched: deleted.length,
          rowsErased: deleted.length,
        });
        continue;
      }

      if (kind === "export") {
        const found = (await db.execute(
          sql`select * from ${relation} where ${where} limit ${EXPORT_ROW_CAP + 1}`,
        )) as unknown as unknown[];

        const truncated = found.length > EXPORT_ROW_CAP;
        const carried = truncated ? found.slice(0, EXPORT_ROW_CAP) : found;
        if (carried.length > 0) rows[plan.table] = carried;

        tables.push({
          table: plan.table,
          disposition: plan.disposition,
          status: "scanned",
          rowsMatched: carried.length,
          rowsErased: 0,
          ...(truncated ? { truncated: true } : {}),
        });
        continue;
      }

      /*
        Erasure, `retain` or `undeclared`. Counted and not touched. This is the
        branch the whole design turns on: an undeclared table that holds the
        subject is reported with a real number and left alone, so the record
        says how much was left behind rather than omitting it.
      */
      const counted = (await db.execute(
        sql`select count(*)::int as "matched" from ${relation} where ${where}`,
      )) as unknown as Array<{ matched: number }>;

      tables.push({
        table: plan.table,
        disposition: plan.disposition,
        status: "scanned",
        rowsMatched: Number(counted[0]?.matched ?? 0),
        rowsErased: 0,
      });
    }

    return { tables, rows };
  }

  /**
   * Which planned columns this region actually has, and are text.
   *
   * The type filter is not cosmetic. The registry lists `email_enabled` and
   * `email_verified` on dozens of tables — a boolean and a timestamp — and
   * `lower(email_enabled) = 'a@b.test'` raises 42883 and takes the whole region
   * down with it. `subject-request-plan.ts` excludes them by name; this
   * excludes anything else that is not comparable to an address.
   */
  private async textColumnsPresent(db: Db): Promise<Map<string, Set<string>>> {
    const names = sql.join(
      SUBJECT_REQUEST_PLAN.map((plan) => sql`${plan.table}`),
      sql`, `,
    );

    const found = (await db.execute(sql`
      select table_name as "table", column_name as "column"
      from information_schema.columns
      where table_schema = 'public'
        and data_type in ('text', 'character varying', 'character', 'citext')
        and table_name in (${names})
    `)) as unknown as Array<{ table: string; column: string }>;

    const present = new Map<string, Set<string>>();
    for (const row of found) {
      const columns = present.get(row.table) ?? new Set<string>();
      columns.add(row.column);
      present.set(row.table, columns);
    }
    return present;
  }

  /**
   * Files the evidence.
   *
   * `is_complete` is TEXT in both the Drizzle schema and the applied DDL, with
   * no CHECK constraint behind it — assigning a boolean is a type error and
   * letting it stringify would put an unconstrained third value one typo away.
   * The encoding is stated here, once: `"true"` or `"false"`, nothing else.
   *
   * The table breakdown rides inside `region_outcomes`, nested under the region
   * that produced it. The column's docblock asks for the outcomes "stored
   * verbatim rather than summarised" and the table detail is the part a
   * regulator asks about — which tables were erased, and which nobody has
   * decided about.
   */
  private async file(
    result: SubjectRequestResult,
    mayComplete: boolean,
    tables: Readonly<Record<string, readonly TableOutcome[]>>,
    dueBy: Date | null,
  ): Promise<string> {
    const [filed] = await this.db
      .insert(subjectRequests)
      .values({
        kind: result.kind,
        subjectEmail: result.subjectEmail,
        regionOutcomes: result.regions.map((outcome) => ({
          ...outcome,
          tables: [...(tables[outcome.region] ?? [])],
        })),
        isComplete: mayComplete ? "true" : "false",
        totalRecordsAffected: result.totalRecordsAffected,
        backupsExpireBy: result.backupsExpireBy,
        dueBy,
        completedAt: mayComplete ? new Date() : null,
      })
      .returning({ subjectRequestId: subjectRequests.subjectRequestId });

    if (!filed)
      throw new Error(
        "[compliance] subject request completed but the record was not filed. " +
          "A request that leaves no evidence was not exercised.",
      );

    return filed.subjectRequestId;
  }

  /**
   * The filed record, for the person who has to answer for it.
   *
   * No org predicate, deliberately, and for the reason the schema gives: a data
   * subject may exist in several organisations and has one right across all of
   * them, so filing or reading the record under one tenant would hide the rest.
   */
  async list(subjectEmail?: string): Promise<FiledSubjectRequest[]> {
    const rows = await this.db
      .select({
        subjectRequestId: subjectRequests.subjectRequestId,
        kind: subjectRequests.kind,
        subjectEmail: subjectRequests.subjectEmail,
        isComplete: subjectRequests.isComplete,
        totalRecordsAffected: subjectRequests.totalRecordsAffected,
        requestedAt: subjectRequests.requestedAt,
        completedAt: subjectRequests.completedAt,
        dueBy: subjectRequests.dueBy,
      })
      .from(subjectRequests)
      .where(
        subjectEmail
          ? eq(subjectRequests.subjectEmail, subjectEmail.trim().toLowerCase())
          : undefined,
      )
      .orderBy(desc(subjectRequests.requestedAt))
      .limit(200);

    return rows.map((row) => ({
      subjectRequestId: row.subjectRequestId,
      kind: row.kind,
      subjectEmail: row.subjectEmail,
      // Decoded where it was encoded. Anything that is not the literal "true"
      // is not complete -- a record whose flag nobody can read is not evidence.
      isComplete: row.isComplete === "true",
      totalRecordsAffected: row.totalRecordsAffected,
      requestedAt: row.requestedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      dueBy: row.dueBy?.toISOString() ?? null,
    }));
  }
}
