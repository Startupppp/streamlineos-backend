import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { employeeSkills } from "../../../db/schema";

const MAX_SKILLS_PER_EMPLOYEE = 100;

export interface EmployeeSkillPageRow {
  userId: string;
  skillName: string;
  level: number | null;
}

export async function listBoundedEmployeeSkills(
  db: Db,
  orgId: string,
  employeeUserIds: readonly string[],
): Promise<EmployeeSkillPageRow[]> {
  if (employeeUserIds.length === 0) return [];

  const rankedSkills = db.$with("ranked_employee_skills").as(
    db
      .select({
        userId: employeeSkills.userId,
        skillName: employeeSkills.skillName,
        level: employeeSkills.level,
        skillRank:
          sql<number>`row_number() over (partition by ${employeeSkills.userId} order by lower(${employeeSkills.skillName}), ${employeeSkills.skillName})`.as(
            "skill_rank",
          ),
      })
      .from(employeeSkills)
      .where(
        and(
          eq(employeeSkills.orgId, orgId),
          inArray(employeeSkills.userId, [...employeeUserIds]),
        ),
      )
      .limit(Math.max(1, employeeUserIds.length * MAX_SKILLS_PER_EMPLOYEE)),
  );

  return db
    .with(rankedSkills)
    .select({
      userId: rankedSkills.userId,
      skillName: rankedSkills.skillName,
      level: rankedSkills.level,
    })
    .from(rankedSkills)
    .where(lte(rankedSkills.skillRank, MAX_SKILLS_PER_EMPLOYEE))
    .orderBy(
      asc(rankedSkills.userId),
      asc(sql`lower(${rankedSkills.skillName})`),
      asc(rankedSkills.skillName),
    )
    .limit(Math.max(1, employeeUserIds.length * MAX_SKILLS_PER_EMPLOYEE));
}
