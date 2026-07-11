import { Injectable, Inject } from "@nestjs/common";
import { eq, and, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { employeeSkills } from "../../db/schema/hr/performance";
import { hrRoleSkillRequirements } from "../../db/schema/hr/succession";
import { departmentMembers } from "../../db/schema/hr/employees";

@Injectable()
export class SkillGapService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getGaps(orgId: string, options: { employeeId?: string; departmentId?: number }) {
    let employeeIds: string[] = [];

    if (options.employeeId) {
      employeeIds = [options.employeeId];
    } else if (options.departmentId) {
      const members = await this.db
        .select({ userId: departmentMembers.userId })
        .from(departmentMembers)
        .where(eq(departmentMembers.departmentId, options.departmentId));
      employeeIds = members.map((m) => m.userId);
    }

    if (!employeeIds.length) return [];

    const [skills, requirements] = await Promise.all([
      this.db
        .select()
        .from(employeeSkills)
        .where(and(eq(employeeSkills.orgId, orgId), inArray(employeeSkills.userId, employeeIds))),
      this.db
        .select()
        .from(hrRoleSkillRequirements)
        .where(eq(hrRoleSkillRequirements.orgId, orgId)),
    ]);

    const skillMap = new Map<string, Map<string, number>>();
    for (const s of skills) {
      if (!skillMap.has(s.userId)) skillMap.set(s.userId, new Map());
      skillMap.get(s.userId)!.set(s.skillName, s.level);
    }

    return employeeIds.map((userId) => {
      const userSkills = skillMap.get(userId) ?? new Map<string, number>();
      const gaps = requirements
        .map((req) => {
          const current = userSkills.get(req.skillName) ?? 0;
          return {
            skillName: req.skillName,
            requiredLevel: req.requiredLevel,
            currentLevel: current,
            gap: Math.max(0, req.requiredLevel - current),
          };
        })
        .filter((g) => g.gap > 0);
      return { userId, gaps };
    });
  }

  async listRequirements(orgId: string) {
    return this.db
      .select()
      .from(hrRoleSkillRequirements)
      .where(eq(hrRoleSkillRequirements.orgId, orgId));
  }

  async addRequirement(
    orgId: string,
    data: { jobRoleId?: number; roleName?: string; skillName: string; requiredLevel: number },
  ) {
    const [created] = await this.db
      .insert(hrRoleSkillRequirements)
      .values({ orgId, ...data })
      .returning();
    return created;
  }

  async removeRequirement(orgId: string, id: number) {
    await this.db
      .delete(hrRoleSkillRequirements)
      .where(and(eq(hrRoleSkillRequirements.id, id), eq(hrRoleSkillRequirements.orgId, orgId)));
    return { success: true };
  }
}
