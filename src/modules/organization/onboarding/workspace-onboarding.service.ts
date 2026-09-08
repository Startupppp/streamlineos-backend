import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { orgUnits, organizations } from "../../../db/schema";
import { ModuleChecklistService } from "../../hr/onboarding/flow/module-checklist.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { bulkUpdateFromValues } from "../../../common/db/bulk-update";
import { OrgHierarchyCacheService } from "../../../common/cache/org-hierarchy-cache.service";

const INDUSTRY_TEMPLATES: Record<string, string[]> = {
  "it-services": ["Engineering", "Product", "Operations", "HR"],
  "agency": ["Creative", "Strategy", "Client Services", "HR"],
  "retail": ["Sales", "Inventory", "Customer Service", "HR"],
  "manufacturing": ["Production", "Quality", "Supply Chain", "HR"],
  "healthcare": ["Clinical", "Administration", "Compliance", "HR"],
  "education": ["Academic", "Administration", "IT", "HR"],
  "construction": ["Projects", "Engineering", "Safety", "HR"],
  "real-estate": ["Sales", "Leasing", "Operations", "HR"],
  "restaurant": ["Kitchen", "Service", "Management", "HR"],
  "logistics": ["Operations", "Fleet", "Warehouse", "HR"],
};

const MODULE_STRUCTURE_TEMPLATES: Record<
  string,
  { department: string; team: string }[]
> = {
  crm: [
    { department: "Sales", team: "Revenue Team" },
    { department: "Marketing", team: "Growth Team" },
  ],
  hr: [{ department: "HR", team: "People Operations" }],
  build: [
    { department: "Engineering", team: "Delivery Team" },
    { department: "Product", team: "Product Team" },
  ],
  accounting: [{ department: "Finance", team: "Accounting Team" }],
  inventory: [{ department: "Inventory", team: "Inventory Operations" }],
  support: [
    { department: "Customer Service", team: "Customer Support" },
  ],
};

export function resolveStructureTemplate(
  industry: string,
  enabledModules: readonly string[] = [],
): Map<string, Set<string>> {
  const departments = INDUSTRY_TEMPLATES[normalizeIndustrySlug(industry)];
  if (!departments) {
    throw new BadRequestException(`Unknown industry: ${industry}`);
  }

  const structure = new Map<string, Set<string>>(
    departments.map((department) => [
      department,
      new Set([`${department} Team`]),
    ]),
  );
  for (const moduleKey of new Set(enabledModules)) {
    for (const item of MODULE_STRUCTURE_TEMPLATES[moduleKey] ?? []) {
      const teams = structure.get(item.department) ?? new Set<string>();
      teams.add(item.team);
      structure.set(item.department, teams);
    }
  }
  return structure;
}

function normalizeIndustrySlug(industry: string): string {
  return industry.toLowerCase().replace(/[\s_]+/g, "-");
}

function deptCode(name: string): string {
  return name.substring(0, 4).toUpperCase().replace(/\s/g, "");
}

function teamCode(deptName: string): string {
  return deptName.substring(0, 4).toUpperCase().replace(/\s/g, "") + "T";
}

function requireCreatedId(
  createdUnit: { id: string } | undefined,
  unitKind: string,
): string {
  if (!createdUnit) {
    throw new Error(`Failed to create ${unitKind}`);
  }
  return createdUnit.id;
}

