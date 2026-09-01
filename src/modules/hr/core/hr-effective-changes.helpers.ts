import { BadRequestException } from "@nestjs/common";
import { and, desc, eq, gt, isNull, lte } from "drizzle-orm";
import {
  hrEmployeeSensitiveFields,
  hrReportingLines,
} from "../../../db/schema/hr/core-people";
import type { Db } from "../../../db/drizzle.module";
import type { CreateEffectiveDateChangeInput } from "./dto/hr-core.schemas";
import { decodeCursor } from "../../../common/pagination/cursor";

export type EmploymentSnapshot = {
  id: number;
  subjectUserId: string | null;
  departmentId: string | null;
  designation: string | null;
  jobLevelId: number | null;
  locationId: string | null;
};

export type EffectiveChangeCursorScope = {
  orgId: string;
  employmentId: number | null;
  changeType: string | null;
  status: string | null;
};

export function invalidEffectiveChangeCursor(): never {
  throw new BadRequestException({
    code: "INVALID_EFFECTIVE_CHANGE_CURSOR",
    message: "The effective change cursor is invalid or expired.",
  });
}

export function isBusinessDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function decodeEffectiveChangeCursor(
  value: string | undefined,
  expected: EffectiveChangeCursorScope,
) {
  if (!value) return null;
  const position = decodeCursor(value);
  if (!position || !isBusinessDate(position.sortValue))
    return invalidEffectiveChangeCursor();

  try {
    const scope: unknown = JSON.parse(position.id);
    if (
      !Array.isArray(scope) ||
      scope.length !== 5 ||
      typeof scope[0] !== "number" ||
      !Number.isSafeInteger(scope[0]) ||
      scope[0] < 1 ||
      scope[1] !== expected.orgId ||
      scope[2] !== expected.employmentId ||
      scope[3] !== expected.changeType ||
      scope[4] !== expected.status
    )
      return invalidEffectiveChangeCursor();
    return { sortValue: position.sortValue, id: String(scope[0]) };
  } catch {
    return invalidEffectiveChangeCursor();
  }
}

export async function snapshotOldValue(
  tx: Db,
  orgId: string,
  input: CreateEffectiveDateChangeInput,
  employment: EmploymentSnapshot,
): Promise<Record<string, unknown>> {
  if (input.changeType === "department") return { departmentId: employment.departmentId };
  if (input.changeType === "location") return { locationId: employment.locationId };
  if (input.changeType === "designation") return { designation: employment.designation };
  if (input.changeType === "job_level") return { jobLevelId: employment.jobLevelId };
  if (input.changeType === "compensation") {
    const [sensitive] = await tx
      .select({ salaryCents: hrEmployeeSensitiveFields.salaryAmountCents })
      .from(hrEmployeeSensitiveFields)
      .where(
        and(
          eq(hrEmployeeSensitiveFields.orgId, orgId),
          eq(hrEmployeeSensitiveFields.employmentId, employment.id),
        ),
      )
      .limit(1);
    return { salaryCents: sensitive?.salaryCents ?? null };
  }

  const today = new Date().toISOString().slice(0, 10);
  const [line] = await tx
    .select({ managerEmploymentId: hrReportingLines.managerEmploymentId })
    .from(hrReportingLines)
    .where(
      and(
        eq(hrReportingLines.orgId, orgId),
        eq(hrReportingLines.employmentId, employment.id),
        eq(hrReportingLines.lineType, "primary"),
        lte(hrReportingLines.effectiveFrom, today),
        gt(hrReportingLines.effectiveTo, today),
      ),
    )
    .orderBy(desc(hrReportingLines.effectiveFrom), desc(hrReportingLines.id))
    .limit(1);
  return { managerEmploymentId: line?.managerEmploymentId ?? null };
}
