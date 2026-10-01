import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { timesheetExceptions, users, organizationMembers } from "../../../db/schema";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import { AccessService } from "../../access/access.service";
import { actingMembershipId } from "../../../common/auth/principal";
import { resolveEntriesScope, membershipTeamScope } from "./timesheets-core-scope";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import type {
  DismissExceptionInput,
  ExceptionsQuery,
  ResolveExceptionInput,
} from "./dto/exceptions.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

@Injectable()
export class TimesheetExceptionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: TimesheetsAuditService,
  ) {}

  async listExceptions(u: CurrentUserContext, query: ExceptionsQuery) {
    const read = await resolveEntriesScope(this.access, u);
    const limit = Math.min(query.limit, 100);
    const pos = decodeCursor(query.cursor);

    const membershipId = actingMembershipId(u.principal);

    let requestedMembershipId: number | undefined;
    if (query.userId && read.discriminator === "all") {
      const [qMember] = await this.db
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, u.orgId),
            eq(organizationMembers.userId, query.userId),
          ),
        )
        .limit(1);
      if (qMember) requestedMembershipId = qMember.id;
    }

    const ownerMember = alias(organizationMembers, "owner_member");

    return read.read(
      {
        tenant: timesheetExceptions.orgId,
        scope: membershipTeamScope(u.orgId, u.userId, membershipId, timesheetExceptions.userMembershipId),
        and: [
          requestedMembershipId !== undefined ? eq(timesheetExceptions.userMembershipId, requestedMembershipId) : undefined,
          query.status ? eq(timesheetExceptions.status, query.status) : undefined,
          query.severity ? eq(timesheetExceptions.severity, query.severity) : undefined,
          query.rule ? eq(timesheetExceptions.rule, query.rule) : undefined,
          pos ? keysetBeforeId(timesheetExceptions.createdAt, timesheetExceptions.id, pos) : undefined,
        ],
      },
      async ({ sql: where }) => {
        const rawRows = await this.db
          .select({
            e: timesheetExceptions,
            userName: users.name,
            userEmail: users.email,
          })
          .from(timesheetExceptions)
          .leftJoin(ownerMember, and(
            eq(timesheetExceptions.orgId, ownerMember.orgId),
            eq(timesheetExceptions.userMembershipId, ownerMember.id),
          ))
          .leftJoin(users, eq(ownerMember.userId, users.id))
          .where(where)
          .orderBy(desc(timesheetExceptions.createdAt), desc(timesheetExceptions.id))
          .limit(limit + 1);

        const page = buildCursorPage(rawRows, limit, (r) => ({
          sortValue: r.e.createdAt.toISOString(),
          id: String(r.e.id),
        }));

        return {
          data: page.data.map((r) => ({
            ...r.e,
            user: { membershipId: r.e.userMembershipId, name: r.userName, email: r.userEmail },
          })),
          pagination: page.pagination,
        };
      },
      () => ({ data: [], pagination: { limit, hasMore: false, nextCursor: null } }),
    );
  }

  private async transition(
    u: CurrentUserContext,
    exceptionId: number,
    reason: string,
    toStatus: "RESOLVED" | "DISMISSED",
    action: "exception.resolved" | "exception.dismissed",
  ) {
    const [existing] = await this.db
      .select()
      .from(timesheetExceptions)
      .where(
        and(
          eq(timesheetExceptions.id, exceptionId),
          eq(timesheetExceptions.orgId, u.orgId),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundException("Exception not found");

    const verb = toStatus === "RESOLVED" ? "resolved" : "dismissed";
    if (existing.status !== "OPEN") {
      throw new ConflictException(`Only open exceptions can be ${verb}`);
    }

    const resolvedByMembershipId = actingMembershipId(u.principal);

    const [updated] = await this.db
      .update(timesheetExceptions)
      .set({
        status: toStatus,
        resolutionReason: reason,
        resolvedByMembershipId,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(timesheetExceptions.id, exceptionId),
          eq(timesheetExceptions.orgId, u.orgId),
          eq(timesheetExceptions.status, "OPEN"),
        ),
      )
      .returning();
    if (!updated) {
      throw new ConflictException(`Only open exceptions can be ${verb}`);
    }

    await this.audit.recordWithDb({
      orgId: u.orgId,
      actorMembershipId: resolvedByMembershipId,
      entityType: "exception",
      entityId: exceptionId.toString(),
      action,
      reason,
      before: { status: existing.status },
      after: { status: toStatus },
    });

    return updated;
  }

  resolveException(u: CurrentUserContext, exceptionId: number, input: ResolveExceptionInput) {
    return this.transition(u, exceptionId, input.reason, "RESOLVED", "exception.resolved");
  }

  dismissException(u: CurrentUserContext, exceptionId: number, input: DismissExceptionInput) {
    return this.transition(u, exceptionId, input.reason, "DISMISSED", "exception.dismissed");
  }

  async summary(u: CurrentUserContext) {
    const read = await resolveEntriesScope(this.access, u);
    const membershipId = actingMembershipId(u.principal);
    const rows = await read.read(
      {
        tenant: timesheetExceptions.orgId,
        scope: membershipTeamScope(u.orgId, u.userId, membershipId, timesheetExceptions.userMembershipId),
        and: [],
      },
      ({ sql: where }) =>
        this.db
          .select({
            status: timesheetExceptions.status,
            severity: timesheetExceptions.severity,
            count: sql<number>`COUNT(*)::int`,
          })
          .from(timesheetExceptions)
          .where(where)
          .groupBy(timesheetExceptions.status, timesheetExceptions.severity),
      () => [],
    );

    const byStatus: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    const openBySeverity: Record<string, number> = {};
    let total = 0;

    for (const row of rows) {
      total += row.count;
      byStatus[row.status] = (byStatus[row.status] ?? 0) + row.count;
      bySeverity[row.severity] = (bySeverity[row.severity] ?? 0) + row.count;
      if (row.status === "OPEN") {
        openBySeverity[row.severity] = (openBySeverity[row.severity] ?? 0) + row.count;
      }
    }

    return { total, byStatus, bySeverity, openBySeverity };
  }
}
