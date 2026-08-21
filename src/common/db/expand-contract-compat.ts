import { sql } from "drizzle-orm";
import type { Db, TenantTx } from "../../db/drizzle.types";

export type CompatibilityDb = Db | TenantTx;

export type CompatibilityRelationName =
  | "public.hrms_migration_profiles"
  | "public.attendance_event_locators"
  | "public.attendance_events"
  | "public.organization_people"
  | "public.workers"
  | "public.worker_engagements"
  | "public.hr_employee_sensitive_disciplinary_records"
  | "public.hr_employee_sensitive_grievance_records"
  | "public.hr_document_tags"
  | "public.onboarding_task_dependencies"
  | "public.termination_reasons"
  | "public.termination_supporting_documents";

export async function isCompatibilityRelationAvailable(
  database: CompatibilityDb,
  relationName: CompatibilityRelationName,
): Promise<boolean> {
  const [availability] = await database.execute<{ relationAvailable: boolean }>(sql`
    SELECT to_regclass(${relationName}) IS NOT NULL AS "relationAvailable"
  `);
  return availability?.relationAvailable === true;
}

export async function areCompatibilityRelationsAvailable(
  database: CompatibilityDb,
  relationNames: readonly CompatibilityRelationName[],
): Promise<boolean> {
  if (relationNames.length === 0) return true;
  const availabilityExpressions = relationNames.map(
    (relationName) => sql`to_regclass(${relationName}) IS NOT NULL`,
  );
  const [availability] = await database.execute<{
    relationsAvailable: boolean;
  }>(sql`
    SELECT ${sql.join(availabilityExpressions, sql` AND `)} AS "relationsAvailable"
  `);
  return availability?.relationsAvailable === true;
}

export function resolveCompatibleList<T>(
  legacyValues: readonly T[] | null | undefined,
  normalizedValues: readonly T[] | undefined,
  valuesEqual: (leftValue: T, rightValue: T) => boolean = Object.is,
): T[] {
  const legacyList = legacyValues ?? [];
  if (!normalizedValues || normalizedValues.length !== legacyList.length)
    return [...legacyList];
  for (let valueIndex = 0; valueIndex < legacyList.length; valueIndex += 1) {
    const legacyValue = legacyList[valueIndex];
    const normalizedValue = normalizedValues[valueIndex];
    if (
      legacyValue === undefined ||
      normalizedValue === undefined ||
      !valuesEqual(legacyValue, normalizedValue)
    )
      return [...legacyList];
  }
  return [...normalizedValues];
}
