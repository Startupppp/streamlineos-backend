import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import { crmSegments, users } from "../../../db/schema";
import { getPostgresErrorCode } from "../../../common/db/postgres-error";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { AccessService } from "../../access/access.service";
import { compileQuery, type CompiledQuery } from "../../reporting/compiler/compile";
import { QueryCompilationError } from "../../reporting/compiler/errors";
import type {
  FilterNode,
  QueryDescription,
} from "../../reporting/compiler/query-description";
import type { RequesterScope } from "../../reporting/compiler/scope";
import { toDrizzleSql } from "../../reporting/compiler/to-drizzle-sql";
import {
  SEGMENT_VIEW,
  UnsegmentableSourceError,
  buildCountQuery,
  buildMemberQuery,
  decideSegmentSourceAccess,
  describeSegmentSources,
} from "./segment-query";
import type {
  CreateSegmentInput,
  ListSegmentsQuery,
  PreviewSegmentInput,
  UpdateSegmentInput,
} from "./dto/crm-segments.schemas";

/**
 * Saving segment criteria, and evaluating them.
 *
 * The service does what the compiler deliberately does not: it decides who may
 * evaluate what, it stores criteria, and it executes. Everything about *what SQL
 * to produce* stays in `modules/reporting/compiler`, which is why this file
 * reads as plumbing — that is the whole benefit of not having written a second
 * engine.
 *
 * Three orderings here are load-bearing.
 *
 * **Permission before compilation.** The source's key is checked before
 * `compileQuery` runs, so a caller who may not read parties learns that rather
 * than learning which fields exist on parties by probing the compiler's error
 * messages. Those messages name the caller's own strings back at them, which is
 * right for somebody debugging their own segment and wrong as a reply to
 * somebody enumerating a schema they have no access to.
 *
 * **Compilation before execution, always.** There is no path that executes
 * anything but the output of `compileQuery`, which is what makes the safety
 * argument a property of the module rather than of each method.
 *
 * **Evaluation on read, never on write.** Nothing here stores a member, a count
 * or a `last_evaluated_at`. Every number this service returns was produced by a
 * statement issued during the request that returned it, so there is no state to
 * go stale and no sweep whose failure would be invisible.
 */

/** One evaluation of a segment: a bounded sample, and the exact size. */
export interface SegmentEvaluation {
  readonly columns: CompiledQuery["columns"];
  readonly rows: readonly Record<string, unknown>[];
  /**
   * Every matching row, not the length of `rows`.
   *
   * Counted by its own compiled statement over the same filter, because a sample
   * capped at a hundred would report a hundred for a segment of forty thousand,
   * and a size that saturates is worse than no size.
   */
  readonly total: number;
  /** The sample stops here; `total` is the real answer. */
  readonly truncated: boolean;
}

