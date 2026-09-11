import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import {
  organizationMembers,
  orgUnitMembers,
  orgUnits,
  users,
} from "../../db/schema";
import type {
  ListLoginHistoryInput,
  UpdateMembershipInput,
  UpdatePreferencesInput,
} from "./dto/users.schemas";
import { syncOrgUnitPlacement } from "../../common/org/sync-org-unit-placement";
import { SessionsService } from "../sessions/sessions.service";
import { EmploymentFactsService } from "../directory/employment-facts.service";
import {
  syncCanonicalEmploymentFields,
  type CanonicalEmploymentPatch,
} from "../../common/hr/sync-canonical-employment-fields";
import { syncCanonicalReportingLine } from "../../common/hr/sync-canonical-reporting-line";
import { UserActivityService } from "./user-activity.service";
import {
  getLoginHistory,
  getPreferences,
  getUserSessions,
  revokeAllSessions,
  revokeSession,
  updatePreferences,
  type UserAccountRecordDeps,
} from "./lib/user-account-records";

const EXPORT_HISTORY_LIMIT = 500;

/**
 * One person, as an organisation's admin sees them — in two halves that differ
 * in how they are kept inside the tenant.
 *
 * Their ACCOUNT records — sessions, sign-in history, preferences — live in
 * `lib/user-account-records.ts`. Those tables are keyed by `user_id` alone, so
 * `assertMember` below is the only thing scoping them to this organisation, and
 * it is handed to that file bound rather than exported.
 *
 * Their PLACEMENT — org units, reporting line, and the subject-access export
 * that composes everything — stays here, on org-scoped tables that carry their
 * own `org_id` predicates as well.
 */
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

  private get accountDeps(): UserAccountRecordDeps {
    return {
      db: this.db,
      audit: this.audit,
      sessions: this.sessions,
      assertMember: (orgId, userId) => this.assertMember(orgId, userId),
    };
  }

  async getUserSessions(orgId: string, userId: string) {
    return getUserSessions(this.accountDeps, orgId, userId);
  }

  async revokeSession(
    orgId: string,
    userId: string,
    sessionId: string,
    actorUserId: string,
  ) {
    return revokeSession(this.accountDeps, orgId, userId, sessionId, actorUserId);
  }

  async revokeAllSessions(orgId: string, userId: string, actorUserId: string) {
    return revokeAllSessions(this.accountDeps, orgId, userId, actorUserId);
  }

  async getPreferences(orgId: string, userId: string) {
    return getPreferences(this.accountDeps, orgId, userId);
  }

  async updatePreferences(
    orgId: string,
    userId: string,
    data: UpdatePreferencesInput,
  ) {
    return updatePreferences(this.accountDeps, orgId, userId, data);
  }

  async getLoginHistory(
    orgId: string,
    userId: string,
    params: ListLoginHistoryInput,
  ) {
    return getLoginHistory(this.accountDeps, orgId, userId, params);
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
      this.getLoginHistory(orgId, userId, { limit: EXPORT_HISTORY_LIMIT, success: undefined }),
      this.activity.getUserAuditLog(orgId, userId, { limit: EXPORT_HISTORY_LIMIT }),
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
