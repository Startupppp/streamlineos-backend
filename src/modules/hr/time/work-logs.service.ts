import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gte, isNull, lte, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { organizationMembers, timesheets, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { formatDateOnly, getTodayString } from "../../../common/date";
import type {
  ExportWorkLogsQuery,
  ListWorkLogsQuery,
  PatchWorkLogStatusInput,
  PostWorkLogInput,
} from "./dto/work-logs.schemas";
import { resolveWorkLogsScope, WORKLOGS_PERMISSION } from "./worklogs-scope";
import { exportWorkLogsCsv } from "./work-logs-export";

@Injectable()
export class WorkLogsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async list(u: CurrentUserContext, query: ListWorkLogsQuery) {
    const scope = await resolveWorkLogsScope(this.access, u);
    if (!scope.unrestricted && query.userId && query.userId !== u.userId) {
      throw new ForbiddenException("Not authorized to view other users' work logs.");
    }

    return this.getWorkLogs(
      u.orgId,
      u.userId,
      query.year,
      query.quarter,
      query.userId,
      query.month,
      query.dateFrom,
      query.dateTo,
    );
  }

  private async getWorkLogs(
    orgId: string,
    userId: string,
    year: number,
    quarter: number,
    filterUserId?: string,
    month?: number,
    dateFrom?: string,
    dateTo?: string,
  ) {
    const targetUserId = filterUserId || userId;

    const [member] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, targetUserId)))
      .limit(1);
    if (!member) return [];

    const startMonth = (quarter - 1) * 3;
    const quarterStart = formatDateOnly(new Date(year, startMonth, 1));
    const quarterEnd = formatDateOnly(new Date(year, startMonth + 3, 0));

    const effectiveFrom = dateFrom && dateFrom >= quarterStart ? dateFrom : quarterStart;
    const effectiveTo = dateTo && dateTo <= quarterEnd ? dateTo : quarterEnd;

    const conditions: SQL[] = [
      eq(timesheets.orgId, orgId),
      eq(timesheets.userMembershipId, member.id),
      isNull(timesheets.ticketId),
      gte(timesheets.date, effectiveFrom),
      lte(timesheets.date, effectiveTo),
    ];

    if (month !== undefined) {
      conditions.push(sql`EXTRACT(MONTH FROM ${timesheets.date}) = ${month + 1}`);
      conditions.push(sql`EXTRACT(YEAR FROM ${timesheets.date}) = ${year}`);
    }

    const logs = await this.db.query.timesheets.findMany({
      where: and(...conditions),
      orderBy: [asc(timesheets.date)],
      limit: 1000,
    });

    const seenDates = new Set<string>();
    return logs
      .map((l) => ({ ...l, date: String(l.date).slice(0, 10) }))
      .filter((l) => {
        if (seenDates.has(l.date)) return false;
        seenDates.add(l.date);
        return true;
      });
  }

  async create(orgId: string, userId: string, body: PostWorkLogInput, actor?: CurrentUserContext) {
    const [member] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
      .limit(1);
    if (!member) throw new NotFoundException("Member not found");

    const dateStr = formatDateOnly(body.date);
    const todayStr = getTodayString();
    if (dateStr !== todayStr) {
      throw new ForbiddenException("Work logs can only be created or updated for today.");
    }

    const existing = await this.db.query.timesheets.findFirst({
      where: and(
        eq(timesheets.orgId, orgId),
        eq(timesheets.userMembershipId, member.id),
        eq(timesheets.date, dateStr),
        isNull(timesheets.ticketId),
      ),
    });

    const alreadySaved = Boolean(
      existing?.description?.trim() || existing?.workLink?.trim(),
    );

    if (alreadySaved) {
      const canManage =
        actor?.isOrgOwner ||
        (actor
          ? ((await this.access.resolveUserPermissions(orgId, actor.userId)).get(
              WORKLOGS_PERMISSION,
            ) ?? "none") !== "none"
          : false);
      if (!canManage) {
        throw new ForbiddenException(
          "Saved work logs are locked. Ask HR or a manager with attendance access to edit.",
        );
      }
    }

    const normalizedDescription = body.description
      ? body.description.replace(/(^\s*\w|[.!?]\s+\w)/g, (c) => c.toUpperCase())
      : body.description;

    const workLink = body.workLink || null;

    return await this.db.transaction(async (tx) => {
      const [upserted] = await tx
        .insert(timesheets)
        .values({
          orgId,
          userMembershipId: member.id,
          date: dateStr,
          description: normalizedDescription,
          hours: body.hours?.toString() || "0",
          workLink,
          status: "APPROVED",
        })
        .onConflictDoUpdate({
          target: [timesheets.orgId, timesheets.userMembershipId, timesheets.date],
          targetWhere: sql`ticket_id IS NULL AND project_id IS NULL AND voided_at IS NULL`,
          set: {
            description: normalizedDescription,
            hours: body.hours ? body.hours.toString() : sql`${timesheets.hours}`,
            workLink,
            status: "APPROVED",
            updatedAt: new Date(),
          },
        })
        .returning();

      await this.audit.logCritical({
        action: "hr.worklog.saved",
        userId: actor?.userId ?? userId,
        orgId,
        targetId: upserted ? String(upserted.id) : null,
        targetType: "work_log",
        metadata: {
          employeeUserId: userId,
          date: dateStr,
          // A locked log rewritten by someone holding hr:attendance:manage —
          // the override this audit trail exists to answer for.
          overwroteLockedLog: alreadySaved,
        },
        before: existing ? this.auditShape(existing) : null,
        after: upserted ? this.auditShape(upserted) : null,
      });

      return upserted;
    });
  }

  private auditShape(row: typeof timesheets.$inferSelect): Record<string, unknown> {
    return {
      description: row.description,
      hours: row.hours,
      workLink: row.workLink,
      status: row.status,
    };
  }

  async updateStatus(u: CurrentUserContext, body: PatchWorkLogStatusInput) {
    const existing = await this.db.query.timesheets.findFirst({
      where: and(eq(timesheets.id, body.id), eq(timesheets.orgId, u.orgId)),
    });

    if (!existing) throw new NotFoundException("Work log not found.");

    const [approverMember] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, u.orgId), eq(organizationMembers.userId, u.userId)))
      .limit(1);

    const updated = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(timesheets)
        .set({
          status: body.status,
          approvedByMembershipId: approverMember?.id ?? null,
          approvedAt: new Date(),
          rejectionReason: body.status === "REJECTED" ? (body.rejectionReason ?? null) : null,
        })
        .where(and(eq(timesheets.id, body.id), eq(timesheets.orgId, u.orgId)))
        .returning();
      if (!row) throw new NotFoundException("Work log not found.");

      await this.audit.logCritical({
        action: body.status === "APPROVED" ? "hr.worklog.approved" : "hr.worklog.rejected",
        userId: u.userId,
        orgId: u.orgId,
        targetId: String(body.id),
        targetType: "work_log",
        metadata: {
          previousStatus: existing.status,
          status: body.status,
          date: String(existing.date).slice(0, 10),
          employeeMembershipId: existing.userMembershipId,
          approverMembershipId: approverMember?.id ?? null,
          rejectionReason: body.status === "REJECTED" ? (body.rejectionReason ?? null) : null,
        },
      });
      return row;
    });

    // After the decision has committed: an approval mail must never precede the
    // audit row that justifies it.
    void this.dispatchWorkLogStatusEmail(existing, body.status, u.userId, body.rejectionReason).catch(() => undefined);

    return updated;
  }

  private async dispatchWorkLogStatusEmail(
    log: typeof timesheets.$inferSelect,
    status: "APPROVED" | "REJECTED",
    actorId: string,
    rejectionReason?: string,
  ): Promise<void> {
    const ownerMember = alias(organizationMembers, "owner_member");
    const [ownerRow, actorRow] = await Promise.all([
      log.userMembershipId !== null
        ? this.db
            .select({ id: users.id, name: users.name })
            .from(ownerMember)
            .innerJoin(users, eq(ownerMember.userId, users.id))
            .where(and(eq(ownerMember.orgId, log.orgId), eq(ownerMember.id, log.userMembershipId)))
            .limit(1)
        : Promise.resolve([] as Array<{ id: string; name: string | null }>),
      this.db.select({ name: users.name }).from(users).where(eq(users.id, actorId)).limit(1),
    ]);

    const ownerName = ownerRow[0]?.name ?? "Employee";
    const actorName = actorRow[0]?.name ?? "Manager";
    const dateLabel = String(log.date).slice(0, 10);

    if (!ownerRow[0]) return;
    await this.dispatch.emit({
      eventKey: status === "APPROVED" ? "hr.worklog.approved" : "hr.worklog.rejected",
      orgId: log.orgId,
      actorUserId: actorId,
      targetUserIds: [ownerRow[0].id],
      entityType: "work_log",
      entityId: String(log.id),
      message: status === "APPROVED" ? "Your work log was approved." : "Your work log was rejected.",
      variables: { employeeName: ownerName, actorName, date: dateLabel, rejectionReason: rejectionReason ?? null },
    });
  }

  async exportCsv(u: CurrentUserContext, query: ExportWorkLogsQuery): Promise<string> {
    return exportWorkLogsCsv(this.db, this.access, this.audit, u, query);
  }
}
