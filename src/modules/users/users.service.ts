import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, gt } from "drizzle-orm";
import { randomUUID, randomBytes } from "node:crypto";
import { addDays } from "date-fns";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  users,
  organizations,
  organizationMembers,
  userSessions,
  devices,
  invitations,
  loginHistory,
  userActivity,
  userPreferences,
  userMemberships,
  passwordResetTokens,
} from "../../db/schema";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import type {
  ListUsersInput,
  UpdateUserInput,
  UpdatePreferencesInput,
  UpdateMembershipInput,
  ListLoginHistoryInput,
  BulkUpdateUsersInput,
  ListAuditInput,
  ImportUsersRow,
} from "./dto/users.schemas";

@Injectable()
export class UsersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
  ) {}

  async listUsers(orgId: string, params: ListUsersInput) {
    const { page, limit, search, status, role, departmentId, branchId, teamId, managerUserId, sortBy, sortOrder } = params;
    const offset = (page - 1) * limit;

    const conditions = [eq(organizationMembers.orgId, orgId)];

    if (search) {
      conditions.push(
        or(
          ilike(users.name, `%${search}%`),
          ilike(users.email, `%${search}%`),
          ilike(users.firstName, `%${search}%`),
          ilike(users.lastName, `%${search}%`),
        )!,
      );
    }

    if (role) {
      conditions.push(eq(organizationMembers.role, role));
    }

    if (departmentId !== undefined) {
      conditions.push(eq(users.departmentId, departmentId));
    }

    if (branchId !== undefined) {
      conditions.push(eq(users.branchId, branchId));
    }

    if (teamId !== undefined) {
      conditions.push(eq(users.team, teamId));
    }

    if (managerUserId !== undefined) {
      conditions.push(eq(users.reportingTo, managerUserId));
    }

    if (status === "active") {
      conditions.push(eq(users.isActive, true));
    } else if (status === "suspended" || status === "archived") {
      conditions.push(eq(users.isActive, false));
    }

    const sortDir = sortOrder === "asc" ? asc : desc;
    const sortExpr =
      sortBy === "name"
        ? sortDir(users.name)
        : sortBy === "status"
          ? sortDir(users.isActive)
          : sortDir(organizationMembers.joinedAt);

    const [data, countResult] = await Promise.all([
      this.db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          firstName: users.firstName,
          lastName: users.lastName,
          image: users.image,
          role: organizationMembers.role,
          isActive: users.isActive,
          emailVerified: users.emailVerified,
          departmentId: users.departmentId,
          branchId: users.branchId,
          designation: users.designation,
          phone: users.phone,
          createdAt: users.createdAt,
          joinedAt: organizationMembers.joinedAt,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(...conditions))
        .orderBy(sortExpr)
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(...conditions)),
    ]);

    const total = countResult[0]?.total ?? 0;

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getUser(orgId: string, userId: string) {
    const membership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
      ),
    });

    if (!membership) throw new NotFoundException("User not found in this organization");

    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) throw new NotFoundException("User not found");

    return { ...user, memberRole: membership.role, joinedAt: membership.joinedAt };
  }

  async updateUser(orgId: string, userId: string, data: UpdateUserInput, actorUserId: string) {
    await this.getUser(orgId, userId);

    const updateData: Record<string, unknown> = {};
    if (data.firstName !== undefined) updateData.firstName = data.firstName;
    if (data.lastName !== undefined) updateData.lastName = data.lastName;
    if (data.firstName !== undefined || data.lastName !== undefined) {
      const user = await this.db.query.users.findFirst({ where: eq(users.id, userId), columns: { firstName: true, lastName: true } });
      const first = data.firstName ?? user?.firstName ?? "";
      const last = data.lastName ?? user?.lastName ?? "";
      updateData.name = `${first} ${last}`.trim();
    }
    if (data.designation !== undefined) updateData.designation = data.designation;
    if (data.phone !== undefined) updateData.phone = data.phone;
    if (data.departmentId !== undefined) updateData.departmentId = data.departmentId;
    if (data.bio !== undefined) updateData.bio = data.bio;
    if (data.linkedinUrl !== undefined) updateData.linkedinUrl = data.linkedinUrl || null;
    if (data.twitterUrl !== undefined) updateData.twitterUrl = data.twitterUrl || null;
    if (data.githubUrl !== undefined) updateData.githubUrl = data.githubUrl || null;
    if (data.websiteUrl !== undefined) updateData.websiteUrl = data.websiteUrl || null;
    if (data.reportingTo !== undefined) updateData.reportingTo = data.reportingTo;
    if (data.team !== undefined) updateData.team = data.team;
    if (data.emergencyContact !== undefined) updateData.emergencyContact = data.emergencyContact;

    if (Object.keys(updateData).length > 0) {
      await this.db.update(users).set(updateData).where(eq(users.id, userId));
    }

    if (data.role !== undefined) {
      await this.db
        .update(organizationMembers)
        .set({ role: data.role })
        .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
    }

    await this.db.insert(userActivity).values({
      id: randomUUID(),
      orgId,
      userId,
      actorUserId,
      action: "user.updated",
      resourceType: "user",
      resourceId: userId,
      metadata: { changes: data },
    });

    this.audit.log({ action: "user.updated", userId: actorUserId, orgId, targetId: userId, targetType: "user", metadata: { changes: data } });

    return { success: true };
  }

  async updateUserStatus(orgId: string, userId: string, status: "active" | "suspended" | "archived", actorUserId: string, reason?: string) {
    const user = await this.getUser(orgId, userId);

    if (!user.isActive && status !== "active") {
      const lastStatusEvent = await this.db
        .select({ action: userActivity.action })
        .from(userActivity)
        .where(
          and(
            eq(userActivity.orgId, orgId),
            eq(userActivity.userId, userId),
            or(
              eq(userActivity.action, "user.status.suspended"),
              eq(userActivity.action, "user.status.archived"),
            )!,
          ),
        )
        .orderBy(desc(userActivity.createdAt))
        .limit(1);

      const currentState = lastStatusEvent[0]?.action === "user.status.archived" ? "archived" : "suspended";

      if (currentState === "archived" && status === "suspended") {
        throw new BadRequestException("Cannot suspend an archived user. Restore the user first.");
      }
    }

    const update: Record<string, unknown> = {};
    if (status === "active") {
      update.isActive = true;
    } else {
      update.isActive = false;
    }

    await this.db.update(users).set(update).where(eq(users.id, userId));

    await this.db.insert(userActivity).values({
      id: randomUUID(),
      orgId,
      userId,
      actorUserId,
      action: `user.status.${status}`,
      resourceType: "user",
      resourceId: userId,
      metadata: { status, ...(reason ? { reason } : {}) },
    });

    this.audit.log({ action: `user.status.${status}`, userId: actorUserId, orgId, targetId: userId, targetType: "user", metadata: { status, reason } });

    return { success: true };
  }

  async deleteUser(orgId: string, userId: string, actorUserId: string) {
    await this.getUser(orgId, userId);

    await this.db.update(users).set({ isActive: false }).where(eq(users.id, userId));

    await this.db.insert(userActivity).values({
      id: randomUUID(),
      orgId,
      userId,
      actorUserId,
      action: "user.deleted",
      resourceType: "user",
      resourceId: userId,
      metadata: {},
    });

    this.audit.log({ action: "user.deleted", userId: actorUserId, orgId, targetId: userId, targetType: "user" });

    return { success: true };
  }

  async getUserSessions(orgId: string, userId: string) {
    await this.getUser(orgId, userId);

    return this.db
      .select()
      .from(userSessions)
      .where(and(eq(userSessions.userId, userId), eq(userSessions.isRevoked, false)))
      .orderBy(desc(userSessions.createdAt));
  }

  async revokeSession(orgId: string, userId: string, sessionId: string, actorUserId: string) {
    await this.getUser(orgId, userId);

    await this.db
      .update(userSessions)
      .set({ isRevoked: true })
      .where(and(eq(userSessions.id, sessionId), eq(userSessions.userId, userId)));

    this.audit.log({ action: "user.session.revoked", userId: actorUserId, orgId, targetId: userId, targetType: "user", metadata: { sessionId } });

    return { success: true };
  }

  async revokeAllSessions(orgId: string, userId: string, actorUserId: string) {
    await this.getUser(orgId, userId);

    await this.db
      .update(userSessions)
      .set({ isRevoked: true })
      .where(eq(userSessions.userId, userId));

    this.audit.log({ action: "user.sessions.revoked_all", userId: actorUserId, orgId, targetId: userId, targetType: "user" });

    return { success: true };
  }

  async getUserDevices(orgId: string, userId: string) {
    await this.getUser(orgId, userId);

    return this.db
      .select()
      .from(devices)
      .where(eq(devices.userId, userId))
      .orderBy(desc(devices.lastSeenAt));
  }

  async removeDevice(orgId: string, userId: string, deviceId: string, actorUserId: string) {
    await this.getUser(orgId, userId);

    await this.db
      .delete(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)));

    this.audit.log({ action: "user.device.removed", userId: actorUserId, orgId, targetId: userId, targetType: "user", metadata: { deviceId } });

    return { success: true };
  }

  async getUserActivity(orgId: string, userId: string, params?: { page?: number; limit?: number }) {
    await this.getUser(orgId, userId);

    const page = params?.page ?? 1;
    const limit = Math.min(params?.limit ?? 20, 100);
    const offset = (page - 1) * limit;

    const data = await this.db
      .select()
      .from(userActivity)
      .where(and(eq(userActivity.orgId, orgId), eq(userActivity.userId, userId)))
      .orderBy(desc(userActivity.createdAt))
      .limit(limit)
      .offset(offset);

    return { data, page, limit };
  }

  async getPreferences(userId: string) {
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

  async updatePreferences(userId: string, data: UpdatePreferencesInput) {
    const existing = await this.db.query.userPreferences.findFirst({
      where: eq(userPreferences.userId, userId),
    });

    const updateData: Record<string, unknown> = {};
    if (data.theme !== undefined) updateData.theme = data.theme;
    if (data.language !== undefined) updateData.language = data.language;
    if (data.timezone !== undefined) updateData.timezone = data.timezone;
    if (data.dateFormat !== undefined) updateData.dateFormat = data.dateFormat;
    if (data.timeFormat !== undefined) updateData.timeFormat = data.timeFormat;
    if (data.numberFormat !== undefined) updateData.numberFormat = data.numberFormat;
    if (data.weekStartDay !== undefined) updateData.weekStartDay = data.weekStartDay;
    if (data.accentColor !== undefined) updateData.accentColor = data.accentColor;
    if (data.density !== undefined) updateData.density = data.density;
    if (data.fontSize !== undefined) updateData.fontSize = data.fontSize;
    if (data.reducedMotion !== undefined) updateData.reducedMotion = data.reducedMotion;
    if (data.highContrast !== undefined) updateData.highContrast = data.highContrast;
    if (data.notificationPreferences !== undefined) updateData.notificationPreferences = data.notificationPreferences;
    if (data.dashboardPreferences !== undefined) updateData.dashboardPreferences = data.dashboardPreferences;

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
        notificationPreferences: data.notificationPreferences ?? {} as Record<string, boolean>,
        dashboardPreferences: data.dashboardPreferences ?? {} as Record<string, unknown>,
      });
    }

    return { success: true };
  }

  async inviteUser(
    orgId: string,
    email: string,
    role: string,
    invitedByUserId: string,
    extra?: {
      employeeId?: string;
      branchId?: number;
      departmentId?: number;
      teamId?: string;
      managerUserId?: string;
      startDate?: string;
      welcomeMessage?: string;
    },
  ) {
    const token = randomBytes(32).toString("hex");
    const invitationId = randomUUID();
    const expiresAt = addDays(new Date(), 7);

    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
      columns: { name: true },
    });

    await this.db.insert(invitations).values({
      id: invitationId,
      email,
      token,
      orgId,
      role,
      invitedBy: invitedByUserId,
      expiresAt,
    });

    this.audit.log({ action: "user.invited", userId: invitedByUserId, orgId, targetId: invitationId, targetType: "invitation", metadata: { email, role, ...extra } });

    return { success: true, invitationId, token, organizationName: org?.name ?? "" };
  }

  async bulkInvite(orgId: string, emails: string[], role: string, invitedByUserId: string) {
    const results: Array<{ email: string; success: boolean; invitationId?: string; error?: string }> = [];

    for (const email of emails) {
      try {
        const result = await this.inviteUser(orgId, email, role, invitedByUserId);
        results.push({ email, success: true, invitationId: result.invitationId });
      } catch (err) {
        results.push({ email, success: false, error: err instanceof Error ? err.message : "Unknown error" });
      }
    }

    return { results };
  }

  async exportUsers(orgId: string): Promise<string> {
    const data = await this.db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        role: organizationMembers.role,
        isActive: users.isActive,
        emailVerified: users.emailVerified,
        departmentId: users.departmentId,
        designation: users.designation,
        phone: users.phone,
        joinedAt: organizationMembers.joinedAt,
        createdAt: users.createdAt,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(eq(organizationMembers.orgId, orgId))
      .orderBy(desc(organizationMembers.joinedAt));

    const headers = ["id", "email", "firstName", "lastName", "role", "isActive", "emailVerified", "departmentId", "designation", "phone", "joinedAt", "createdAt"];
    const rows = data.map((u) =>
      headers
        .map((h) => {
          const val = (u as Record<string, unknown>)[h];
          if (val === null || val === undefined) return "";
          if (val instanceof Date) return val.toISOString();
          return String(val).replace(/,/g, ";");
        })
        .join(","),
    );

    return [headers.join(","), ...rows].join("\n");
  }

  async getStats(orgId: string) {
    const cacheKey = `users:stats:${orgId}`;

    return this.cache.cached(cacheKey, async () => {
      const [totalResult, activeResult, suspendedResult, pendingResult, newThisMonthResult] = await Promise.all([
        this.db
          .select({ count: count() })
          .from(organizationMembers)
          .where(eq(organizationMembers.orgId, orgId)),
        this.db
          .select({ count: count() })
          .from(organizationMembers)
          .innerJoin(users, eq(organizationMembers.userId, users.id))
          .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true))),
        this.db
          .select({ count: count() })
          .from(organizationMembers)
          .innerJoin(users, eq(organizationMembers.userId, users.id))
          .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, false))),
        this.db
          .select({ count: count() })
          .from(invitations)
          .where(and(eq(invitations.orgId, orgId), isNull(invitations.acceptedAt))),
        this.db
          .select({ count: count() })
          .from(organizationMembers)
          .where(
            and(
              eq(organizationMembers.orgId, orgId),
              gte(organizationMembers.joinedAt, sql`DATE_TRUNC('month', NOW())`),
            ),
          ),
      ]);

      return {
        total: totalResult[0]?.count ?? 0,
        active: activeResult[0]?.count ?? 0,
        suspended: suspendedResult[0]?.count ?? 0,
        pendingInvitations: pendingResult[0]?.count ?? 0,
        newThisMonth: newThisMonthResult[0]?.count ?? 0,
      };
    }, 60);
  }

  async getInvitations(orgId: string, params?: { page?: number; limit?: number; includeAccepted?: boolean }) {
    const page = params?.page ?? 1;
    const limit = Math.min(params?.limit ?? 20, 100);
    const offset = (page - 1) * limit;

    const conditions = [eq(invitations.orgId, orgId)];
    if (!params?.includeAccepted) {
      conditions.push(isNull(invitations.acceptedAt));
    }

    const [data, countResult] = await Promise.all([
      this.db
        .select({
          id: invitations.id,
          email: invitations.email,
          role: invitations.role,
          invitedBy: invitations.invitedBy,
          expiresAt: invitations.expiresAt,
          acceptedAt: invitations.acceptedAt,
          createdAt: invitations.createdAt,
        })
        .from(invitations)
        .where(and(...conditions))
        .orderBy(desc(invitations.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(invitations)
        .where(and(...conditions)),
    ]);

    return {
      data,
      pagination: { page, limit, total: countResult[0]?.total ?? 0, totalPages: Math.ceil((countResult[0]?.total ?? 0) / limit) },
    };
  }

  async resendInvite(orgId: string, invitationId: string, actorUserId: string) {
    const invitation = await this.db.query.invitations.findFirst({
      where: and(eq(invitations.id, invitationId), eq(invitations.orgId, orgId), isNull(invitations.acceptedAt)),
    });
    if (!invitation) throw new NotFoundException("Invitation not found");

    const newToken = randomBytes(32).toString("hex");
    const newExpiresAt = addDays(new Date(), 7);

    await this.db
      .update(invitations)
      .set({ token: newToken, expiresAt: newExpiresAt })
      .where(eq(invitations.id, invitationId));

    this.audit.log({ action: "user.invitation.resent", userId: actorUserId, orgId, targetId: invitationId, targetType: "invitation", metadata: { email: invitation.email } });

    return { success: true, token: newToken };
  }

  async cancelInvite(orgId: string, invitationId: string, actorUserId: string) {
    const invitation = await this.db.query.invitations.findFirst({
      where: and(eq(invitations.id, invitationId), eq(invitations.orgId, orgId), isNull(invitations.acceptedAt)),
    });
    if (!invitation) throw new NotFoundException("Invitation not found or already accepted");

    await this.db.delete(invitations).where(eq(invitations.id, invitationId));

    this.audit.log({ action: "user.invitation.cancelled", userId: actorUserId, orgId, targetId: invitationId, targetType: "invitation", metadata: { email: invitation.email } });

    return { success: true };
  }

  async getLoginHistory(orgId: string, userId: string, params: ListLoginHistoryInput) {
    await this.getUser(orgId, userId);

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
      data,
      pagination: { page, limit, total: countResult[0]?.total ?? 0, totalPages: Math.ceil((countResult[0]?.total ?? 0) / limit) },
    };
  }

  async updateMembership(orgId: string, userId: string, data: UpdateMembershipInput, actorUserId: string) {
    await this.getUser(orgId, userId);

    const existing = await this.db.query.userMemberships.findFirst({
      where: and(eq(userMemberships.orgId, orgId), eq(userMemberships.userId, userId)),
    });

    const updateData: Record<string, unknown> = {};
    if (data.businessUnitId !== undefined) updateData.businessUnitId = data.businessUnitId;
    if (data.branchId !== undefined) updateData.branchId = data.branchId;
    if (data.departmentId !== undefined) updateData.departmentId = data.departmentId;
    if (data.teamId !== undefined) updateData.teamId = data.teamId;
    if (data.managerUserId !== undefined) updateData.managerUserId = data.managerUserId;
    if (data.isPrimary !== undefined) updateData.isPrimary = data.isPrimary;

    if (existing) {
      await this.db.update(userMemberships).set(updateData).where(and(eq(userMemberships.orgId, orgId), eq(userMemberships.userId, userId)));
    } else {
      await this.db.insert(userMemberships).values({
        id: randomUUID(),
        orgId,
        userId,
        isPrimary: data.isPrimary ?? true,
        ...updateData,
      });
    }

    if (data.managerUserId !== undefined) {
      await this.db.update(users).set({ reportingTo: data.managerUserId }).where(eq(users.id, userId));
    }
    if (data.departmentId !== undefined) {
      await this.db.update(users).set({ departmentId: data.departmentId }).where(eq(users.id, userId));
    }

    await this.db.insert(userActivity).values({
      id: randomUUID(),
      orgId,
      userId,
      actorUserId,
      action: "user.membership.updated",
      resourceType: "user",
      resourceId: userId,
      metadata: { changes: data },
    });

    this.audit.log({ action: "user.membership.updated", userId: actorUserId, orgId, targetId: userId, targetType: "user", metadata: { changes: data } });

    return { success: true };
  }

  async getMembership(orgId: string, userId: string) {
    await this.getUser(orgId, userId);
    const membership = await this.db.query.userMemberships.findFirst({
      where: and(eq(userMemberships.orgId, orgId), eq(userMemberships.userId, userId)),
    });
    return membership ?? { userId, orgId, businessUnitId: null, branchId: null, departmentId: null, teamId: null, managerUserId: null, isPrimary: true };
  }

  async bulkSuspend(orgId: string, userIds: string[], actorUserId: string) {
    const results: Array<{ userId: string; success: boolean; error?: string }> = [];
    for (const userId of userIds) {
      try {
        await this.updateUserStatus(orgId, userId, "suspended", actorUserId);
        results.push({ userId, success: true });
      } catch {
        results.push({ userId, success: false, error: "Failed to suspend" });
      }
    }
    return { results, succeeded: results.filter((r) => r.success).length, failed: results.filter((r) => !r.success).length };
  }

  async bulkArchive(orgId: string, userIds: string[], actorUserId: string) {
    const results: Array<{ userId: string; success: boolean; error?: string }> = [];
    for (const userId of userIds) {
      try {
        await this.updateUserStatus(orgId, userId, "archived", actorUserId);
        results.push({ userId, success: true });
      } catch {
        results.push({ userId, success: false, error: "Failed to archive" });
      }
    }
    return { results, succeeded: results.filter((r) => r.success).length, failed: results.filter((r) => !r.success).length };
  }

  async bulkRestore(orgId: string, userIds: string[], actorUserId: string) {
    const results: Array<{ userId: string; success: boolean; error?: string }> = [];
    for (const userId of userIds) {
      try {
        await this.updateUserStatus(orgId, userId, "active", actorUserId);
        results.push({ userId, success: true });
      } catch {
        results.push({ userId, success: false, error: "Failed to restore" });
      }
    }
    return { results, succeeded: results.filter((r) => r.success).length, failed: results.filter((r) => !r.success).length };
  }

  async bulkUpdateUsers(orgId: string, data: BulkUpdateUsersInput, actorUserId: string) {
    const { userIds, role, departmentId, branchId, teamId, managerUserId } = data;

    const userUpdate: Record<string, unknown> = {};
    if (departmentId !== undefined) userUpdate.departmentId = departmentId;
    if (branchId !== undefined) userUpdate.branchId = branchId;
    if (managerUserId !== undefined) userUpdate.reportingTo = managerUserId;
    if (teamId !== undefined) userUpdate.team = teamId;

    if (Object.keys(userUpdate).length > 0) {
      await this.db.update(users).set(userUpdate).where(inArray(users.id, userIds));
    }

    if (role) {
      await this.db
        .update(organizationMembers)
        .set({ role })
        .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, userIds)));
    }

    this.audit.log({
      action: "user.bulk_updated",
      userId: actorUserId,
      orgId,
      targetType: "user",
      metadata: { userIds, changes: { role, departmentId, branchId, teamId, managerUserId } },
    });

    return { success: true, updated: userIds.length };
  }

  async resetPassword(orgId: string, userId: string, actorUserId: string) {
    await this.getUser(orgId, userId);

    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId), columns: { email: true } });
    if (!user) throw new NotFoundException("User not found");

    const token = randomBytes(32).toString("hex");
    const expiresAt = addDays(new Date(), 1);

    await this.db.insert(passwordResetTokens).values({
      id: randomUUID(),
      email: user.email,
      token,
      expiresAt,
    });

    this.audit.log({ action: "user.password_reset_sent", userId: actorUserId, orgId, targetId: userId, targetType: "user", metadata: { email: user.email } });

    return { success: true, email: user.email };
  }

  async getAuditLog(orgId: string, params: ListAuditInput) {
    const { page, limit, actorUserId, action, from, to } = params;
    const offset = (page - 1) * limit;

    const conditions = [eq(userActivity.orgId, orgId)];
    if (actorUserId) conditions.push(eq(userActivity.actorUserId, actorUserId));
    if (action) conditions.push(ilike(userActivity.action, `%${action}%`));
    if (from) conditions.push(gte(userActivity.createdAt, new Date(from)));
    if (to) conditions.push(lte(userActivity.createdAt, new Date(to)));

    const [data, countResult] = await Promise.all([
      this.db.select().from(userActivity).where(and(...conditions)).orderBy(desc(userActivity.createdAt)).limit(limit).offset(offset),
      this.db.select({ total: count() }).from(userActivity).where(and(...conditions)),
    ]);

    return {
      data,
      pagination: { page, limit, total: countResult[0]?.total ?? 0, totalPages: Math.ceil((countResult[0]?.total ?? 0) / limit) },
    };
  }

  async importUsers(orgId: string, rows: ImportUsersRow[], actorUserId: string) {
    const results: Array<{ email: string; success: boolean; error?: string; invitationId?: string }> = [];

    for (const row of rows) {
      try {
        const result = await this.inviteUser(orgId, row.email, row.role ?? "MEMBER", actorUserId);
        results.push({ email: row.email, success: true, invitationId: result.invitationId });
      } catch (err) {
        results.push({ email: row.email, success: false, error: err instanceof Error ? err.message : "Unknown error" });
      }
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    this.audit.log({ action: "user.bulk_imported", userId: actorUserId, orgId, metadata: { total: rows.length, succeeded, failed } });

    return { results, succeeded, failed, total: rows.length };
  }

  async getUserAuditLog(orgId: string, userId: string, params: ListAuditInput) {
    await this.getUser(orgId, userId);

    const { page, limit, from, to } = params;
    const offset = (page - 1) * limit;

    const conditions = [eq(userActivity.orgId, orgId), eq(userActivity.userId, userId)];
    if (from) conditions.push(gte(userActivity.createdAt, new Date(from)));
    if (to) conditions.push(lte(userActivity.createdAt, new Date(to)));

    const [data, countResult] = await Promise.all([
      this.db.select().from(userActivity).where(and(...conditions)).orderBy(desc(userActivity.createdAt)).limit(limit).offset(offset),
      this.db.select({ total: count() }).from(userActivity).where(and(...conditions)),
    ]);

    return {
      data,
      pagination: { page, limit, total: countResult[0]?.total ?? 0, totalPages: Math.ceil((countResult[0]?.total ?? 0) / limit) },
    };
  }
}
