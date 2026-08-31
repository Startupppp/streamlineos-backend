import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import {
  loginHistory,
  organizationMembers,
  orgUnitMembers,
  orgUnits,
  userPreferences,
  userSessions,
  users,
} from "../../db/schema";
import type {
  ListLoginHistoryInput,
  UpdateMembershipInput,
  UpdatePreferencesInput,
} from "./dto/users.schemas";
import { withClientInfo } from "../../common/http/parse-user-agent";
import { syncOrgUnitPlacement } from "../../common/org/sync-org-unit-placement";
import { SessionsService } from "../sessions/sessions.service";
import { EmploymentFactsService } from "../directory/employment-facts.service";
import {
  syncCanonicalEmploymentFields,
  type CanonicalEmploymentPatch,
} from "../../common/hr/sync-canonical-employment-fields";
import { syncCanonicalReportingLine } from "../../common/hr/sync-canonical-reporting-line";
import { UserActivityService } from "./user-activity.service";

const EXPORT_HISTORY_LIMIT = 500;

@Injectable()
export class UserProfileService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly sessions: SessionsService,
    private readonly employment: EmploymentFactsService,
    private readonly activity: UserActivityService,
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

    const [rows, facts] = await Promise.all([
      this.db
        .select({
          unitId: orgUnitMembers.orgUnitId,
          kind: orgUnits.kind,
          name: orgUnits.name,
        })
        .from(orgUnitMembers)
        .innerJoin(organizationMembers, eq(organizationMembers.id, orgUnitMembers.membershipId))
        .innerJoin(orgUnits, eq(orgUnitMembers.orgUnitId, orgUnits.id))
        .where(
          and(
            eq(organizationMembers.userId, userId),
            eq(orgUnitMembers.orgId, orgId),
          ),
        ),
      this.employment.getFacts(orgId, userId),
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
      managerUserId: facts.managerUserId,
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
      const employmentPatch: CanonicalEmploymentPatch = {};
      if (data.branchId !== undefined) employmentPatch.locationId = data.branchId;
      if (data.departmentId !== undefined) employmentPatch.departmentId = data.departmentId;

      if (Object.keys(employmentPatch).length > 0)
        await syncCanonicalEmploymentFields(tx, orgId, userId, employmentPatch);

      if (data.managerUserId !== undefined)
        await syncCanonicalReportingLine(
          tx,
          orgId,
          userId,
          data.managerUserId,
          new Date().toISOString().slice(0, 10),
          actorUserId,
        );

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

  /**
   * DPDP/GDPR subject access export for ONE person, composed from the existing
   * per-user readers rather than new queries — each already re-asserts
   * membership and tenant scope, so coverage cannot drift between the UI and
   * the export.
   *
   * `coverage` is returned deliberately: a subject access request must state
   * what it covers. This is identity, membership, preferences, sessions, login
   * history and audit trail. It does NOT sweep module-owned records (HR
   * documents, payroll, CRM ownership); those live in their own modules and
   * must be appended by their owners before this is presented as a complete
   * SAR response.
   */
  async exportUserData(orgId: string, userId: string) {
    await this.assertMember(orgId, userId);

    const [[identity], identityFacts] = await Promise.all([
      this.db
        .select({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          phone: users.phone,
          image: users.image,
          emailVerified: users.emailVerified,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
      this.employment.getFacts(orgId, userId),
    ]);
    if (!identity) throw new NotFoundException("User not found");

    const [membership, preferences, sessions, loginHistory, auditLog] = await Promise.all([
      this.getMembership(orgId, userId),
      this.getPreferences(orgId, userId),
      this.getUserSessions(orgId, userId),
      this.getLoginHistory(orgId, userId, { page: 1, limit: EXPORT_HISTORY_LIMIT, success: undefined }),
      this.activity.getUserAuditLog(orgId, userId, { page: 1, limit: EXPORT_HISTORY_LIMIT }),
    ]);

    return {
      subject: { ...identity, designation: identityFacts.designation },
      membership,
      preferences,
      sessions,
      loginHistory,
      auditLog,
      coverage: {
        includes: [
          "identity",
          "membership",
          "preferences",
          "sessions",
          "loginHistory",
          "auditLog",
        ],
        excludes: ["hr", "payroll", "crm-owned records"],
        historyRowCap: EXPORT_HISTORY_LIMIT,
      },
    };
  }

}
