import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { crmReportDefinitions, crmReportRuns, users } from "../../db/schema";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { QueryDescription } from "./compiler/query-description";
import type {
  CreateDefinitionInput,
  ListQuery,
  UpdateDefinitionInput,
} from "./dto/reporting.schemas";
import { ReportingAuthService } from "./reporting-auth.service";

@Injectable()
export class ReportingDefinitionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly auth: ReportingAuthService,
  ) {}

  async listDefinitions(orgId: string, query: ListQuery) {
    return this.db
      .select({
        reportDefinitionId: crmReportDefinitions.reportDefinitionId,
        name: crmReportDefinitions.name,
        description: crmReportDefinitions.description,
        sourceKey: crmReportDefinitions.sourceKey,
        createdByUserId: crmReportDefinitions.createdByUserId,
        /**
         * The author as a name, not only as an id.
         *
         * A single projected column off a LEFT JOIN, because `users` is the
         * global identity table and still carries authentication secrets — an
         * unprojected relation to it is banned for exactly that reason. The
         * join is LEFT because the column is nullable and because an author who
         * has since left the organisation must not remove their report from the
         * list.
         */
        createdByName: users.name,
        createdAt: crmReportDefinitions.createdAt,
        updatedAt: crmReportDefinitions.updatedAt,
      })
      .from(crmReportDefinitions)
      .leftJoin(users, eq(crmReportDefinitions.createdByUserId, users.id))
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
  async createDefinition(user: CurrentUserContext, input: CreateDefinitionInput) {
    const query = input.query as QueryDescription;
    await this.auth.assertMayRunSource(user, query.source);
    this.auth.compileOrThrow(query, user.orgId, await this.auth.requesterScope(user));

    const [row] = await this.db
      .insert(crmReportDefinitions)
      .values({
        organizationId: user.orgId,
        name: input.name,
        description: input.description ?? null,
        sourceKey: query.source,
        queryDescription: query,
        createdByUserId: user.userId,
      })
      .returning();

    return row;
  }

  async updateDefinition(
    user: CurrentUserContext,
    reportDefinitionId: string,
    input: UpdateDefinitionInput,
  ) {
    const existing = await this.getDefinition(user.orgId, reportDefinitionId);

    const query = (input.query ?? existing.queryDescription) as QueryDescription;
    if (input.query) {
      await this.auth.assertMayRunSource(user, query.source);
      this.auth.compileOrThrow(query, user.orgId, await this.auth.requesterScope(user));
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
          eq(crmReportDefinitions.organizationId, user.orgId),
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
        /**
         * Who ran it, as a name.
         *
         * Without this the audit read is a list of opaque identifiers, which is
         * a log rather than an audit trail — nobody reviewing it can answer the
         * question it exists to answer without a second lookup they have no
         * screen for. Same LEFT JOIN and same single projected column as the
         * definition list above, for the same reason.
         */
        ranByName: users.name,
        createdAt: crmReportRuns.createdAt,
      })
      .from(crmReportRuns)
      .leftJoin(users, eq(crmReportRuns.ranByUserId, users.id))
      .where(eq(crmReportRuns.organizationId, orgId))
      .orderBy(desc(crmReportRuns.createdAt))
      .limit(query.limit)
      .offset(query.offset);
  }
}
