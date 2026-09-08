import { and, asc, eq, inArray } from "drizzle-orm";
import {
  employeeSalaryProfileComponents,
  employeeSalaryProfiles,
  salaryComponents,
  salaryStructureTemplates,
} from "../../../../db/schema";
import type { DbOrTx } from "../../../../common/rbac/access-invalidate";
import {
  DEFAULT_BASIC_PERCENT,
  DEFAULT_HRA_PERCENT,
  DEFAULT_PROFESSIONAL_TAX,
  splitFromTemplate,
  type SalarySplit,
} from "../salary-profile-seed.helper";

const DEFAULT_SPLIT: SalarySplit = {
  basicPercent: DEFAULT_BASIC_PERCENT,
  hraPercent: DEFAULT_HRA_PERCENT,
  professionalTax: DEFAULT_PROFESSIONAL_TAX,
};

export interface SalarySeedEntry {
  userId: string;
  monthlySalary: number;
  effectiveFrom: string;
  salaryStructureTemplateId?: number | null;
}

// Batched seedEmployeeSalaryProfile: one read per distinct template, one component read, two multi-row INSERTs.
export async function seedSalaryProfiles(
  tx: DbOrTx,
  orgId: string,
  actorId: string,
  entries: readonly SalarySeedEntry[],
): Promise<void> {
  if (entries.length === 0) return;

  const templateIds = [
    ...new Set(
      entries
        .map((entry) => entry.salaryStructureTemplateId)
        .filter((id): id is number => typeof id === "number"),
    ),
  ];

  const splitByTemplateId = new Map<number, SalarySplit>();
  if (templateIds.length > 0) {
    const templates = await tx
      .select({
        id: salaryStructureTemplates.id,
        basicSalary: salaryStructureTemplates.basicSalary,
        hraPercent: salaryStructureTemplates.hraPercent,
        specialAllowance: salaryStructureTemplates.specialAllowance,
        medicalAllowance: salaryStructureTemplates.medicalAllowance,
        travelAllowance: salaryStructureTemplates.travelAllowance,
        otherAllowances: salaryStructureTemplates.otherAllowances,
        professionalTax: salaryStructureTemplates.professionalTax,
      })
      .from(salaryStructureTemplates)
      .where(
        and(
          eq(salaryStructureTemplates.orgId, orgId),
          eq(salaryStructureTemplates.isActive, true),
          inArray(salaryStructureTemplates.id, templateIds),
        ),
      )
      .limit(templateIds.length);
    for (const template of templates)
      splitByTemplateId.set(template.id, splitFromTemplate(template));
  }

  const components = await tx
    .select({
      id: salaryComponents.id,
      code: salaryComponents.code,
      type: salaryComponents.type,
      calcMethod: salaryComponents.calcMethod,
      amount: salaryComponents.amount,
      percent: salaryComponents.percent,
      sortOrder: salaryComponents.sortOrder,
      includeInCtc: salaryComponents.includeInCtc,
    })
    .from(salaryComponents)
    .where(and(eq(salaryComponents.orgId, orgId), eq(salaryComponents.isActive, true)))
    .orderBy(asc(salaryComponents.sortOrder))
    .limit(100);

  const profiles = await tx
    .insert(employeeSalaryProfiles)
    .values(
      entries.map((entry) => ({
        orgId,
        userId: entry.userId,
        workerType: "EMPLOYEE" as const,
        currency: "INR",
        annualCtc: (entry.monthlySalary * 12).toFixed(2),
        status: "ACTIVE" as const,
        effectiveFrom: entry.effectiveFrom,
        createdBy: actorId,
      })),
    )
    .returning({ id: employeeSalaryProfiles.id, userId: employeeSalaryProfiles.userId });

  if (components.length === 0) return;

  const profileIdByUserId = new Map<string, number>();
  for (const profile of profiles)
    if (profile.userId) profileIdByUserId.set(profile.userId, profile.id);

  const rows: Array<typeof employeeSalaryProfileComponents.$inferInsert> = [];
  for (const entry of entries) {
    const profileId = profileIdByUserId.get(entry.userId);
    if (profileId === undefined) continue;
    const split =
      entry.salaryStructureTemplateId == null
        ? DEFAULT_SPLIT
        : splitByTemplateId.get(entry.salaryStructureTemplateId) ?? DEFAULT_SPLIT;
    const basic = (entry.monthlySalary * split.basicPercent) / 100;
    const basicAmount = basic.toFixed(2);
    const hraAmount = ((basic * split.hraPercent) / 100).toFixed(2);

    components.forEach((component, index) => {
      const code = component.code.toUpperCase();
      let amount: string | null = component.amount ?? null;
      let percent: string | null = component.percent ?? null;

      if (code === "BASIC" || code === "BASIC_SALARY") {
        amount = basicAmount;
        percent = null;
      } else if (code === "HRA" && (component.calcMethod === "FIXED" || !component.percent)) {
        amount = hraAmount;
      }

      rows.push({
        orgId,
        profileId,
        componentId: component.id,
        amount,
        percent,
        sortOrder: component.sortOrder ?? index,
      });
    });
  }

  if (rows.length > 0) await tx.insert(employeeSalaryProfileComponents).values(rows);
}
