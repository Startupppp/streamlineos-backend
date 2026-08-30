import { NotFoundException } from "@nestjs/common";
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import {
  hrEmployments,
  hrPeople,
  organizationMembers,
  orgUnitMembers,
  orgUnits,
  projectTeamMembers,
  projectTeams,
  userSessions,
  users,
} from "../../db/schema";
import { membershipStatusToUserStatus } from "../organization/core/org-membership.service";
import type { ListUsersInput } from "./dto/users.schemas";
import { EmploymentFactsService } from "../directory/employment-facts.service";
import { livePersonOfUser, primaryEmploymentOfPerson } from "../directory/employment-query";

export class OrganizationUsersReader {
  constructor(
    private readonly database: Db,
    private readonly employment: EmploymentFactsService,
  ) {}

  async listUsers(orgId: string, params: ListUsersInput) {
    const {
      page,
      limit,
      search,
      status,
      role,
      departmentId,
      branchId,
      teamId,
      managerUserId,
      sortBy,
      sortOrder,
    } = params;
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
    if (departmentId !== undefined)
      conditions.push(eq(hrEmployments.departmentId, departmentId));
    if (branchId !== undefined) conditions.push(eq(hrEmployments.locationId, branchId));
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
    if (managerUserId !== undefined) {
      const directReportIds = await this.employment.getDirectReportUserIds(orgId, managerUserId);
      conditions.push(
        directReportIds.length > 0
          ? inArray(organizationMembers.userId, directReportIds)
          : sql<boolean>`FALSE`,
      );
    }

    if (status === "active") {
      conditions.push(
        or(
          eq(organizationMembers.status, "ACTIVE"),
          eq(organizationMembers.status, "INVITED"),
        )!,
      );
    } else if (status === "suspended") {
      conditions.push(eq(organizationMembers.status, "SUSPENDED"));
    } else if (status === "archived") {
      conditions.push(eq(organizationMembers.status, "LEFT"));
    }

    const sortDir = sortOrder === "asc" ? asc : desc;
    const sortExpr =
      sortBy === "name"
        ? sortDir(users.name)
        : sortBy === "status"
          ? sortDir(organizationMembers.status)
          : sortDir(organizationMembers.joinedAt);

    const teamsSubquery = this.database
      .select({
        userId: projectTeamMembers.userId,
        teamNames:
          sql<string>`string_agg(${projectTeams.name}, ',' ORDER BY ${projectTeams.name})`.as(
            "team_names",
          ),
      })
      .from(projectTeamMembers)
      .innerJoin(projectTeams, eq(projectTeamMembers.teamId, projectTeams.id))
      .where(eq(projectTeamMembers.orgId, orgId))
      .groupBy(projectTeamMembers.userId)
      .as("user_teams");

    const [data, countResult] = await Promise.all([
      this.database
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          firstName: users.firstName,
          lastName: users.lastName,
          image: users.image,
          role: organizationMembers.role,
          isOwner: organizationMembers.isOwner,
          membershipStatus: organizationMembers.status,
          membershipLeftAt: organizationMembers.leftAt,
          emailVerified: users.emailVerified,
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
        .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
        .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
        .leftJoin(teamsSubquery, eq(teamsSubquery.userId, users.id))
        .where(and(...conditions))
        .orderBy(sortExpr)
        .limit(limit)
        .offset(offset),
      this.database
        .select({ total: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
        .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
        .where(and(...conditions)),
    ]);

    const total = countResult[0]?.total ?? 0;
    const factsMap = await this.employment.getFactsBatch(orgId, data.map((r) => r.id));

    return {
      data: data.map((row) => {
        const { membershipStatus, membershipLeftAt, teamNames, ...rest } = row;
        const userStatus = membershipStatusToUserStatus(membershipStatus);
        const facts = factsMap.get(row.id);
        return {
          ...rest,
          departmentId: facts?.departmentId ?? null,
          branchId: facts?.locationId ?? null,
          designation: facts?.designation ?? null,
          isActive: userStatus === "active",
          userStatus,
          archivedAt: userStatus === "archived" ? membershipLeftAt : null,
          lastSeenAt: row.lastSeenAt ?? null,
          teams: teamNames ? teamNames.split(",") : [],
        };
      }),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getUser(orgId: string, userId: string) {
    const rows = await this.database
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
        phone: users.phone,
        whatsappNumber: users.whatsappNumber,
        whatsappSameAsPhone: users.whatsappSameAsPhone,
        membershipStatus: organizationMembers.status,
        membershipLeftAt: organizationMembers.leftAt,
        team: sql<string | null>`(
          SELECT ${orgUnitMembers.orgUnitId}
          FROM ${orgUnitMembers}
          INNER JOIN ${orgUnits} ON ${orgUnitMembers.orgUnitId} = ${orgUnits.id}
          WHERE ${orgUnitMembers.userId} = ${users.id}
            AND ${orgUnitMembers.orgId} = ${orgId}
            AND ${orgUnits.kind} = 'TEAM'
          LIMIT 1
        )`,
        emergencyContact: users.emergencyContact,
        bio: users.bio,
        linkedinUrl: users.linkedinUrl,
        twitterUrl: users.twitterUrl,
        githubUrl: users.githubUrl,
        websiteUrl: users.websiteUrl,
        totpEnabled: users.totpEnabled,
        dateOfBirth: users.dateOfBirth,
        gender: users.gender,
        onboardingDocStatus: users.onboardingDocStatus,
        onboardingCompletedAt: users.onboardingCompletedAt,
        invitedAt: users.invitedAt,
        activatedAt: users.activatedAt,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
        isProfilePictureRequired: users.isProfilePictureRequired,
        memberRole: organizationMembers.role,
        joinedAt: organizationMembers.joinedAt,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, userId),
        ),
      )
      .limit(1);

    if (rows.length === 0)
      throw new NotFoundException("User not found in this organization");
    const row = rows[0]!;
    const { membershipStatus, membershipLeftAt, ...rest } = row;
    const userStatus = membershipStatusToUserStatus(membershipStatus);
    const facts = await this.employment.getFacts(orgId, userId);
    return {
      ...rest,
      departmentId: facts.departmentId,
      designation: facts.designation,
      employeeId: facts.employeeNumber,
      reportingTo: facts.managerUserId,
      joiningDate: facts.joiningDate,
      branchId: facts.locationId,
      isActive: userStatus === "active",
      userStatus,
      archivedAt: userStatus === "archived" ? membershipLeftAt : null,
    };
  }
}
