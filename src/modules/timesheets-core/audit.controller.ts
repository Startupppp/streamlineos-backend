import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { and, count, desc, eq } from "drizzle-orm";
import { Inject } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { timesheetAuditEvents, users } from "../../db/schema";
import { auditQuerySchema, type AuditQuery } from "./dto/audit.schemas";

@Controller("timesheets/audit")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AuditController {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  @Get()
  @RequirePermission("timesheets:audit:view")
  async list(
    @Query(new ZodValidationPipe(auditQuerySchema)) query: AuditQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const limit = Math.min(query.limit, 100);
    const offset = (query.page - 1) * limit;

    const conditions = [eq(timesheetAuditEvents.orgId, u.orgId)];
    if (query.entityType) conditions.push(eq(timesheetAuditEvents.entityType, query.entityType));
    if (query.entityId) conditions.push(eq(timesheetAuditEvents.entityId, query.entityId));
    if (query.action) conditions.push(eq(timesheetAuditEvents.action, query.action));

    const [totalResult, rows] = await Promise.all([
      this.db
        .select({ total: count() })
        .from(timesheetAuditEvents)
        .where(and(...conditions)),
      this.db
        .select({
          id: timesheetAuditEvents.id,
          actorUserId: timesheetAuditEvents.actorUserId,
          actorName: users.name,
          entityType: timesheetAuditEvents.entityType,
          entityId: timesheetAuditEvents.entityId,
          action: timesheetAuditEvents.action,
          before: timesheetAuditEvents.before,
          after: timesheetAuditEvents.after,
          reason: timesheetAuditEvents.reason,
          createdAt: timesheetAuditEvents.createdAt,
        })
        .from(timesheetAuditEvents)
        .leftJoin(users, eq(timesheetAuditEvents.actorUserId, users.id))
        .where(and(...conditions))
        .orderBy(desc(timesheetAuditEvents.createdAt))
        .limit(limit)
        .offset(offset),
    ]);

    return {
      data: rows,
      total: totalResult[0]?.total ?? 0,
    };
  }
}