@Injectable()
export class CrmSegmentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  // ── What may be segmented ─────────────────────────────────────────────────

  async describeSources(orgId: string, userId: string) {
    return describeSegmentSources(await this.heldPermissions(orgId, userId));
  }

  // ── Saved segments ────────────────────────────────────────────────────────

  async listSegments(orgId: string, query: ListSegmentsQuery) {
    return this.db
      .select({
        segmentId: crmSegments.segmentId,
        name: crmSegments.name,
        description: crmSegments.description,
        sourceKey: crmSegments.sourceKey,
        createdByUserId: crmSegments.createdByUserId,
        /**
         * The author as a name, not only as an id.
         *
         * A single projected column off a LEFT JOIN, because `users` is the
         * global identity table and still carries authentication secrets — an
         * unprojected relation to it is banned for exactly that reason. LEFT
         * because the column is nullable and because an author who has since
         * left the organisation must not remove their segment from the list.
         */
        createdByName: users.name,
        createdAt: crmSegments.createdAt,
        updatedAt: crmSegments.updatedAt,
      })
      .from(crmSegments)
      .leftJoin(users, eq(crmSegments.createdByUserId, users.id))
      .where(eq(crmSegments.organizationId, orgId))
      .orderBy(desc(crmSegments.updatedAt))
      .limit(query.limit)
      .offset(query.offset);
  }

  /**
   * One segment, re-asserting the tenant on the row rather than leaning on RLS.
   *
   * A miss is 404 whether the row belongs to another organisation or does not
   * exist, because a 403 on somebody else's id confirms the record exists and
   * turns a probe into an existence oracle.
   */
  async getSegment(orgId: string, segmentId: string) {
    const [row] = await this.db
      .select()
      .from(crmSegments)
      .where(
        and(eq(crmSegments.organizationId, orgId), eq(crmSegments.segmentId, segmentId)),
      )
      .limit(1);

    if (!row) throw new NotFoundException("segment not found");
    return row;
  }

  /**
   * Saving compiles first, and discards the result.
   *
   * Criteria that cannot compile must not be storable. Otherwise the failure
   * surfaces the first time somebody opens the segment — possibly in front of
   * the campaign it was built for — and the person who could have fixed it is
   * long gone from the screen. The compilation is thrown away because what is
   * stored is the criteria; this is a validation, not a cache.
   */
  async createSegment(orgId: string, userId: string, input: CreateSegmentInput) {
    await this.assertMayEvaluate(orgId, userId, input.source);
    this.compileOrThrow(
      this.memberQuery(input.source, input.criteria),
      orgId,
      await this.requesterScope(orgId, userId),
    );

    const [row] = await this.insertSegment(orgId, userId, input);
    return row;
  }

  async updateSegment(
    orgId: string,
    userId: string,
    segmentId: string,
    input: UpdateSegmentInput,
  ) {
    const existing = await this.getSegment(orgId, segmentId);

    /**
     * The source is not editable, and this is not an oversight.
     *
     * Every criterion names a field of one source, so changing the source under
     * a stored tree leaves criteria that reference fields the new source does
     * not have — an edit that succeeds and produces a segment nobody can
     * evaluate. Re-pointing a segment at different data is building a different
     * segment; the product says so by making it a create.
     */
    if (input.criteria) {
      await this.assertMayEvaluate(orgId, userId, existing.sourceKey);
      this.compileOrThrow(
        this.memberQuery(existing.sourceKey, input.criteria),
        orgId,
        await this.requesterScope(orgId, userId),
      );
    }

    const [row] = await this.runOrConflict(
      () =>
        this.db
          .update(crmSegments)
          .set({
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.description === undefined ? {} : { description: input.description }),
            ...(input.criteria === undefined ? {} : { criteria: input.criteria }),
          })
          .where(
            and(
              eq(crmSegments.organizationId, orgId),
              eq(crmSegments.segmentId, segmentId),
            ),
          )
          .returning(),
      input.name,
    );

    return row;
  }

  /**
   * Hard delete, where most business entities here soft-delete.
   *
   * A segment is a saved question with no downstream rows, no retention duty and
   * no audit meaning of its own — the reporting module's saved definitions are
   * hard-deleted for the same reason. And a soft-deleted segment would keep its
   * name occupying `uniq_crm_segments_org_name`, so the person who deleted
   * "Lapsed enterprise" in order to rebuild it under the same name would be told
   * the name is taken by something they can no longer see.
   */
  async deleteSegment(orgId: string, segmentId: string) {
    const deleted = await this.db
      .delete(crmSegments)
      .where(
        and(eq(crmSegments.organizationId, orgId), eq(crmSegments.segmentId, segmentId)),
      )
      .returning({ segmentId: crmSegments.segmentId });

    if (deleted.length === 0) throw new NotFoundException("segment not found");
    return { deleted: true };
  }

  // ── Evaluating ────────────────────────────────────────────────────────────

  /**
   * Who is in this segment, right now.
   *
   * Recompiled and re-executed on every call. There is no cached membership to
   * serve and no freshness question to answer, which is the property the whole
   * design exists to buy.
   */
  async members(
    orgId: string,
    userId: string,
    segmentId: string,
    limit: number,
  ): Promise<SegmentEvaluation> {
    const segment = await this.getSegment(orgId, segmentId);
    await this.assertMayEvaluate(orgId, userId, segment.sourceKey);

    return this.evaluate(orgId, await this.requesterScope(orgId, userId), {
      sourceKey: segment.sourceKey,
      criteria: segment.criteria,
      limit,
    });
  }

  /**
   * How big would this be, for criteria nobody has saved.
   *
   * A count and nothing else. Returning rows here would make this an ad-hoc
   * query endpoint with no saved artefact and no audit row, which is
   * `POST /crm/reporting/run` — and duplicating that is how a second query
   * engine arrives, one convenience at a time.
   */
  async preview(
    orgId: string,
    userId: string,
    input: PreviewSegmentInput,
  ): Promise<{ total: number }> {
    await this.assertMayEvaluate(orgId, userId, input.source);
    const requester = await this.requesterScope(orgId, userId);
    const total = await this.count(orgId, requester, input.source, input.criteria);
    return { total };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async evaluate(
    orgId: string,
    requester: RequesterScope,
    segment: { sourceKey: string; criteria: FilterNode; limit: number },
  ): Promise<SegmentEvaluation> {
    const compiled = this.compileOrThrow(
      this.memberQuery(segment.sourceKey, segment.criteria, segment.limit),
      orgId,
      requester,
    );

    const rows = await this.runCompiled(orgId, compiled);
    const total = await this.count(orgId, requester, segment.sourceKey, segment.criteria);

    return { columns: compiled.columns, rows, total, truncated: total > rows.length };
  }

  private async count(
    orgId: string,
    requester: RequesterScope,
    sourceKey: string,
    criteria: FilterNode,
  ): Promise<number> {
    const compiled = this.compileOrThrow(
      this.countQueryOrThrow(sourceKey, criteria),
      orgId,
      requester,
    );
    const [row] = await this.runCompiled(orgId, compiled);
    const alias = compiled.columns[0]?.alias;
    if (!row || alias === undefined) return 0;
    /**
     * `COUNT` returns `bigint`, which `postgres-js` hands back as a string so no
     * value is silently lost past 2^53. `Number` is applied at the use site
     * rather than by casting the row, which is what the raw-row rule asks for.
     */
    return Number(row[alias] ?? 0);
  }

  /**
   * Rows from a compiled statement, inside the tenant transaction.
   *
   * The GUC the RLS policy reads is set by `runInTenantTransaction`, so this is
   * not belt-and-braces on top of the compiled organisation predicate: the
   * predicate is what makes the statement correct, and the policy is what makes
   * it correct even if the predicate were ever wrong.
   */
  private async runCompiled(
    orgId: string,
    compiled: CompiledQuery,
  ): Promise<Record<string, unknown>[]> {
    return runInTenantTransaction(
      this.db,
      async (tx) => toRows(await tx.execute(toDrizzleSql(compiled))),
      { orgId },
    );
  }

  private memberQuery(sourceKey: string, criteria: FilterNode, limit = 1): QueryDescription {
    return describeOrThrow(() => buildMemberQuery(sourceKey, criteria, limit));
  }

  private countQueryOrThrow(sourceKey: string, criteria: FilterNode): QueryDescription {
    return describeOrThrow(() => buildCountQuery(sourceKey, criteria));
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
         * A refusal is the caller's fault, so it is a 400 carrying the code and
         * path. The code is what a client uses to point at the offending
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

  /**
   * The two-key rule, restated at every entry point that touches rows.
   *
   * `crm:segments:view` admits the surface. The key the registry declares on the
   * source admits the data. Without the second, a segment would be the way to
   * count and list the customers whose own screen refuses you.
   */
  private async assertMayEvaluate(
    orgId: string,
    userId: string,
    sourceKey: string,
  ): Promise<void> {
    const decision = decideSegmentSourceAccess(
      sourceKey,
      await this.heldPermissions(orgId, userId),
    );
    if (decision.allowed) return;

    if (decision.missing)
      throw new ForbiddenException(`this segment requires ${decision.missing}`);
    /**
     * No missing key means the source cannot be segmented. Answered as a 400
     * rather than a 403: there is no permission that would grant it, so calling
     * it forbidden would send the caller to an administrator who cannot help.
     */
    throw new BadRequestException(`no segmentable source named ${JSON.stringify(sourceKey)}`);
  }

  private async heldPermissions(orgId: string, userId: string): Promise<ReadonlySet<string>> {
    return new Set((await this.access.resolveUserPermissions(orgId, userId)).keys());
  }

  /**
   * The scope the compiler narrows by, resolved from the key that admits the
   * read.
   *
   * The same shape `ReportingService.requesterScope` uses, and for the same
   * reason: scope is per key, and the key that admits an operation is the one
   * whose scope governs it. Taking a minimum across everything the user holds
   * would let an unrelated narrow grant silently restrict segments, which is a
   * different rule nobody stated.
   *
   * Absent means `none`, not `all`. A user whose grant has gone while their
   * session lives sees an empty segment rather than every row in it, which is
   * the direction a scope resolution has to fail in.
   *
   * `crm:segments:view` is not `scopable` in the catalogue today, so every
   * seeded role resolves `all` here and this is inert. It is resolved anyway so
   * that making the key scopable — or an administrator building a narrowed
   * custom grant — narrows the segment rather than being ignored by it.
   */
  private async requesterScope(orgId: string, userId: string): Promise<RequesterScope> {
    const resolved = await this.access.resolveUserPermissions(orgId, userId);
    return { userId, scope: resolved.get(SEGMENT_VIEW) ?? "none" };
  }

  private async insertSegment(orgId: string, userId: string, input: CreateSegmentInput) {
    return this.runOrConflict(
      () =>
        this.db
          .insert(crmSegments)
          .values({
            organizationId: orgId,
            name: input.name,
            description: input.description ?? null,
            sourceKey: input.source,
            criteria: input.criteria,
            createdByUserId: userId,
          })
          .returning(),
      input.name,
    );
  }

  /**
   * A duplicate name is a 409, never an unhandled 500.
   *
   * The SQLSTATE is read through `getPostgresErrorDetails`, which walks the
   * cause chain — Drizzle wraps driver errors in `DrizzleQueryError`, so
   * `error.code === "23505"` on the thrown object is always false and a check
   * written that way silently never fires.
   */
  private async runOrConflict<T>(run: () => Promise<T>, name: string | undefined): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (getPostgresErrorCode(error) === "23505")
        throw new ConflictException(
          name === undefined
            ? "a segment with that name already exists"
            : `a segment named ${JSON.stringify(name)} already exists`,
        );
      throw error;
    }
  }
}

/**
 * An unsegmentable source is a 400, raised where the description is built.
 *
 * `segment-query.ts` throws a plain named error rather than a Nest exception so
 * it stays a pure module its specs can call without a container; this is the one
 * place that translation happens.
 */
function describeOrThrow<T>(build: () => T): T {
  try {
    return build();
  } catch (error) {
    if (error instanceof UnsegmentableSourceError)
      throw new BadRequestException(error.message);
    throw error;
  }
}

/**
 * Raw driver rows, narrowed rather than cast.
 *
 * `tx.execute` is typed loosely enough that the honest options are a cast or a
 * check, and a cast here would be a claim about a value that came from outside
 * the type system. This checks.
 */
function toRows(result: unknown): Record<string, unknown>[] {
  if (!Array.isArray(result)) return [];
  return result.filter(
    (row): row is Record<string, unknown> => typeof row === "object" && row !== null,
  );
}
