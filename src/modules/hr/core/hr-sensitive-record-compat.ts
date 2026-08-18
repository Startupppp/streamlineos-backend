import { and, asc, eq } from "drizzle-orm";
import {
  isCompatibilityRelationAvailable,
  type CompatibilityDb,
} from "../../../common/db/expand-contract-compat";
import {
  hrEmployeeSensitiveDisciplinaryRecords,
  hrEmployeeSensitiveGrievanceRecords,
} from "../../../db/schema/hr/employee-sensitive-records";

export type SensitiveRecordCollections = {
  disciplinaryRecords?: Array<Record<string, unknown>>;
  grievanceRecords?: Array<Record<string, unknown>>;
};

export async function loadSensitiveRecordCollections(
  database: CompatibilityDb,
  organizationId: string,
  sensitiveFieldsId: number,
): Promise<SensitiveRecordCollections> {
  const collections: SensitiveRecordCollections = {};
  const disciplinaryRecordsAvailable = await isCompatibilityRelationAvailable(
    database,
    "public.hr_employee_sensitive_disciplinary_records",
  );
  if (disciplinaryRecordsAvailable) {
    const disciplinaryRows = await database
      .select({ recordPayload: hrEmployeeSensitiveDisciplinaryRecords.recordPayload })
      .from(hrEmployeeSensitiveDisciplinaryRecords)
      .where(
        and(
          eq(hrEmployeeSensitiveDisciplinaryRecords.organizationId, organizationId),
          eq(hrEmployeeSensitiveDisciplinaryRecords.sensitiveFieldsId, sensitiveFieldsId),
        ),
      )
      .orderBy(asc(hrEmployeeSensitiveDisciplinaryRecords.sourceOrdinal));
    collections.disciplinaryRecords = disciplinaryRows.map(
      (disciplinaryRow) => disciplinaryRow.recordPayload,
    );
  }

  const grievanceRecordsAvailable = await isCompatibilityRelationAvailable(
    database,
    "public.hr_employee_sensitive_grievance_records",
  );
  if (grievanceRecordsAvailable) {
    const grievanceRows = await database
      .select({ recordPayload: hrEmployeeSensitiveGrievanceRecords.recordPayload })
      .from(hrEmployeeSensitiveGrievanceRecords)
      .where(
        and(
          eq(hrEmployeeSensitiveGrievanceRecords.organizationId, organizationId),
          eq(hrEmployeeSensitiveGrievanceRecords.sensitiveFieldsId, sensitiveFieldsId),
        ),
      )
      .orderBy(asc(hrEmployeeSensitiveGrievanceRecords.sourceOrdinal));
    collections.grievanceRecords = grievanceRows.map(
      (grievanceRow) => grievanceRow.recordPayload,
    );
  }
  return collections;
}
