import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { InviteActor } from "../organization/core/invitations.service";
import { AccessService } from "../access/access.service";
import { and, asc, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { DRIZZLE } from "../../db/drizzle.constants";
import { syncStructuralRoleAssignment } from "../../common/rbac/sync-structural-role";
import { type Db } from "../../db/drizzle.module";
import {
  auditLogs,
  organizationMembers,
  orgUnitMembers,
  orgUnits,
  projectTeamMembers,
  projectTeams,
  userSessions,
  users,
} from "../../db/schema";
import { AuditService } from "../../common/audit/audit.service";
import { InvitationsService } from "../organization/core/invitations.service";
import type {
  CreateUserInput,
  ListUsersInput,
  UpdateUserInput,
} from "./dto/users.schemas";
import { assertMayGrantRole } from "../../common/rbac/assert-may-grant-role";
import { syncOrgUnitPlacement } from "../../common/org/sync-org-unit-placement";
import {
  assertNotModuleOwner,
  assertOwnerNotTargeted,
  assertTargetNotOwner,
} from "../../common/rbac/assert-target-not-owner";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { bustMembershipStatusCache } from "../../common/auth/jwt-auth.guard";
import { SessionsService } from "../sessions/sessions.service";

@Injectable()
export class UsersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly invitationsSvc: InvitationsService,
    private readonly access: AccessService,
    private readonly sessions: SessionsService,
  ) {}

  async createUser(orgId: string, input: CreateUserInput, actor: InviteActor) {
    const actorUserId = actor.userId;
    const { email, firstName, lastName, role, designation, phone, departmentId, branchId, sendInvite } = input;

    if (sendInvite) {
      return this.invitationsSvc.invite(orgId, actor, email, role);
    }

    await this.assertMayGrantRole(orgId, actor, role);

    const existing = await this.db.query.users.findFirst({ where: eq(users.email, email) });
    if (existing) {
      const membership = await this.db.query.organizationMembers.findFirst({
        where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, existing.id)),
      });
      if (membership) throw new ConflictException("User is already a member of this organization");
      await this.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(organizationMembers)
          .values({ userId: existing.id, orgId, role })
          .onConflictDoNothing()
          .returning({ id: organizationMembers.id });
        const membershipId = inserted[0]?.id;
        if (membershipId !== undefined) {
          await syncStructuralRoleAssignment(tx, orgId, membershipId, role);
        }
        await syncOrgUnitPlacement(tx, orgId, existing.id, {
          DEPARTMENT: departmentId ?? null,
          BRANCH: branchId ?? null,
        });
      });
      return { userId: existing.id, created: false };
    }

    const userId = randomUUID();
    const trimmedFirst = firstName?.trim() || null;
    const trimmedLast = lastName?.trim() || null;
    const fromNames = [trimmedFirst, trimmedLast].filter(Boolean).join(" ") || null;
    const emailLocal = email.split("@")[0]?.trim() || null;
    const fullName = fromNames ?? emailLocal;

    await this.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        email,
        name: fullName,
        firstName: trimmedFirst,
        lastName: trimmedLast,
        emailVerified: new Date(),
        designation: designation ?? null,
        phone: phone ?? null,
        orgDepartmentId: departmentId ?? null,
        branchId: branchId ?? null,
        userStatus: "active",
        activatedAt: new Date(),
        isActive: true,
      });
      const inserted = await tx
        .insert(organizationMembers)
        .values({ userId, orgId, role })
        .onConflictDoNothing()
        .returning({ id: organizationMembers.id });
      const membershipId = inserted[0]?.id;
      if (membershipId !== undefined) {
        await syncStructuralRoleAssignment(tx, orgId, membershipId, role);
      }
      await syncOrgUnitPlacement(tx, orgId, userId, {
        DEPARTMENT: departmentId ?? null,
        BRANCH: branchId ?? null,
      });
    });

    this.audit.log({
      action: "user.created",
      userId: actorUserId,
      orgId,
      targetId: userId,
      targetType: "user",
      actorUserId,
      resourceType: "user",
      resourceId: userId,
      metadata: { email, role },
    });

    return { userId, created: true };
  }

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

    if (role) conditions.push(eq(organizationMembers.role, role));
    if (departmentId !== undefined) conditions.push(eq(users.orgDepartmentId, departmentId));
    if (branchId !== undefined) conditions.push(eq(users.branchId, branchId));
    if (teamId !== undefined) {
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${orgUnitMembers}
          INNER JOIN ${orgUnits} ON ${orgUnitMembers.orgUnitId} = ${orgUnits.id}
          WHERE ${orgUnitMembers.userId} = ${users.id}
            AND ${orgUnitMembers.orgId} = ${orgId}
            AND ${orgUnits.id} = ${teamId}
            AND ${orgUnits.kind} = 'TEAM'
            AND ${orgUnits.orgId} = ${orgId}
        )`,
      );
    }
    if (managerUserId !== undefined) conditions.push(eq(users.reportingTo, managerUserId));

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

    const teamsSubquery = this.db
      .select({
        userId: projectTeamMembers.userId,
        teamNames: sql<string>`string_agg(${projectTeams.name}, ',' ORDER BY ${projectTeams.name})`.as("team_names"),
      })
      .from(projectTeamMembers)
      .innerJoin(projectTeams, eq(projectTeamMembers.teamId, projectTeams.id))
      .where(eq(projectTeamMembers.orgId, orgId))
      .groupBy(projectTeamMembers.userId)
      .as("user_teams");

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
          isOwner: organizationMembers.isOwner,
          isActive: users.isActive,
          emailVerified: users.emailVerified,
          departmentId: users.orgDepartmentId,
          branchId: users.branchId,
          designation: users.designation,
          phone: users.phone,
          createdAt: users.createdAt,
          joinedAt: organizationMembers.joinedAt,
          lastSeenAt: sql<Date | null>`(
            SELECT MAX(${userSessions.lastActive})
            FROM ${userSessions}
            WHERE ${userSessions.userId} = ${users.id}
              AND ${userSessions.isRevoked} = false
          )`.as("last_seen_at"),
          teamNames: teamsSubquery.teamNames,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .leftJoin(teamsSubquery, eq(teamsSubquery.userId, users.id))
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
      data: data.map((row) => ({
        ...row,
        lastSeenAt: row.lastSeenAt ?? null,
        teams: row.teamNames ? row.teamNames.split(",") : [],
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getUser(orgId: string, userId: string) {
    const rows = await this.db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        emailVerified: users.emailVerified,
        firstName: users.firstName,
        lastName: users.lastName,
        image: users.image,
        role: organizationMembers.role,
        isOwner: organizationMembers.isOwner,
        departmentId: users.orgDepartmentId,
        designation: users.designation,
        phone: users.phone,
        whatsappNumber: users.whatsappNumber,
        whatsappSameAsPhone: users.whatsappSameAsPhone,
        employeeId: users.employeeId,
        isActive: users.isActive,
        userStatus: users.userStatus,
        reportingTo: users.reportingTo,
        team: sql<string | null>`(
          SELECT ${orgUnitMembers.orgUnitId}
          FROM ${orgUnitMembers}
          INNER JOIN ${orgUnits} ON ${orgUnitMembers.orgUnitId} = ${orgUnits.id}
          WHERE ${orgUnitMembers.userId} = ${users.id}
            AND ${orgUnitMembers.orgId} = ${orgId}
            AND ${orgUnits.kind} = 'TEAM'
          LIMIT 1
        )`,
        branchId: users.branchId,
        emergencyContact: users.emergencyContact,
        bio: users.bio,
        linkedinUrl: users.linkedinUrl,
        twitterUrl: users.twitterUrl,
        githubUrl: users.githubUrl,
        websiteUrl: users.websiteUrl,
        totpEnabled: users.totpEnabled,
        joiningDate: users.joiningDate,
        dateOfBirth: users.dateOfBirth,
        gender: users.gender,
        onboardingDocStatus: users.onboardingDocStatus,
        onboardingCompletedAt: users.onboardingCompletedAt,
        invitedAt: users.invitedAt,
        activatedAt: users.activatedAt,
        archivedAt: users.archivedAt,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
        isProfilePictureRequired: users.isProfilePictureRequired,
        memberRole: organizationMembers.role,
        joinedAt: organizationMembers.joinedAt,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
      .limit(1);

    if (rows.length === 0) throw new NotFoundException("User not found in this organization");
    return rows[0]!;
  }

  private assertMayGrantRole(orgId: string, actor: InviteActor, role: string): Promise<void> {
    return assertMayGrantRole(this.access, orgId, actor, role);
  }

  async updateUser(orgId: string, userId: string, data: UpdateUserInput, actor: InviteActor) {
    const actorUserId = actor.userId;
    await this.getUser(orgId, userId);

    const updateData: Record<string, unknown> = {};
    if (data.firstName !== undefined) updateData.firstName = data.firstName;
    if (data.lastName !== undefined) updateData.lastName = data.lastName;
    if (data.firstName !== undefined || data.lastName !== undefined) {
      const user = await this.db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { firstName: true, lastName: true },
      });
      const first = data.firstName ?? user?.firstName ?? "";
      const last = data.lastName ?? user?.lastName ?? "";
      updateData.name = `${first} ${last}`.trim();
    }
    if (data.designation !== undefined) updateData.designation = data.designation;
    if (data.phone !== undefined) updateData.phone = data.phone;
    if (data.departmentId !== undefined) updateData.orgDepartmentId = data.departmentId;
    if (data.bio !== undefined) updateData.bio = data.bio;
    if (data.linkedinUrl !== undefined) updateData.linkedinUrl = data.linkedinUrl || null;
    if (data.twitterUrl !== undefined) updateData.twitterUrl = data.twitterUrl || null;
    if (data.githubUrl !== undefined) updateData.githubUrl = data.githubUrl || null;
    if (data.websiteUrl !== undefined) updateData.websiteUrl = data.websiteUrl || null;
    if (data.reportingTo !== undefined) updateData.reportingTo = data.reportingTo;
    if (data.emergencyContact !== undefined) updateData.emergencyContact = data.emergencyContact;

    const hasUserUpdates = Object.keys(updateData).length > 0;
    const hasPlacementUpdates = data.departmentId !== undefined || data.teamId !== undefined;

    if (hasUserUpdates || hasPlacementUpdates) {
      await this.db.transaction(async (tx) => {
        if (hasUserUpdates) {
          await tx.update(users).set(updateData).where(eq(users.id, userId));
        }
        await syncOrgUnitPlacement(tx, orgId, userId, {
          DEPARTMENT: data.departmentId,
          TEAM: data.teamId,
        });
      });
    }

    if (data.role !== undefined) {
      const nextRole = data.role;
      await this.assertMayGrantRole(orgId, actor, nextRole);
      await this.db.transaction(async (tx) => {
        await assertTargetNotOwner(tx, orgId, userId);
        const [member] = await tx
          .update(organizationMembers)
          .set({ role: nextRole })
          .where(
            and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)),
          )
          .returning({ id: organizationMembers.id });
        if (member) {
          await syncStructuralRoleAssignment(tx, orgId, member.id, nextRole);
        }
      });
    }

    this.audit.log({
      action: "user.updated",
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

  async updateUserStatus(
    orgId: string,
    userId: string,
    status: "active" | "suspended" | "archived",
    actorUserId: string,
    reason?: string,
  ) {
    const user = await this.getUser(orgId, userId);

    if (status !== "active") {
      await assertOwnerNotTargeted(this.db, orgId, userId, status);
    }

    if (!user.isActive && status !== "active") {
      const lastStatusEvent = await this.db
        .select({ action: auditLogs.action })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.orgId, orgId),
            eq(auditLogs.targetId, userId),
            or(
              eq(auditLogs.action, "user.status.suspended"),
              eq(auditLogs.action, "user.status.archived"),
            )!,
          ),
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(1);

      const currentState =
        lastStatusEvent[0]?.action === "user.status.archived" ? "archived" : "suspended";

      if (currentState === "archived" && status === "suspended") {
        throw new BadRequestException("Cannot suspend an archived user. Restore the user first.");
      }
    }

    const userUpdate: Record<string, unknown> = {
      isActive: status === "active",
      userStatus: status,
    };
    if (status === "active") userUpdate.activatedAt = new Date();
    if (status === "archived") userUpdate.archivedAt = new Date();

    await this.db.transaction(async (tx) => {
      if (status !== "active") {
        const [member] = await tx
          .select({ id: organizationMembers.id })
          .from(organizationMembers)
          .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
          .limit(1);
        if (member) {
          await assertNotModuleOwner(tx, orgId, member.id);
        }
      }

      await tx.update(users).set(userUpdate).where(eq(users.id, userId));

      if (status === "active") {
        await tx
          .update(organizationMembers)
          .set({ status: "ACTIVE", activatedAt: new Date(), suspendedAt: null })
          .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
      } else {
        await tx
          .update(organizationMembers)
          .set({ status: "SUSPENDED", suspendedAt: new Date() })
          .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
      }

      await bumpPermissionsVersion(tx, orgId);
    });

    bustMembershipStatusCache(userId, orgId);
    if (status !== "active") {
      await this.sessions.revokeAllForUser(userId);
    }

    this.audit.log({
      action: `user.status.${status}`,
      userId: actorUserId,
      orgId,
      targetId: userId,
      targetType: "user",
      actorUserId,
      resourceType: "user",
      resourceId: userId,
      metadata: { status, reason },
    });

    return { success: true };
  }

  async deleteUser(orgId: string, userId: string, actorUserId: string) {
    await this.getUser(orgId, userId);

    const PG_FK_VIOLATION = "23503";
    try {
      await this.db.transaction(async (tx) => {
        const [member] = await tx
          .select({ isOwner: organizationMembers.isOwner, id: organizationMembers.id })
          .from(organizationMembers)
          .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
          .for("update")
          .limit(1);

        if (!member) throw new NotFoundException("User not found in this organization");
        if (member.isOwner) {
          throw new BadRequestException(
            "The organization owner cannot be deleted. Transfer ownership to another member first.",
          );
        }

        await assertNotModuleOwner(tx, orgId, member.id);

        await tx
          .update(users)
          .set({ isActive: false, userStatus: "deleted", deletedAt: new Date() })
          .where(eq(users.id, userId));

        await tx
          .delete(organizationMembers)
          .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));

        await bumpPermissionsVersion(tx, orgId);
      });
    } catch (err) {
      if (err instanceof BadRequestException || err instanceof NotFoundException) throw err;
      if ((err as { code?: string }).code === PG_FK_VIOLATION) {
        throw new BadRequestException(
          "Cannot delete a member who owns a module. Transfer module ownership first.",
        );
      }
      throw err;
    }

    bustMembershipStatusCache(userId, orgId);
    await this.sessions.revokeAllForUser(userId);

    this.audit.log({
      action: "user.deleted",
      userId: actorUserId,
      orgId,
      targetId: userId,
      targetType: "user",
      actorUserId,
      resourceType: "user",
      resourceId: userId,
    });

    return { success: true };
  }
}
