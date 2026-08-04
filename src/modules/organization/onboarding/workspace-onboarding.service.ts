import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { orgUnits, organizations } from "../../../db/schema";
import { ModuleChecklistService } from "../../hr/onboarding/flow/module-checklist.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

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

@Injectable()
export class WorkspaceOnboardingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly checklists: ModuleChecklistService,
  ) {}

  async generateWorkspace(
    orgId: string,
    industry: string,
    enabledModules?: string[],
  ): Promise<{ businessUnits: number; branches: number; departments: number; teams: number }> {
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
        .where(and(eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "BUSINESS_UNIT")))
        .limit(1);

      let buId: string | undefined = existingBu?.id;
      if (!existingBu) {
        const [insertedBu] = await tx
          .insert(orgUnits)
          .values({ id: randomUUID(), orgId, kind: "BUSINESS_UNIT", name: orgName, code: "HQ" })
          .returning({ id: orgUnits.id });
        buId = insertedBu?.id;
        createdBusinessUnits = 1;
      }

      const [existingBranch] = await tx
        .select({ id: orgUnits.id })
        .from(orgUnits)
        .where(and(eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "BRANCH")))
        .limit(1);

      let branchId: string | undefined = existingBranch?.id;
      if (!existingBranch) {
        const [insertedBranch] = await tx
          .insert(orgUnits)
          .values({ id: randomUUID(), orgId, kind: "BRANCH", name: "Main Office", code: "MAIN", parentId: buId })
          .returning({ id: orgUnits.id });
        branchId = insertedBranch?.id;
        createdBranches = 1;
      }

      for (const [deptName, teamNames] of structure) {
        const [existingDept] = await tx
          .select({ id: orgUnits.id })
          .from(orgUnits)
          .where(and(eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "DEPARTMENT"), eq(orgUnits.name, deptName)))
          .limit(1);

        let deptId: string | undefined = existingDept?.id;
        if (!existingDept) {
          const code = deptCode(deptName);
          const [insertedDept] = await tx
            .insert(orgUnits)
            .values({ id: randomUUID(), orgId, kind: "DEPARTMENT", name: deptName, code, parentId: branchId })
            .returning({ id: orgUnits.id });
          deptId = insertedDept?.id;
          createdDepartments += 1;
        }

        let teamIndex = 0;
        for (const teamName of teamNames) {
          const [existingTeam] = await tx
            .select({ id: orgUnits.id })
            .from(orgUnits)
            .where(and(eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "TEAM"), eq(orgUnits.name, teamName)))
            .limit(1);

          if (!existingTeam) {
            const suffix = teamIndex === 0 ? "" : String(teamIndex + 1);
            const code = `${teamCode(deptName)}${suffix}`;
            await tx.insert(orgUnits).values({ id: randomUUID(), orgId, kind: "TEAM", name: teamName, code, parentId: deptId });
            createdTeams += 1;
          }
          teamIndex += 1;
        }
      }
    }, { orgId });

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