@Injectable()
export class WorkspaceOnboardingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly checklists: ModuleChecklistService,
    private readonly hierarchyCache: OrgHierarchyCacheService,
  ) {}

  async generateWorkspace(
    orgId: string,
    industry: string,
    enabledModules?: string[],
  ): Promise<{
    businessUnits: number;
    branches: number;
    departments: number;
    teams: number;
  }> {
    if (enabledModules?.length) {
      await this.checklists.ensureChecklistsForModules(orgId, enabledModules);
    }
    const structure = resolveStructureTemplate(industry, enabledModules);

    const [org] = await this.db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    const orgName = org?.name ?? "HQ";

    let createdBusinessUnits = 0;
    let createdBranches = 0;
    let createdDepartments = 0;
    let createdTeams = 0;

    await runInTenantTransaction(this.db, async (tx) => {
      const [existingBu] = await tx
        .select({ id: orgUnits.id })
        .from(orgUnits)
        .where(
          and(
            eq(orgUnits.orgId, orgId),
            eq(orgUnits.kind, "BUSINESS_UNIT"),
            eq(orgUnits.code, "HQ"),
            isNull(orgUnits.deletedAt),
          ),
        )
        .limit(1);

      let businessUnitId: string | undefined = existingBu?.id;
      if (!existingBu) {
        const [insertedBu] = await tx
          .insert(orgUnits)
          .values({ id: randomUUID(), orgId, kind: "BUSINESS_UNIT", name: orgName, code: "HQ" })
          .returning({ id: orgUnits.id });
        businessUnitId = requireCreatedId(insertedBu, "business unit");
        createdBusinessUnits = 1;
      }

      const [existingBranch] = await tx
        .select({ id: orgUnits.id, parentId: orgUnits.parentId })
        .from(orgUnits)
        .where(
          and(
            eq(orgUnits.orgId, orgId),
            eq(orgUnits.kind, "BRANCH"),
            eq(orgUnits.code, "MAIN"),
            isNull(orgUnits.deletedAt),
          ),
        )
        .limit(1);

      let branchId: string | undefined = existingBranch?.id;
      if (!existingBranch) {
        const [insertedBranch] = await tx
          .insert(orgUnits)
          .values({ id: randomUUID(), orgId, kind: "BRANCH", name: "Main Office", code: "MAIN", parentId: businessUnitId })
          .returning({ id: orgUnits.id });
        branchId = requireCreatedId(insertedBranch, "branch");
        createdBranches = 1;
      } else if (existingBranch.parentId !== businessUnitId) {
        await tx
          .update(orgUnits)
          .set({ parentId: businessUnitId })
          .where(
            and(
              eq(orgUnits.id, existingBranch.id),
              eq(orgUnits.orgId, orgId),
            ),
          );
      }

      const deptNames = [...structure.keys()];
      const allTeamNamesByDept = [...structure.entries()].map(([dept, ts]) => ({ dept, teams: [...ts] }));
      const allTeamNames = allTeamNamesByDept.flatMap((d) => d.teams);

      const existingDepts = await tx
        .select({ id: orgUnits.id, name: orgUnits.name, parentId: orgUnits.parentId })
        .from(orgUnits)
        .where(and(eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "DEPARTMENT"), inArray(orgUnits.name, deptNames), isNull(orgUnits.deletedAt)));
      const existingDeptByName = new Map(existingDepts.map((d) => [d.name, d]));

      const deptsToInsert = deptNames
        .filter((n) => !existingDeptByName.has(n))
        .map((n) => ({ id: randomUUID(), orgId, kind: "DEPARTMENT" as const, name: n, code: deptCode(n), parentId: branchId }));

      let insertedDepts: Array<{ id: string; name: string }> = [];
      if (deptsToInsert.length > 0) {
        insertedDepts = await tx
          .insert(orgUnits)
          .values(deptsToInsert)
          .returning({ id: orgUnits.id, name: orgUnits.name });
        createdDepartments = insertedDepts.length;
      }

      const deptsNeedingReparent = existingDepts.filter((d) => d.parentId !== branchId).map((d) => d.id);
      if (deptsNeedingReparent.length > 0) {
        await tx
          .update(orgUnits)
          .set({ parentId: branchId })
          .where(and(eq(orgUnits.orgId, orgId), inArray(orgUnits.id, deptsNeedingReparent)));
      }

      const deptIdByName = new Map<string, string>();
      for (const d of existingDepts) deptIdByName.set(d.name, d.id);
      for (const d of insertedDepts) deptIdByName.set(d.name, d.id);

      const existingTeams = allTeamNames.length > 0
        ? await tx
            .select({ id: orgUnits.id, name: orgUnits.name, parentId: orgUnits.parentId })
            .from(orgUnits)
            .where(and(eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "TEAM"), inArray(orgUnits.name, allTeamNames), isNull(orgUnits.deletedAt)))
        : [];
      const existingTeamByName = new Map(existingTeams.map((t) => [t.name, t]));

      const teamsToInsert: Array<{ id: string; orgId: string; kind: "TEAM"; name: string; code: string; parentId: string | undefined }> = [];
      for (const { dept: deptName, teams: teamNames } of allTeamNamesByDept) {
        const departmentId = deptIdByName.get(deptName);
        let teamIndex = 0;
        for (const teamName of teamNames) {
          if (!existingTeamByName.has(teamName)) {
            const suffix = teamIndex === 0 ? "" : String(teamIndex + 1);
            teamsToInsert.push({ id: randomUUID(), orgId, kind: "TEAM", name: teamName, code: `${teamCode(deptName)}${suffix}`, parentId: departmentId });
          }
          teamIndex += 1;
        }
      }

      if (teamsToInsert.length > 0) {
        await tx.insert(orgUnits).values(teamsToInsert);
        createdTeams = teamsToInsert.length;
      }

      const teamReparents = new Map<string, string>();
      for (const { dept: deptName, teams: teamNames } of allTeamNamesByDept) {
        const departmentId = deptIdByName.get(deptName);
        if (departmentId === undefined) continue;
        for (const teamName of teamNames) {
          const existingTeam = existingTeamByName.get(teamName);
          if (existingTeam && existingTeam.parentId !== departmentId)
            teamReparents.set(existingTeam.id, departmentId);
        }
      }

      if (teamReparents.size > 0)
        await bulkUpdateFromValues(tx, {
          table: orgUnits,
          orgId,
          key: { column: "id", type: "text" },
          columns: [{ column: "parent_id", type: "text" }],
          touch: ["updated_at"],
          rows: [...teamReparents].map(([teamId, departmentId]) => ({
            key: teamId,
            values: [departmentId],
          })),
        });
    }, { orgId });

    await this.hierarchyCache.invalidateAfterMutation(orgId);

    return {
      businessUnits: createdBusinessUnits,
      branches: createdBranches,
      departments: createdDepartments,
      teams: createdTeams,
    };
  }

  async completeOnboarding(orgId: string): Promise<{ completedAt: Date }> {
    const completedAt = new Date();
    await this.db
      .update(organizations)
      .set({ onboardingCompletedAt: completedAt })
      .where(eq(organizations.id, orgId));
    return { completedAt };
  }
}
