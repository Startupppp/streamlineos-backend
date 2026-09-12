import { NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { hrPayrollInputPeriods } from "../../../db/schema/payroll/input-capture";

/**
 * Standalone period lookup shared by PayrollInputsService and
 * PayrollInputAdjustmentsService without creating a circular DI dependency.
 */
export async function getPeriodById(db: Db, orgId: string, periodId: number) {
  const period = await db.query.hrPayrollInputPeriods.findFirst({
    where: and(
      eq(hrPayrollInputPeriods.id, periodId),
      eq(hrPayrollInputPeriods.orgId, orgId),
    ),
  });
  if (!period) throw new NotFoundException("Period not found");
  return period;
}
