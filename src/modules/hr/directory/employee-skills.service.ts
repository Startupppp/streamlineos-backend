import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gt, ilike, inArray, or, sql } from "drizzle-orm";
import {
  employeeSkills,
  hrEmployments,
  hrPeople,
  orgUnitMembers,
  orgUnits,
  organizationMembers,
  terminations,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type {
  FindExpertInput,
  SkillsMatrixQueryInput,
} from "./dto/hr-directory.schemas";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import {
  decodeEmployeeListCursor,
  encodeEmployeeListCursor,
} from "./employee-list-cursor";
import {
  livePersonOfUser,
  primaryEmploymentOfPerson,
} from "../../directory/employment-query";
import { listBoundedEmployeeSkills } from "./employee-skills-page-query";

export interface ExpertResult {
  userId: string;
  name: string | null;
  image: string | null;
  designation: string | null;
  department: string | null;
  role: string | null;
  skills: { name: string; level: number }[];
  matchedSkill: string;
  matchedLevel: number;
}

@Injectable()
export class EmployeeSkillsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async findExpert(
    orgId: string,
    actorUserId: string,
    query: FindExpertInput,
    scope: DataScope,
  ): Promise<ExpertResult[]> {
    const search = query.skill.trim().toLowerCase();
    const normalizedSearch = search.replace(/[.\s-]+/g, "");
    const normalizedSkillName = sql<string>`lower(regexp_replace(${employeeSkills.skillName}, '[.\\s-]+', '', 'g'))`;
    const skillConditions = [
      eq(sql<string>`lower(${employeeSkills.skillName})`, search),
      eq(normalizedSkillName, normalizedSearch),
      ilike(employeeSkills.skillName, `${search}%`),
    ];
    const matchedLevel = sql<number>`max(coalesce(${employeeSkills.level}, 1))::int`;
    const matchedSkill = sql<string>`(array_agg(${employeeSkills.skillName} order by coalesce(${employeeSkills.level}, 1) desc, ${employeeSkills.skillName} asc))[1]`;
    const department = sql<string | null>`min(${orgUnits.name})`;

    const conditions = [
      eq(organizationMembers.orgId, orgId),
      eq(organizationMembers.status, "ACTIVE"),
      eq(users.isActive, true),
      eq(employeeSkills.orgId, orgId),
      or(...skillConditions),
      isNull(terminations.id),
      applyScope(scope, orgId, actorUserId, {
        ownerColumn: organizationMembers.userId,
      }),
    ];
    if (query.role) conditions.push(eq(organizationMembers.role, query.role));
    if (query.department) conditions.push(ilike(orgUnits.name, `${query.department}%`));

    const memberRows = await this.db
      .select({
        userId: users.id,
        name: users.name,
        image: users.image,
        designation: hrEmployments.designation,
        role: organizationMembers.role,
        department,
        matchedSkill,
        matchedLevel,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
      .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
      .innerJoin(
        employeeSkills,
        and(
          eq(employeeSkills.orgId, organizationMembers.orgId),
          eq(employeeSkills.userId, organizationMembers.userId),
        ),
      )
      .leftJoin(
        terminations,
        and(
          eq(terminations.orgId, organizationMembers.orgId),
          eq(terminations.userId, organizationMembers.userId),
          inArray(terminations.status, ["APPROVED", "COMPLETED", "SENT"]),
        ),
      )
      .leftJoin(
        orgUnitMembers,
        and(
          eq(orgUnitMembers.orgId, organizationMembers.orgId),
          eq(orgUnitMembers.userId, organizationMembers.userId),
        ),
      )
      .leftJoin(
        orgUnits,
        and(
          eq(orgUnits.orgId, organizationMembers.orgId),
          eq(orgUnits.id, orgUnitMembers.orgUnitId),
          eq(orgUnits.kind, "DEPARTMENT"),
          eq(orgUnits.status, "ACTIVE"),
        ),
      )
      .where(and(...conditions))
      .groupBy(
        users.id,
        users.name,
        users.image,
        hrEmployments.designation,
        organizationMembers.role,
      )
      .orderBy(desc(matchedLevel), asc(sql`lower(${users.name})`), asc(users.id))
      .limit(query.limit);
    if (memberRows.length === 0) return [];

    const allSkillsForUsers = await listBoundedEmployeeSkills(
      this.db,
      orgId,
      memberRows.map((member) => member.userId),
    );

    const skillsByUser = new Map<string, { name: string; level: number }[]>();
    for (const employeeSkill of allSkillsForUsers) {
      const employeeSkillList = skillsByUser.get(employeeSkill.userId) ?? [];
      employeeSkillList.push({
        name: employeeSkill.skillName,
        level: employeeSkill.level ?? 1,
      });
      skillsByUser.set(employeeSkill.userId, employeeSkillList);
    }

    return memberRows.map((member) => ({
        userId: member.userId,
        name: member.name,
        image: member.image,
        designation: member.designation,
        department: member.department,
        role: member.role,
        skills: [...(skillsByUser.get(member.userId) ?? [])].sort(
          (leftSkill, rightSkill) => rightSkill.level - leftSkill.level,
        ),
        matchedSkill: member.matchedSkill,
        matchedLevel: member.matchedLevel,
      }));
  }

  async getSkillsMatrix(
    orgId: string,
    actorUserId: string,
    scope: DataScope,
    query: SkillsMatrixQueryInput,
  ) {
    const cursor = query.cursor
      ? decodeEmployeeListCursor(query.cursor)
      : undefined;
    const normalizedName = sql<string>`lower(coalesce(${users.name}, ${users.email}, ''))`;
    const memberConditions = [
      eq(organizationMembers.orgId, orgId),
      eq(organizationMembers.status, "ACTIVE"),
      eq(users.isActive, true),
      applyScope(scope, orgId, actorUserId, {
        ownerColumn: organizationMembers.userId,
      }),
    ];
    if (cursor) {
      memberConditions.push(
        or(
          gt(normalizedName, cursor.name),
          and(
            eq(normalizedName, cursor.name),
            gt(organizationMembers.userId, cursor.employeeUserId),
          ),
        )!,
      );
    }

    const memberRows = await this.db
      .select({
        userId: organizationMembers.userId,
        cursorName: normalizedName,
        name: users.name,
        image: users.image,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .innerJoin(
        employeeSkills,
        and(
          eq(employeeSkills.orgId, organizationMembers.orgId),
          eq(employeeSkills.userId, organizationMembers.userId),
        ),
      )
      .where(and(...memberConditions))
      .groupBy(
        organizationMembers.userId,
        users.name,
        users.email,
        users.image,
      )
      .orderBy(asc(normalizedName), asc(organizationMembers.userId))
      .limit(query.limit + 1);

    const hasMore = memberRows.length > query.limit;
    const pageMembers = memberRows.slice(0, query.limit);
    const lastMember = pageMembers.at(-1);
    if (pageMembers.length === 0) {
      return {
        employees: [],
        skills: [],
        pageInfo: { limit: query.limit, hasMore: false, nextCursor: null },
      };
    }

    const pageEmployeeUserIds = pageMembers.map((member) => member.userId);
    const pageSkills = await listBoundedEmployeeSkills(
      this.db,
      orgId,
      pageEmployeeUserIds,
    );

    const skillsByEmployee = new Map<string, Map<string, number>>();
    for (const employeeSkill of pageSkills) {
      const employeeSkillMap =
        skillsByEmployee.get(employeeSkill.userId) ?? new Map<string, number>();
      employeeSkillMap.set(employeeSkill.skillName, employeeSkill.level ?? 1);
      skillsByEmployee.set(employeeSkill.userId, employeeSkillMap);
    }

    return {
      employees: pageMembers.map((member) => ({
        userId: member.userId,
        name: member.name,
        image: member.image,
        skills: Object.fromEntries(
          skillsByEmployee.get(member.userId) ?? new Map<string, number>(),
        ),
      })),
      skills: [
        ...new Set(pageSkills.map((employeeSkill) => employeeSkill.skillName)),
      ].sort((leftSkillName, rightSkillName) =>
        leftSkillName.localeCompare(rightSkillName),
      ),
      pageInfo: {
        limit: query.limit,
        hasMore,
        nextCursor:
          hasMore && lastMember
            ? encodeEmployeeListCursor({
                name: lastMember.cursorName,
                employeeUserId: lastMember.userId,
              })
            : null,
      },
    };
  }
}
