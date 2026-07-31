import { and, asc, eq } from "drizzle-orm";
import {
  employeeSalaryProfileComponents,
  employeeSalaryProfiles,
  salaryComponents,
} from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";

type Tx = Pick<Db, "insert" | "select" | "update">;

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
    effectiveFrom: string;
  },
): Promise<{ profileId: number; componentCount: number }> {
  const annualCtc = (input.monthlySalary * 12).toFixed(2);

  const [profile] = await tx
    .insert(employeeSalaryProfiles)
    .values({
      orgId: input.orgId,
      userId: input.userId,
      workerType: "EMPLOYEE",
      currency: "INR",
      annualCtc,
      status: "ACTIVE",
      effectiveFrom: input.effectiveFrom,
      createdBy: input.actorId,
    })
    .returning({ id: employeeSalaryProfiles.id });

  if (!profile) throw new Error("Failed to create salary profile");

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
    .orderBy(asc(salaryComponents.sortOrder));

  if (components.length === 0) {
    return { profileId: profile.id, componentCount: 0 };
  }

  const basicAmount = (input.monthlySalary * 0.4).toFixed(2);
  const hraAmount = (input.monthlySalary * 0.2).toFixed(2);

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
