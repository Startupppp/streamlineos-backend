import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { timesheetExceptions, users } from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import { applyScope } from "../../access/apply-scope";
import { resolveEntriesScope } from "./timesheets-core-scope";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import type {
  DismissExceptionInput,
  ExceptionsQuery,
  ResolveExceptionInput,
} from "./dto/exceptions.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

@Injectable()
export class ExceptionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: TimesheetsAuditService,
  ) {}

  async listExceptions(u: CurrentUserContext, query: ExceptionsQuery) {
    const scope = await resolveEntriesScope(this.access, u);
    const limit = Math.min(query.limit, 100);
    const offset = (query.page - 1) * limit;

    const conditions = [
      eq(timesheetExceptions.orgId, u.orgId),
      applyScope(scope, u.orgId, u.userId, { ownerColumn: timesheetExceptions.userId }),
    ];

    if (query.userId && scope === "all") {
      conditions.push(eq(timesheetExceptions.userId, query.userId));
    }
    if (query.status) conditions.push(eq(timesheetExceptions.status, query.status));
    if (query.severity) conditions.push(eq(timesheetExceptions.severity, query.severity));
    if (query.rule) conditions.push(eq(timesheetExceptions.rule, query.rule));

    const rows = await this.db
      .select({
        e: timesheetExceptions,
        userName: users.name,
        userEmail: users.email,
      })
      .from(timesheetExceptions)
      .leftJoin(users, eq(timesheetExceptions.userId, users.id))
      .where(and(...conditions))
      .orderBy(desc(timesheetExceptions.createdAt), desc(timesheetExceptions.id))
      .limit(limit)
      .offset(offset);

    return rows.map((r) => ({
      ...r.e,
      user: { id: r.e.userId, name: r.userName, email: r.userEmail },
    }));
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

    const [updated] = await this.db
      .update(timesheetExceptions)
      .set({
        status: toStatus,
        resolutionReason: reason,
        resolvedBy: u.userId,
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
      actorUserId: u.userId,
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
    const rows = await this.db
      .select({
        status: timesheetExceptions.status,
        severity: timesheetExceptions.severity,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(timesheetExceptions)
      .where(eq(timesheetExceptions.orgId, u.orgId))
      .groupBy(timesheetExceptions.status, timesheetExceptions.severity);

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
