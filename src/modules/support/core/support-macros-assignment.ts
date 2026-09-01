import { and, count, eq, inArray, or } from "drizzle-orm";
import {
  organizationMembers,
  supportAgentAvailability,
  supportAgentSkills,
  supportTickets,
} from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";

async function loadBalance(db: Db, orgId: string, candidates: string[]): Promise<string> {
  const workloads = await db
    .select({ assigneeId: organizationMembers.userId, cnt: count() })
    .from(supportTickets)
    .leftJoin(
      organizationMembers,
      and(
        eq(organizationMembers.orgId, supportTickets.orgId),
        eq(organizationMembers.id, supportTickets.assigneeMembershipId),
      ),
    )
    .where(
      and(
        eq(supportTickets.orgId, orgId),
        inArray(organizationMembers.userId, candidates),
        or(eq(supportTickets.status, "OPEN"), eq(supportTickets.status, "IN_PROGRESS")),
      ),
    )
    .groupBy(organizationMembers.userId);

  const workloadMap = new Map(workloads.map((w) => [w.assigneeId, Number(w.cnt)]));
  return candidates.reduce((least, candidate) =>
    (workloadMap.get(candidate) ?? 0) < (workloadMap.get(least) ?? 0) ? candidate : least,
  );
}

async function filterBySkills(
  db: Db,
  orgId: string,
  candidates: string[],
  requiredSkills: string[],
): Promise<string[]> {
  if (requiredSkills.length === 0) return candidates;

  const rows = await db
    .select({ userId: organizationMembers.userId, skill: supportAgentSkills.skill })
    .from(supportAgentSkills)
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.orgId, supportAgentSkills.orgId),
        eq(organizationMembers.id, supportAgentSkills.userMembershipId),
      ),
    )
    .where(
      and(
        eq(supportAgentSkills.orgId, orgId),
        inArray(organizationMembers.userId, candidates),
        inArray(supportAgentSkills.skill, requiredSkills),
      ),
    );

  const skillsByUser = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = skillsByUser.get(row.userId) ?? new Set<string>();
    set.add(row.skill);
    skillsByUser.set(row.userId, set);
  }

  const qualified = candidates.filter((candidate) =>
    requiredSkills.every((skill) => skillsByUser.get(candidate)?.has(skill)),
  );
  return qualified.length > 0 ? qualified : candidates;
}

async function filterByAvailability(
  db: Db,
  orgId: string,
  candidates: string[],
): Promise<string[]> {
  const rows = await db
    .select({ userId: organizationMembers.userId, isAvailable: supportAgentAvailability.isAvailable })
    .from(supportAgentAvailability)
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.orgId, supportAgentAvailability.orgId),
        eq(organizationMembers.id, supportAgentAvailability.userMembershipId),
      ),
    )
    .where(
      and(
        eq(supportAgentAvailability.orgId, orgId),
        inArray(organizationMembers.userId, candidates),
      ),
    );

  const availabilityByUser = new Map(rows.map((row) => [row.userId, row.isAvailable]));
  const available = candidates.filter((candidate) => availabilityByUser.get(candidate) ?? true);
  return available.length > 0 ? available : candidates;
}

export async function resolveAssignmentModeAgent(
  db: Db,
  orgId: string,
  mode: string,
  candidates: string[],
  requiredSkills: string[],
): Promise<string> {
  if (mode === "load_balanced") return loadBalance(db, orgId, candidates);

  if (mode === "skill_based") {
    const qualified = await filterBySkills(db, orgId, candidates, requiredSkills);
    return loadBalance(db, orgId, qualified);
  }

  if (mode === "availability_based") {
    const available = await filterByAvailability(db, orgId, candidates);
    return loadBalance(db, orgId, available);
  }

  // round_robin: use total ticket count for the org as a stateless rotating cursor.
  const [totalResult] = await db
    .select({ cnt: count() })
    .from(supportTickets)
    .where(eq(supportTickets.orgId, orgId));
  const cursor = Number(totalResult?.cnt ?? 0) % candidates.length;
  return candidates[cursor];
}
