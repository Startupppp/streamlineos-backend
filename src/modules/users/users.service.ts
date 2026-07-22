import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, count, desc, eq, ilike, max, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  auditLogs,
  organizationMembers,
  projectTeamMembers,
  projectTeams,
  userSessions,
  users,
} from "../../db/schema";
import { AuditService } from "../../common/audit/audit.service";
import { InvitationsService } from "../organization/invitations.service";
import type {
  CreateUserInput,
  ListUsersInput,
  UpdateUserInput,
} from "./dto/users.schemas";

@Injectable()
export class UsersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly invitationsSvc: InvitationsService,
  ) {}

  async createUser(orgId: string, input: CreateUserInput, actorUserId: string) {
    const { email, firstName, lastName, role, designation, phone, departmentId, branchId, sendInvite } = input;

    if (sendInvite) {
      return this.invitationsSvc.invite(orgId, actorUserId, email, role);
    }

    const existing = await this.db.query.users.findFirst({ where: eq(users.email, email) });
    if (existing) {
      const membership = await this.db.query.organizationMembers.findFirst({
        where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, existing.id)),
      });
      if (membership) throw new ConflictException("User is already a member of this organization");
      await this.db.insert(organizationMembers).values({ userId: existing.id, orgId, role }).onConflictDoNothing();
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
        departmentId: departmentId ?? null,
        branchId: branchId ?? null,
        userStatus: "active",
        activatedAt: new Date(),
        isActive: true,
      });
      await tx.insert(organizationMembers).values({ userId, orgId, role }).onConflictDoNothing();
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
    if (departmentId !== undefined) conditions.push(eq(users.departmentId, departmentId));
    if (branchId !== undefined) conditions.push(eq(users.branchId, branchId));
    if (teamId !== undefined) conditions.push(eq(users.team, teamId));
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

    const lastSeenSubquery = this.db
      .select({ userId: userSessions.userId, lastSeenAt: max(userSessions.lastActive).as("last_seen_at") })
      .from(userSessions)
      .where(eq(userSessions.isRevoked, false))
      .groupBy(userSessions.userId)
      .as("last_seen");

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
          isActive: users.isActive,
          emailVerified: users.emailVerified,
          departmentId: users.departmentId,
          branchId: users.branchId,
          designation: users.designation,
          phone: users.phone,
          createdAt: users.createdAt,
          joinedAt: organizationMembers.joinedAt,
          lastSeenAt: lastSeenSubquery.lastSeenAt,
          teamNames: teamsSubquery.teamNames,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .leftJoin(lastSeenSubquery, eq(lastSeenSubquery.userId, users.id))
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

    const update: Record<string, unknown> = {
      isActive: status === "active",
      userStatus: status,
    };
    if (status === "active") update.activatedAt = new Date();
    if (status === "archived") update.archivedAt = new Date();

    await this.db.update(users).set(update).where(eq(users.id, userId));

    if (status === "suspended") {
      await this.db
        .update(userSessions)
        .set({ isRevoked: true })
        .where(and(eq(userSessions.userId, userId), eq(userSessions.isRevoked, false)));
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

    await this.db
      .update(users)
      .set({ isActive: false, userStatus: "deleted", deletedAt: new Date() })
      .where(eq(users.id, userId));

    await this.db
      .update(userSessions)
      .set({ isRevoked: true })
      .where(and(eq(userSessions.userId, userId), eq(userSessions.isRevoked, false)));

    await this.db
      .delete(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));

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
