import { InternalServerErrorException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import {
  employeeSalaryProfileComponents,
  employeeSalaryProfiles,
  salaryComponents,
  salaryStructureTemplates,
} from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";

type Tx = Pick<Db, "insert" | "select" | "update">;

/**
 * The split applied when the organisation has no salary structure template, or
 * the chosen one cannot be read. The onboarding wizard renders these same
 * numbers, so what a new joiner is shown is what gets persisted.
 */
export const DEFAULT_BASIC_PERCENT = 40;
/** Of basic, not of CTC — 50% of a 40% basic is the historical 20% of CTC. */
export const DEFAULT_HRA_PERCENT = 50;
export const DEFAULT_PROFESSIONAL_TAX = 200;

export interface SalarySplit {
  /** Share of monthly CTC that becomes basic pay. */
  basicPercent: number;
  /** HRA as a percent of basic pay. */
  hraPercent: number;
  professionalTax: number;
}

export async function resolveSalarySplit(
  tx: Pick<Db, "select">,
  orgId: string,
  templateId?: number | null,
): Promise<SalarySplit> {
  if (!templateId) {
    return {
      basicPercent: DEFAULT_BASIC_PERCENT,
      hraPercent: DEFAULT_HRA_PERCENT,
      professionalTax: DEFAULT_PROFESSIONAL_TAX,
    };
  }

  const [template] = await tx
    .select({
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
        eq(salaryStructureTemplates.id, templateId),
        eq(salaryStructureTemplates.orgId, orgId),
        eq(salaryStructureTemplates.isActive, true),
      ),
    )
    .limit(1);

  if (!template) {
    return {
      basicPercent: DEFAULT_BASIC_PERCENT,
      hraPercent: DEFAULT_HRA_PERCENT,
      professionalTax: DEFAULT_PROFESSIONAL_TAX,
    };
  }

  return splitFromTemplate(template);
}

/**
 * A template states an absolute package (basic amount, HRA as a percent of
 * basic, fixed allowances). The wizard states a CTC. Convert the template into
 * the ratios it implies, so applying them to any CTC reproduces the template's
 * shape and still sums to exactly that CTC.
 */
export function splitFromTemplate(template: {
  basicSalary: string | null;
  hraPercent: string | null;
  specialAllowance?: string | null;
  medicalAllowance?: string | null;
  travelAllowance?: string | null;
  otherAllowances?: string | null;
  professionalTax?: string | null;
}): SalarySplit {
  const basic = Number(template.basicSalary ?? 0);
  const hraOfBasic = Number(template.hraPercent ?? 0);
  const allowances =
    Number(template.specialAllowance ?? 0) +
    Number(template.medicalAllowance ?? 0) +
    Number(template.travelAllowance ?? 0) +
    Number(template.otherAllowances ?? 0);
  const professionalTax = Number(
    template.professionalTax ?? DEFAULT_PROFESSIONAL_TAX,
  );

  const gross = basic + (basic * hraOfBasic) / 100 + allowances;

  if (!Number.isFinite(gross) || gross <= 0 || !Number.isFinite(basic) || basic <= 0) {
    return {
      basicPercent: DEFAULT_BASIC_PERCENT,
      hraPercent: DEFAULT_HRA_PERCENT,
      professionalTax: Number.isFinite(professionalTax)
        ? professionalTax
        : DEFAULT_PROFESSIONAL_TAX,
    };
  }

  return {
    basicPercent: (basic / gross) * 100,
    hraPercent: Number.isFinite(hraOfBasic) ? hraOfBasic : DEFAULT_HRA_PERCENT,
    professionalTax: Number.isFinite(professionalTax)
      ? professionalTax
      : DEFAULT_PROFESSIONAL_TAX,
  };
}

/**
 * Creates a canonical salary profile and attaches org salary components.
 * BASIC (or first FIXED earning) gets an amount derived from monthly salary.
 */
export async function seedEmployeeSalaryProfile(
  tx: Tx,
  input: {
    orgId: string;
    userId: string;
    actorId: string;
    monthlySalary: number;
    currency: string;
    effectiveFrom: string;
    salaryStructureTemplateId?: number | null;
  },
): Promise<{ profileId: number; componentCount: number }> {
  const annualCtc = (input.monthlySalary * 12).toFixed(2);
  const split = await resolveSalarySplit(
    tx,
    input.orgId,
    input.salaryStructureTemplateId,
  );

  const [profile] = await tx
    .insert(employeeSalaryProfiles)
    .values({
      orgId: input.orgId,
      userId: input.userId,
      workerType: "EMPLOYEE",
      currency: input.currency,
      annualCtc,
      status: "ACTIVE",
      effectiveFrom: input.effectiveFrom,
      createdBy: input.actorId,
    })
    .returning({ id: employeeSalaryProfiles.id });

  if (!profile) throw new InternalServerErrorException("Failed to create salary profile");

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
    .where(
      and(
        eq(salaryComponents.orgId, input.orgId),
        eq(salaryComponents.isActive, true),
      ),
    )
    .orderBy(asc(salaryComponents.sortOrder))
    .limit(100);

  if (components.length === 0) {
    return { profileId: profile.id, componentCount: 0 };
  }

  const basic = (input.monthlySalary * split.basicPercent) / 100;
  const basicAmount = basic.toFixed(2);
  const hraAmount = ((basic * split.hraPercent) / 100).toFixed(2);

  await tx.insert(employeeSalaryProfileComponents).values(
    components.map((c, idx) => {
      const code = c.code.toUpperCase();
      let amount: string | null = c.amount ?? null;
      let percent: string | null = c.percent ?? null;

      if (code === "BASIC" || code === "BASIC_SALARY") {
        amount = basicAmount;
        percent = null;
      } else if (code === "HRA") {
        if (c.calcMethod === "FIXED" || !c.percent) {
          amount = hraAmount;
        }
      }

      return {
        orgId: input.orgId,
        profileId: profile.id,
        componentId: c.id,
        amount,
        percent,
        sortOrder: c.sortOrder ?? idx,
      };
    }),
  );

  return { profileId: profile.id, componentCount: components.length };
}
