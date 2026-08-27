import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { crmReportDefinitions, crmReportRuns } from "../../db/schema";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { AccessService } from "../access/access.service";
import { compileQuery, type CompiledQuery } from "./compiler/compile";
import type { RequesterScope } from "./compiler/scope";
import { QueryCompilationError } from "./compiler/errors";
import { REPORTING_REGISTRY } from "./compiler/registry";
import { toDrizzleSql } from "./compiler/to-drizzle-sql";
import { decideSourceAccess, REPORTING_RUN, type HeldPermissions } from "./reporting-source-access";
import type { QueryDescription } from "./compiler/query-description";
import type {
  CreateDefinitionInput,
  ListQuery,
  RunDefinitionInput,
  UpdateDefinitionInput,
} from "./dto/reporting.schemas";

/**
 * Saving, compiling and running report descriptions.
 *
 * The service does four things the compiler deliberately does not: it decides
 * *who* may run a query, it stores descriptions, it executes, and it records
 * what was executed. Everything about *what SQL to produce* stays in the pure
 * compiler, so the dangerous logic remains testable without a database and this
 * file stays reviewable as plumbing.
 *
 * Two orderings here are load-bearing and neither is obvious from the call site.
 *
 * **Permission before compilation.** The source's key is checked before
 * `compileQuery` runs, so a caller who may not read parties learns that, rather
 * than learning which fields exist on parties by probing the compiler's error
 * messages. The compiler's refusals name the caller's own strings back at them,
 * which is right for a person debugging their own report and wrong as a reply to
 * somebody enumerating a schema they have no access to.
 *
 * **Compilation before execution, always.** There is no path that executes
 * anything but the output of `compileQuery`. That is what makes the safety
 * argument a property of the module rather than of each method.
 */

/** What a run returns: rows, plus what the columns mean. */
export interface ReportResult {
  readonly columns: CompiledQuery["columns"];
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number;
  /** True when the page came back full, so the caller knows to ask for more. */
  readonly truncated: boolean;
}

