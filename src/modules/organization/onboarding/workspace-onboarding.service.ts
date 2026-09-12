import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { orgUnits, organizations } from "../../../db/schema";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { OrgHierarchyCacheService } from "../../../common/cache/org-hierarchy-cache.service";
import type { GenerateWorkspaceResponse } from "./dto/workspace-onboarding.schemas";

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

export function hasStructureTemplate(industry: string | null | undefined): boolean {
  if (!industry) return false;
  return INDUSTRY_TEMPLATES[normalizeIndustrySlug(industry)] !== undefined;
}

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
    private readonly hierarchyCache: OrgHierarchyCacheService,
  ) {}

  async generateWorkspace(
    orgId: string,
    industry: string,
    enabledModules?: string[],
  ): Promise<GenerateWorkspaceResponse> {
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
        .select({ id: orgUnits.id })
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
      }

      const deptNames = [...structure.keys()];
      const allDeptCodes = deptNames.map(deptCode);

      const existingDepts = await tx
        .select({ id: orgUnits.id, code: orgUnits.code })
        .from(orgUnits)
        .where(and(eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "DEPARTMENT"), inArray(orgUnits.code, allDeptCodes), isNull(orgUnits.deletedAt)));
      const existingDeptByCode = new Map(existingDepts.map((d) => [d.code, d]));

      const deptsToInsert = deptNames
        .filter((n) => !existingDeptByCode.has(deptCode(n)))
        .map((n) => ({ id: randomUUID(), orgId, kind: "DEPARTMENT" as const, name: n, code: deptCode(n), parentId: branchId }));

      let insertedDepts: Array<{ id: string; name: string }> = [];
      if (deptsToInsert.length > 0) {
        insertedDepts = await tx
          .insert(orgUnits)
          .values(deptsToInsert)
          .returning({ id: orgUnits.id, name: orgUnits.name });
        createdDepartments = insertedDepts.length;
      }

      const deptIdByName = new Map<string, string>();
      for (const n of deptNames) {
        const existing = existingDeptByCode.get(deptCode(n));
        if (existing) deptIdByName.set(n, existing.id);
      }
      for (const d of insertedDepts) deptIdByName.set(d.name, d.id);

      const allTeamNamesByDept = [...structure.entries()].map(([dept, ts]) => ({ dept, teams: [...ts] }));
      const allExpectedTeamCodes = allTeamNamesByDept.flatMap(({ dept: deptName, teams }) =>
        teams.map((_, i) => {
          const suffix = i === 0 ? "" : String(i + 1);
          return `${teamCode(deptName)}${suffix}`;
        }),
      );

      const existingTeams = allExpectedTeamCodes.length > 0
        ? await tx
            .select({ id: orgUnits.id, code: orgUnits.code })
            .from(orgUnits)
            .where(and(eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "TEAM"), inArray(orgUnits.code, allExpectedTeamCodes), isNull(orgUnits.deletedAt)))
        : [];
      const existingTeamByCode = new Map(existingTeams.map((t) => [t.code, t]));

      const teamsToInsert: Array<{ id: string; orgId: string; kind: "TEAM"; name: string; code: string; parentId: string | undefined }> = [];
      for (const { dept: deptName, teams: teamNames } of allTeamNamesByDept) {
        const departmentId = deptIdByName.get(deptName);
        teamNames.forEach((teamName, teamIndex) => {
          const suffix = teamIndex === 0 ? "" : String(teamIndex + 1);
          const tCode = `${teamCode(deptName)}${suffix}`;
          if (!existingTeamByCode.has(tCode))
            teamsToInsert.push({ id: randomUUID(), orgId, kind: "TEAM", name: teamName, code: tCode, parentId: departmentId });
        });
      }

      if (teamsToInsert.length > 0) {
        await tx.insert(orgUnits).values(teamsToInsert);
        createdTeams = teamsToInsert.length;
      }
    }, { orgId });

    await this.hierarchyCache.invalidateAfterMutation(orgId);

    return {
      businessUnits: createdBusinessUnits,
      branches: createdBranches,
      departments: createdDepartments,
      teams: createdTeams,
    };
  }

}
