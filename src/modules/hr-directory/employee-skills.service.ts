import { Inject, Injectable } from "@nestjs/common";
import { SQL, and, eq, ilike, inArray, notInArray, or } from "drizzle-orm";
import {
  departmentMembers,
  departments,
  employeeSkills,
  organizationMembers,
  terminations,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import type { FindExpertInput } from "./dto/hr-directory.schemas";

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

function buildVariants(skill: string): string[] {
  const base = skill.trim().toLowerCase();
  const normalized = base.replace(/[.\s-]+/g, "");
  const withDots = base.replace(/\s+/g, ".");
  const variants = new Set([base, normalized, withDots]);
  return Array.from(variants);
}

@Injectable()
export class EmployeeSkillsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async findExpert(orgId: string, query: FindExpertInput): Promise<ExpertResult[]> {
    const terminatedUserIds = await this.db
      .select({ userId: terminations.userId })
      .from(terminations)
      .where(
        and(
          eq(terminations.orgId, orgId),
          inArray(terminations.status, ["APPROVED", "COMPLETED", "SENT"]),
        ),
      )
      .limit(5000);

    const excludedIds = terminatedUserIds.map((t) => t.userId);

    const activeMembers = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(users.isActive, true),
          excludedIds.length > 0 ? notInArray(organizationMembers.userId, excludedIds) : undefined,
        ),
      )
      .limit(2000);

    if (activeMembers.length === 0) return [];

    const activeMemberIds = activeMembers.map((m) => m.userId);

    const variants = buildVariants(query.skill);
    const skillConditions = variants.map((v) => ilike(employeeSkills.skillName, `%${v}%`));

    const matchingSkillRows = await this.db
      .select({ userId: employeeSkills.userId })
      .from(employeeSkills)
      .where(
        and(
          eq(employeeSkills.orgId, orgId),
          inArray(employeeSkills.userId, activeMemberIds),
          or(...skillConditions),
        ),
      );

    if (matchingSkillRows.length === 0) return [];

    const userIdSet = [...new Set(matchingSkillRows.map((r) => r.userId))];

    const userConditions: SQL[] = [
      eq(organizationMembers.orgId, orgId),
      inArray(organizationMembers.userId, userIdSet),
    ];
    if (query.role) userConditions.push(eq(organizationMembers.role, query.role));

    const memberRows = await this.db
      .select({
        userId: users.id,
        name: users.name,
        image: users.image,
        designation: users.designation,
        role: organizationMembers.role,
        departmentId: users.departmentId,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(...userConditions))
      .limit(query.limit);

    const memberMap = new Map(memberRows.map((m) => [m.userId, m]));

    let filteredUserIds = [...memberMap.keys()];

    if (query.department) {
      const deptRows = await this.db
        .select({ id: departments.id, name: departments.name })
        .from(departments)
        .where(and(eq(departments.orgId, orgId), ilike(departments.name, `%${query.department}%`)));

      if (deptRows.length === 0) return [];

      const deptIdValues = deptRows.map((d) => d.id);

      const deptMemberRows = await this.db
        .select({ userId: departmentMembers.userId })
        .from(departmentMembers)
        .where(inArray(departmentMembers.departmentId, deptIdValues));

      const deptUserSet = new Set(deptMemberRows.map((d) => d.userId));
      filteredUserIds = filteredUserIds.filter((id) => deptUserSet.has(id));

      if (filteredUserIds.length === 0) return [];
    }

    const allSkillsForUsers = await this.db
      .select({ userId: employeeSkills.userId, skillName: employeeSkills.skillName, level: employeeSkills.level })
      .from(employeeSkills)
      .where(and(eq(employeeSkills.orgId, orgId), inArray(employeeSkills.userId, filteredUserIds)));

    const skillsByUser = new Map<string, { name: string; level: number }[]>();
    for (const s of allSkillsForUsers) {
      const list = skillsByUser.get(s.userId) ?? [];
      list.push({ name: s.skillName, level: s.level ?? 1 });
      skillsByUser.set(s.userId, list);
    }

    const lowerVariants = variants.map((v) => v.toLowerCase());

    const expertList: ExpertResult[] = [];

    for (const userId of filteredUserIds) {
      const member = memberMap.get(userId);
      if (!member) continue;

      const userSkills = skillsByUser.get(userId) ?? [];
      const matchedSkills = userSkills.filter((s) =>
        lowerVariants.some(
          (v) =>
            s.name.toLowerCase().replace(/[.\s-]+/g, "").includes(v) ||
            s.name.toLowerCase().includes(v),
        ),
      );

      if (matchedSkills.length === 0) continue;

      const bestMatch = matchedSkills.reduce(
        (best, cur) => (cur.level > best.level ? cur : best),
        matchedSkills[0],
      );

      expertList.push({
        userId,
        name: member.name,
        image: member.image,
        designation: member.designation,
        department: null,
        role: member.role,
        skills: [...userSkills].sort((a, b) => b.level - a.level),
        matchedSkill: bestMatch.name,
        matchedLevel: bestMatch.level,
      });
    }

    return expertList.sort((a, b) => b.matchedLevel - a.matchedLevel);
  }

  getSkillsMatrix(orgId: string) {
    return this.cache.cached(
      `hr:skills-matrix:${orgId}`,
      async () => {
        const allSkills = await this.db.query.employeeSkills.findMany({
          where: eq(employeeSkills.orgId, orgId),
          with: { user: { columns: { id: true, name: true, image: true } } },
        });

        const members = await this.db
          .select({
            userId: organizationMembers.userId,
            name: users.name,
            image: users.image,
          })
          .from(organizationMembers)
          .leftJoin(users, eq(users.id, organizationMembers.userId))
          .where(eq(organizationMembers.orgId, orgId))
          .limit(100);

        const skillNames = [...new Set(allSkills.map((s) => s.skillName))].sort();

        const matrixMap = new Map<string, Map<string, number>>();
        for (const skill of allSkills) {
          const userMatrix = matrixMap.get(skill.userId) ?? new Map<string, number>();
          userMatrix.set(skill.skillName, skill.level ?? 1);
          matrixMap.set(skill.userId, userMatrix);
        }

        const employeesWithSkills = members
          .filter((m) => matrixMap.has(m.userId))
          .map((m) => ({
            userId: m.userId,
            name: m.name,
            image: m.image,
            skills: Object.fromEntries(matrixMap.get(m.userId) ?? new Map<string, number>()),
          }))
          .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

        return { employees: employeesWithSkills, skills: skillNames };
      },
      CACHE_TTL.MEDIUM,
    );
  }
}
