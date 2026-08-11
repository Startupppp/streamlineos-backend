import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq, gte, ilike, lte } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import {
  auditLogs,
  loginHistory,
  organizationMembers,
  orgUnitMembers,
  orgUnits,
  userPreferences,
  userSessions,
  users,
} from "../../db/schema";
import type {
  ListAuditInput,
  ListLoginHistoryInput,
  UpdateMembershipInput,
  UpdatePreferencesInput,
} from "./dto/users.schemas";
import { withClientInfo } from "../../common/http/parse-user-agent";
import { syncOrgUnitPlacement } from "../../common/org/sync-org-unit-placement";
import { SessionsService } from "../sessions/sessions.service";

@Injectable()
export class UserProfileService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly sessions: SessionsService,
  ) {}

  private async assertMember(orgId: string, userId: string): Promise<void> {
    const membership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
      ),
      columns: { userId: true },
    });
    if (!membership)
      throw new NotFoundException("User not found in this organization");
  }

  async getUserSessions(orgId: string, userId: string) {
    await this.assertMember(orgId, userId);
    const rows = await this.db
      .select()
      .from(userSessions)
      .where(
        and(eq(userSessions.userId, userId), eq(userSessions.isRevoked, false)),
      )
      .orderBy(desc(userSessions.createdAt));
    return rows.map(withClientInfo);
  }

  async revokeSession(
    orgId: string,
    userId: string,
    sessionId: string,
    actorUserId: string,
  ) {
    await this.assertMember(orgId, userId);
    await this.db
      .update(userSessions)
      .set({ isRevoked: true })
      .where(
        and(eq(userSessions.id, sessionId), eq(userSessions.userId, userId)),
      );
    await this.sessions.publishRevocations([sessionId]);
    this.audit.log({
      action: "user.session.revoked",
      userId: actorUserId,
      orgId,
      targetId: userId,
      targetType: "user",
      metadata: { sessionId },
    });
    return { success: true };
  }

  async revokeAllSessions(orgId: string, userId: string, actorUserId: string) {
    await this.assertMember(orgId, userId);
    const active = await this.db
      .select({ id: userSessions.id })
      .from(userSessions)
      .where(
        and(eq(userSessions.userId, userId), eq(userSessions.isRevoked, false)),
      );
    await this.db
      .update(userSessions)
      .set({ isRevoked: true })
      .where(eq(userSessions.userId, userId));
    await this.sessions.publishRevocations(active.map((session) => session.id));
    this.audit.log({
      action: "user.sessions.revoked_all",
      userId: actorUserId,
      orgId,
      targetId: userId,
      targetType: "user",
    });
    return { success: true };
  }

  async getUserActivity(
    orgId: string,
    userId: string,
    params?: { page?: number; limit?: number },
  ) {
    await this.assertMember(orgId, userId);

    const page = params?.page ?? 1;
    const limit = Math.min(params?.limit ?? 20, 100);
    const offset = (page - 1) * limit;

    const rows = await this.db
      .select({
        id: auditLogs.id,
        orgId: auditLogs.orgId,
        targetId: auditLogs.targetId,
        actorUserId: auditLogs.actorUserId,
        action: auditLogs.action,
        resourceType: auditLogs.resourceType,
        resourceId: auditLogs.resourceId,
        metadata: auditLogs.metadata,
        ipAddress: auditLogs.ipAddress,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.orgId, orgId),
          eq(auditLogs.targetId, userId),
          eq(auditLogs.targetType, "user"),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      data: rows.map((row) => ({
        id: String(row.id),
        orgId: row.orgId ?? "",
        userId: row.targetId ?? "",
        actorUserId: row.actorUserId ?? null,
        action: row.action,
        resourceType: row.resourceType ?? null,
        resourceId: row.resourceId ?? null,
        metadata: row.metadata ?? {},
        ipAddress: row.ipAddress ?? null,
        createdAt: row.createdAt,
      })),
      page,
      limit,
    };
  }

  async getPreferences(orgId: string, userId: string) {
    await this.assertMember(orgId, userId);
    const prefs = await this.db.query.userPreferences.findFirst({
      where: eq(userPreferences.userId, userId),
    });
    if (!prefs) {
      return {
        userId,
        theme: "system",
        language: "en",
        timezone: "Asia/Kolkata",
        dateFormat: "DD/MM/YYYY",
        timeFormat: "12h",
        notificationPreferences: {},
        dashboardPreferences: {},
      };
    }
    return prefs;
  }

  async updatePreferences(
    orgId: string,
    userId: string,
    data: UpdatePreferencesInput,
  ) {
    await this.assertMember(orgId, userId);
    const existing = await this.db.query.userPreferences.findFirst({
      where: eq(userPreferences.userId, userId),
    });

    const updateData: Record<string, unknown> = {};
    if (data.theme !== undefined) updateData.theme = data.theme;
    if (data.language !== undefined) updateData.language = data.language;
    if (data.timezone !== undefined) updateData.timezone = data.timezone;
    if (data.dateFormat !== undefined) updateData.dateFormat = data.dateFormat;
    if (data.timeFormat !== undefined) updateData.timeFormat = data.timeFormat;
    if (data.numberFormat !== undefined)
      updateData.numberFormat = data.numberFormat;
    if (data.weekStartDay !== undefined)
      updateData.weekStartDay = data.weekStartDay;
    if (data.notificationPreferences !== undefined)
      updateData.notificationPreferences = data.notificationPreferences;
    if (data.dashboardPreferences !== undefined)
      updateData.dashboardPreferences = data.dashboardPreferences;

    if (existing) {
      await this.db
        .update(userPreferences)
        .set(updateData)
        .where(eq(userPreferences.userId, userId));
    } else {
      await this.db.insert(userPreferences).values({
        userId,
        theme: data.theme ?? "system",
        language: data.language ?? "en",
        timezone: data.timezone ?? "Asia/Kolkata",
        dateFormat: data.dateFormat ?? "DD/MM/YYYY",
        timeFormat: data.timeFormat ?? "12h",
        notificationPreferences:
          data.notificationPreferences ?? ({} as Record<string, boolean>),
        dashboardPreferences:
          data.dashboardPreferences ?? ({} as Record<string, unknown>),
      });
    }

    return { success: true };
  }

  async getLoginHistory(
    orgId: string,
    userId: string,
    params: ListLoginHistoryInput,
  ) {
    await this.assertMember(orgId, userId);

    const { page, limit, success: successFilter } = params;
    const offset = (page - 1) * limit;

    const conditions = [eq(loginHistory.userId, userId)];
    if (successFilter !== undefined) {
      conditions.push(eq(loginHistory.success, successFilter));
    }

    const [data, countResult] = await Promise.all([
      this.db
        .select()
        .from(loginHistory)
        .where(and(...conditions))
        .orderBy(desc(loginHistory.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(loginHistory)
        .where(and(...conditions)),
    ]);

    return {
      data: data.map(withClientInfo),
      pagination: {
        page,
        limit,
        total: countResult[0]?.total ?? 0,
        totalPages: Math.ceil((countResult[0]?.total ?? 0) / limit),
      },
    };
  }

  async getMembership(orgId: string, userId: string) {
    await this.assertMember(orgId, userId);

    const [rows, placement] = await Promise.all([
      this.db
        .select({
          unitId: orgUnitMembers.orgUnitId,
          kind: orgUnits.kind,
          name: orgUnits.name,
        })
        .from(orgUnitMembers)
        .innerJoin(orgUnits, eq(orgUnitMembers.orgUnitId, orgUnits.id))
        .where(
          and(
            eq(orgUnitMembers.userId, userId),
            eq(orgUnitMembers.orgId, orgId),
          ),
        ),
      this.db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { reportingTo: true },
      }),
    ]);

    const byKind = (kind: string) =>
      rows.find((r) => r.kind === kind)?.unitId ?? null;

    return {
      userId,
      orgId,
      businessUnitId: byKind("BUSINESS_UNIT"),
      branchId: byKind("BRANCH"),
      departmentId: byKind("DEPARTMENT"),
      teamId: byKind("TEAM"),
      managerUserId: placement?.reportingTo ?? null,
    };
  }

  async updateMembership(
    orgId: string,
    userId: string,
    data: UpdateMembershipInput,
    actorUserId: string,
  ) {
    await this.assertMember(orgId, userId);

    if (data.managerUserId) {
      const manager = await this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, data.managerUserId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
        columns: { userId: true },
      });
      if (!manager)
        throw new BadRequestException(
          "Manager must be an active member of this organization",
        );
    }

    await this.db.transaction(async (tx) => {
      const scalarPlacement: Partial<{
        reportingTo: string | null;
        branchId: string | null;
        orgDepartmentId: string | null;
      }> = {};
      if (data.managerUserId !== undefined)
        scalarPlacement.reportingTo = data.managerUserId;
      if (data.branchId !== undefined) scalarPlacement.branchId = data.branchId;
      if (data.departmentId !== undefined)
        scalarPlacement.orgDepartmentId = data.departmentId;

      if (Object.keys(scalarPlacement).length > 0)
        await tx.update(users).set(scalarPlacement).where(eq(users.id, userId));

      await syncOrgUnitPlacement(tx, orgId, userId, {
        BUSINESS_UNIT: data.businessUnitId,
        BRANCH: data.branchId,
        DEPARTMENT: data.departmentId,
        TEAM: data.teamId,
      });
    });

    this.audit.log({
      action: "user.membership.updated",
      userId: actorUserId,
      orgId,
      targetId: userId,
      targetType: "user",
      actorUserId,
      resourceType: "user",
      resourceId: userId,
      metadata: { changes: data },
    });

    return { success: true };
  }

  async getAuditLog(orgId: string, params: ListAuditInput) {
    const { page, limit, actorUserId, action, from, to } = params;
    const offset = (page - 1) * limit;

    const conditions = [
      eq(auditLogs.orgId, orgId),
      eq(auditLogs.targetType, "user"),
    ];
    if (actorUserId) conditions.push(eq(auditLogs.actorUserId, actorUserId));
    if (action) conditions.push(ilike(auditLogs.action, `%${action}%`));
    if (from) conditions.push(gte(auditLogs.createdAt, new Date(from)));
    if (to) conditions.push(lte(auditLogs.createdAt, new Date(to)));

    const [rows, countResult] = await Promise.all([
      this.db
        .select({
          id: auditLogs.id,
          orgId: auditLogs.orgId,
          targetId: auditLogs.targetId,
          actorUserId: auditLogs.actorUserId,
          action: auditLogs.action,
          resourceType: auditLogs.resourceType,
          resourceId: auditLogs.resourceId,
          metadata: auditLogs.metadata,
          ipAddress: auditLogs.ipAddress,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .where(and(...conditions))
        .orderBy(desc(auditLogs.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(auditLogs)
        .where(and(...conditions)),
    ]);

    return {
      data: rows.map((row) => ({
        id: String(row.id),
        orgId: row.orgId ?? "",
        userId: row.targetId ?? "",
        actorUserId: row.actorUserId ?? null,
        action: row.action,
        resourceType: row.resourceType ?? null,
        resourceId: row.resourceId ?? null,
        metadata: row.metadata ?? {},
        ipAddress: row.ipAddress ?? null,
        createdAt: row.createdAt,
      })),
      pagination: {
        page,
        limit,
        total: countResult[0]?.total ?? 0,
        totalPages: Math.ceil((countResult[0]?.total ?? 0) / limit),
      },
    };
  }

  async getUserAuditLog(orgId: string, userId: string, params: ListAuditInput) {
    await this.assertMember(orgId, userId);

    const { page, limit, from, to } = params;
    const offset = (page - 1) * limit;

    const conditions = [
      eq(auditLogs.orgId, orgId),
      eq(auditLogs.targetId, userId),
      eq(auditLogs.targetType, "user"),
    ];
    if (from) conditions.push(gte(auditLogs.createdAt, new Date(from)));
    if (to) conditions.push(lte(auditLogs.createdAt, new Date(to)));

    const [rows, countResult] = await Promise.all([
      this.db
        .select({
          id: auditLogs.id,
          orgId: auditLogs.orgId,
          targetId: auditLogs.targetId,
          actorUserId: auditLogs.actorUserId,
          action: auditLogs.action,
          resourceType: auditLogs.resourceType,
          resourceId: auditLogs.resourceId,
          metadata: auditLogs.metadata,
          ipAddress: auditLogs.ipAddress,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .where(and(...conditions))
        .orderBy(desc(auditLogs.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(auditLogs)
        .where(and(...conditions)),
    ]);

    return {
      data: rows.map((row) => ({
        id: String(row.id),
        orgId: row.orgId ?? "",
        userId: row.targetId ?? "",
        actorUserId: row.actorUserId ?? null,
        action: row.action,
        resourceType: row.resourceType ?? null,
        resourceId: row.resourceId ?? null,
        metadata: row.metadata ?? {},
        ipAddress: row.ipAddress ?? null,
        createdAt: row.createdAt,
      })),
      pagination: {
        page,
        limit,
        total: countResult[0]?.total ?? 0,
        totalPages: Math.ceil((countResult[0]?.total ?? 0) / limit),
      },
    };
  }
}