@Injectable()
export class ReportingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  // ── What may be asked ─────────────────────────────────────────────────────

  /**
   * The queryable surface, filtered to what this caller may actually run.
   *
   * Filtered rather than annotated. A response listing every source with
   * `canRead: false` beside the ones you are denied is a schema disclosure with
   * a flag on it — it tells a caller that a `parties` source exists, what its
   * fields are called, and therefore what the tenant stores.
   */
  async describeSources(orgId: string, userId: string) {
    const held = await this.heldPermissions(orgId, userId);

    return [...REPORTING_REGISTRY.entries()]
      .filter(([key]) => decideSourceAccess(key, held).allowed)
      .map(([key, source]) => ({
        key,
        label: source.label,
        fields: Object.entries(source.fields).map(([name, field]) => ({
          name,
          label: field.label,
          type: field.type,
        })),
        relations: Object.entries(source.joins ?? {}).map(([name, join]) => ({
          name,
          fields: Object.entries(join.fields).map(([fieldName, field]) => ({
            name: `${name}.${fieldName}`,
            label: field.label,
            type: field.type,
          })),
        })),
      }));
  }

  // ── Saved definitions ─────────────────────────────────────────────────────

  async listDefinitions(orgId: string, query: ListQuery) {
    return this.db
      .select({
        reportDefinitionId: crmReportDefinitions.reportDefinitionId,
        name: crmReportDefinitions.name,
        description: crmReportDefinitions.description,
        sourceKey: crmReportDefinitions.sourceKey,
        createdByUserId: crmReportDefinitions.createdByUserId,
        createdAt: crmReportDefinitions.createdAt,
        updatedAt: crmReportDefinitions.updatedAt,
      })
      .from(crmReportDefinitions)
      .where(eq(crmReportDefinitions.organizationId, orgId))
      .orderBy(desc(crmReportDefinitions.updatedAt))
      .limit(query.limit)
      .offset(query.offset);
  }

  async getDefinition(orgId: string, reportDefinitionId: string) {
    const [row] = await this.db
      .select()
      .from(crmReportDefinitions)
      .where(
        and(
          eq(crmReportDefinitions.organizationId, orgId),
          eq(crmReportDefinitions.reportDefinitionId, reportDefinitionId),
        ),
      )
      .limit(1);

    if (!row) throw new NotFoundException("report definition not found");
    return row;
  }

  /**
   * Saving compiles first, and discards the result.
   *
   * A description that cannot compile must not be storable. Otherwise the
   * failure surfaces the first time somebody runs the report — possibly on a
   * schedule, at night, to an audience — and the person who could have fixed it
   * is long gone from the screen. The compilation is thrown away because what is
   * stored is the description; this is a validation, not a cache.
   */
  async createDefinition(
    orgId: string,
    userId: string,
    input: CreateDefinitionInput,
  ) {
    const query = input.query as QueryDescription;
    await this.assertMayRunSource(orgId, userId, query.source);
    this.compileOrThrow(query, orgId, await this.requesterScope(orgId, userId));

    const [row] = await this.db
      .insert(crmReportDefinitions)
      .values({
        organizationId: orgId,
        name: input.name,
        description: input.description ?? null,
        sourceKey: query.source,
        queryDescription: query,
        createdByUserId: userId,
      })
      .returning();

    return row;
  }

  async updateDefinition(
    orgId: string,
    userId: string,
    reportDefinitionId: string,
    input: UpdateDefinitionInput,
  ) {
    const existing = await this.getDefinition(orgId, reportDefinitionId);

    const query = (input.query ?? existing.queryDescription) as QueryDescription;
    if (input.query) {
      await this.assertMayRunSource(orgId, userId, query.source);
      this.compileOrThrow(query, orgId, await this.requesterScope(orgId, userId));
    }

    const [row] = await this.db
      .update(crmReportDefinitions)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.query === undefined
          ? {}
          : { queryDescription: query, sourceKey: query.source }),
      })
      .where(
        and(
          eq(crmReportDefinitions.organizationId, orgId),
          eq(crmReportDefinitions.reportDefinitionId, reportDefinitionId),
        ),
      )
      .returning();

    return row;
  }

  async deleteDefinition(orgId: string, reportDefinitionId: string) {
    const deleted = await this.db
      .delete(crmReportDefinitions)
      .where(
        and(
          eq(crmReportDefinitions.organizationId, orgId),
          eq(crmReportDefinitions.reportDefinitionId, reportDefinitionId),
        ),
      )
      .returning({ reportDefinitionId: crmReportDefinitions.reportDefinitionId });

    if (deleted.length === 0) throw new NotFoundException("report definition not found");
    return { deleted: true };
  }

  // ── Compiling, and running ────────────────────────────────────────────────

  /**
   * What this description would execute, without executing it.
   *
   * The statement is safe to hand back for the same reason it is safe to store:
   * it contains no literals. This is the endpoint that makes the module's claim
   * checkable by the people who have to trust it — a tenant's security reviewer
   * can send their worst description and read exactly what the database would
   * have been asked, with their own values conspicuously absent from it.
   *
   * It is behind the manage key rather than the view key because the compiled
   * statement names physical tables and columns, which is more than a report
   * reader needs to know.
   */
  async explain(orgId: string, userId: string, query: QueryDescription) {
    await this.assertMayRunSource(orgId, userId, query.source);
    const compiled = this.compileOrThrow(query, orgId, await this.requesterScope(orgId, userId));

    return {
      source: compiled.source,
      sql: compiled.text,
      /**
       * The count, never the values. The statement is content-free; the
       * parameters are the content, and echoing them into a response body that
       * may be logged or pasted into a ticket would put tenant data where the
       * design took care to keep it out.
       */
      parameterCount: compiled.params.length,
      columns: compiled.columns,
    };
  }

  async runAdHoc(orgId: string, userId: string, query: QueryDescription) {
    return this.run(orgId, userId, query, null);
  }

  async runDefinition(
    orgId: string,
    userId: string,
    reportDefinitionId: string,
    overrides: RunDefinitionInput,
  ) {
    const definition = await this.getDefinition(orgId, reportDefinitionId);

    /**
     * The overrides are merged into the stored description and the result goes
     * through the compiler like anything else — they are not applied to the
     * compiled statement. Patching `LIMIT` into finished SQL is how a query
     * surface acquires its first string concatenation.
     */
    const query: QueryDescription = {
      ...(definition.queryDescription as QueryDescription),
      ...(overrides.limit === undefined ? {} : { limit: overrides.limit }),
      ...(overrides.offset === undefined ? {} : { offset: overrides.offset }),
    };

    return this.run(orgId, userId, query, reportDefinitionId);
  }

  async listRuns(orgId: string, query: ListQuery) {
    return this.db
      .select({
        reportRunId: crmReportRuns.reportRunId,
        reportDefinitionId: crmReportRuns.reportDefinitionId,
        sourceKey: crmReportRuns.sourceKey,
        compiledSql: crmReportRuns.compiledSql,
        parameterCount: crmReportRuns.parameterCount,
        rowCount: crmReportRuns.rowCount,
        durationMs: crmReportRuns.durationMs,
        ranByUserId: crmReportRuns.ranByUserId,
        createdAt: crmReportRuns.createdAt,
      })
      .from(crmReportRuns)
      .where(eq(crmReportRuns.organizationId, orgId))
      .orderBy(desc(crmReportRuns.createdAt))
      .limit(query.limit)
      .offset(query.offset);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async run(
    orgId: string,
    userId: string,
    query: QueryDescription,
    reportDefinitionId: string | null,
  ): Promise<ReportResult> {
    await this.assertMayRunSource(orgId, userId, query.source);
    const compiled = this.compileOrThrow(query, orgId, await this.requesterScope(orgId, userId));

    const startedAt = Date.now();
    const rows = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const result = await tx.execute(toDrizzleSql(compiled));
        return [...(result as unknown as Record<string, unknown>[])];
      },
      { orgId },
    );
    const durationMs = Date.now() - startedAt;

    await this.recordRun(orgId, userId, compiled, reportDefinitionId, rows.length, durationMs);

    return {
      columns: compiled.columns,
      rows,
      rowCount: rows.length,
      /**
       * A full page means there may be more. Said explicitly because the caller
       * cannot tell otherwise, and a report silently showing the first page of a
       * larger answer is the failure the refused-not-clamped limit exists to
       * prevent — it would come straight back if the caller had to guess.
       */
      truncated: rows.length >= query.limit,
    };
  }

  /**
   * The audit row, written after the run rather than before it.
   *
   * After, because the row carries the duration and the row count, and a
   * two-phase write (insert, run, update) would double the cost of every report
   * to record something no reader needs sooner. The trade is that a query killed
   * by a statement timeout leaves no row — acceptable, because that failure is
   * already visible in the error the caller receives and in the database's own
   * logs, and this table exists to answer "what was asked", not "what crashed".
   */
  private async recordRun(
    orgId: string,
    userId: string,
    compiled: CompiledQuery,
    reportDefinitionId: string | null,
    rowCount: number,
    durationMs: number,
  ): Promise<void> {
    await this.db.insert(crmReportRuns).values({
      organizationId: orgId,
      reportDefinitionId,
      sourceKey: compiled.source,
      compiledSql: compiled.text,
      parameterCount: compiled.params.length,
      rowCount,
      durationMs,
      ranByUserId: userId,
    });
  }

  private compileOrThrow(
    query: QueryDescription,
    orgId: string,
    requester: RequesterScope,
  ): CompiledQuery {
    try {
      return compileQuery(query, { organizationId: orgId, requester });
    } catch (error) {
      if (error instanceof QueryCompilationError)
        /**
         * A refusal is the caller's fault, so it is a 400 and it carries the
         * code and path. The code is what a client uses to point at the offending
         * control; a bare message would make every refusal a string to match on.
         */
        throw new BadRequestException({
          message: error.message,
          code: error.code,
          path: error.path,
        });
      throw error;
    }
  }

  private async assertMayRunSource(
    orgId: string,
    userId: string,
    sourceKey: string,
  ): Promise<void> {
    const held = await this.heldPermissions(orgId, userId);
    const decision = decideSourceAccess(sourceKey, held);
    if (decision.allowed) return;

    if (decision.missing)
      throw new ForbiddenException(`this report requires ${decision.missing}`);
    /**
     * No missing key means the source is not in the registry. Answered as a 400
     * rather than a 403: there is no permission that would grant it, so calling
     * it forbidden would send the caller to an administrator who cannot help.
     */
    throw new BadRequestException(`no queryable source named ${JSON.stringify(sourceKey)}`);
  }

  private async heldPermissions(orgId: string, userId: string): Promise<HeldPermissions> {
    const resolved = await this.access.resolveUserPermissions(orgId, userId);
    return new Set(resolved.keys());
  }

  /**
   * The scope the compiler applies, resolved from the grant that admits the run.
   *
   * This closes `REPORTING_SCOPE_GAP`. Ticket 10 kept the keys and dropped the
   * scope, and recorded that a narrowed grant was being treated as a full one.
   * Ticket 11 is the ticket that stops that being true, and the shape of the fix
   * is the whole point: the scope is resolved HERE and handed to the compiler,
   * which applies it on the way out. A description cannot opt out of a predicate
   * it never supplies.
   *
   * `REPORTING_RUN` is the grant consulted, not the narrowest of everything the
   * user holds. Scope is per key, and the key that admits this operation is the
   * one whose scope governs it — taking a minimum across unrelated keys would
   * let an unrelated narrow grant silently restrict reporting, which is a
   * different rule nobody stated.
   *
   * Absent means `none`, not `all`. A user whose grant has gone while their
   * session lives sees nothing rather than everything, which is the direction a
   * scope resolution has to fail in.
   */
  private async requesterScope(orgId: string, userId: string): Promise<RequesterScope> {
    const resolved = await this.access.resolveUserPermissions(orgId, userId);
    return { userId, scope: resolved.get(REPORTING_RUN) ?? "none" };
  }
}
