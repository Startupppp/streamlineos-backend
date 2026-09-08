import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { hrEmployments } from "../../../db/schema";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import type { HrAuditEntry } from "./hr-audit.service";
import {
  resolveHrPeople,
  resolveOrganizationPeople,
} from "./person-employment-sync-batch-people";
import type {
  EnsureManyInput,
  EnsureManyOutcome,
  EnsureManyRow,
} from "./person-employment-sync-batch.types";

export type {
  EnsureManyInput,
  EnsureManyOutcome,
  EnsureManyRow,
} from "./person-employment-sync-batch.types";

/**
 * The batched form of `ensureFromUser`. Every lookup is one `inArray` read for
 * the whole batch and every write is one multi-row statement, so the statement
 * count is fixed rather than a multiple of the input length.
 */
export async function ensureManyFromUsers(
  tx: DbOrTx,
  orgId: string,
  inputs: readonly EnsureManyInput[],
): Promise<EnsureManyOutcome> {
  if (inputs.length === 0) return { rows: [], auditEntries: [] };

  const orgPersonByUserId = await resolveOrganizationPeople(tx, orgId, inputs);
  const { personIdByUserId, createdUserIds } = await resolveHrPeople(
    tx,
    orgId,
    inputs,
    orgPersonByUserId,
  );

  const personIds = [...new Set([...personIdByUserId.values()])];
  const employeeNumbers = [...new Set(inputs.map((input) => input.employeeNumber))];

  const primaryRows = await tx
    .select({ id: hrEmployments.id, personId: hrEmployments.personId })
    .from(hrEmployments)
    .where(
      and(
        eq(hrEmployments.orgId, orgId),
        eq(hrEmployments.isPrimary, true),
        isNull(hrEmployments.deletedAt),
        inArray(hrEmployments.personId, personIds),
      ),
    )
    .limit(personIds.length);
  const primaryByPersonId = new Map(primaryRows.map((row) => [row.personId, row.id]));

  const numberRows = await tx
    .select({
      id: hrEmployments.id,
      personId: hrEmployments.personId,
      employeeNumber: hrEmployments.employeeNumber,
    })
    .from(hrEmployments)
    .where(
      and(
        eq(hrEmployments.orgId, orgId),
        isNull(hrEmployments.deletedAt),
        inArray(hrEmployments.employeeNumber, employeeNumbers),
      ),
    )
    .limit(employeeNumbers.length);
  const byNumber = new Map(numberRows.map((row) => [row.employeeNumber, row]));

  const rows: EnsureManyRow[] = [];
  const auditEntries: HrAuditEntry[] = [];
  const pendingInserts: Array<{ input: EnsureManyInput; personId: number; employeeNumber: string }> = [];
  const takenNumbers = new Set(numberRows.map((row) => row.employeeNumber));
  const departmentPatches: Array<{ employmentId: number; departmentId: string }> = [];

  for (const input of inputs) {
    const personId = personIdByUserId.get(input.userId);
    if (personId === undefined) continue;
    const createdPerson = createdUserIds.has(input.userId);

    const reuse =
      primaryByPersonId.get(personId) ??
      (byNumber.get(input.employeeNumber)?.personId === personId
        ? byNumber.get(input.employeeNumber)?.id
        : undefined);

    if (reuse !== undefined) {
      rows.push({
        userId: input.userId,
        personId,
        employmentId: reuse,
        employeeNumber: input.employeeNumber,
        createdPerson,
        createdEmployment: false,
      });
      if (input.departmentId)
        departmentPatches.push({ employmentId: reuse, departmentId: input.departmentId });
      continue;
    }

    let employeeNumber = input.employeeNumber;
    if (takenNumbers.has(employeeNumber))
      employeeNumber = `${input.employeeNumber}-${input.userId.slice(0, 6).toUpperCase()}`;
    takenNumbers.add(employeeNumber);
    pendingInserts.push({ input, personId, employeeNumber });
  }

  if (pendingInserts.length > 0) {
    const inserted = await tx
      .insert(hrEmployments)
      .values(
        pendingInserts.map((pending) => ({
          orgId,
          personId: pending.personId,
          employeeNumber: pending.employeeNumber,
          lifecycleStatus: pending.input.lifecycleStatus ?? "ONBOARDING",
          workerType: pending.input.workerType ?? "FULL_TIME",
          designation: pending.input.designation ?? null,
          joiningDate: pending.input.joiningDate ?? null,
          departmentId: pending.input.departmentId ?? null,
          isPrimary: true,
        })),
      )
      .returning({ id: hrEmployments.id, personId: hrEmployments.personId });

    const insertedByPersonId = new Map(inserted.map((row) => [row.personId, row.id]));
    for (const pending of pendingInserts) {
      const employmentId = insertedByPersonId.get(pending.personId);
      if (employmentId === undefined) continue;
      rows.push({
        userId: pending.input.userId,
        personId: pending.personId,
        employmentId,
        employeeNumber: pending.employeeNumber,
        createdPerson: createdUserIds.has(pending.input.userId),
        createdEmployment: true,
      });
      auditEntries.push({
        entityType: "hr_employments",
        entityId: String(employmentId),
        action: "synced_from_user",
        after: { personId: pending.personId, employeeNumber: pending.employeeNumber },
      });
    }
  }

  for (const userId of createdUserIds) {
    const personId = personIdByUserId.get(userId);
    if (personId === undefined) continue;
    auditEntries.push({
      entityType: "hr_people",
      entityId: String(personId),
      action: "synced_from_user",
      after: { userId },
    });
  }

  if (departmentPatches.length > 0) {
    const pairs = sql.join(
      departmentPatches.map((patch) => sql`(${patch.employmentId}::int, ${patch.departmentId}::text)`),
      sql`, `,
    );
    await tx.execute(
      sql`UPDATE hr_employments AS e SET department_id = v.department_id, updated_at = now() FROM (VALUES ${pairs}) AS v(id, department_id) WHERE e.id = v.id AND e.org_id = ${orgId}`,
    );
  }

  return { rows, auditEntries };
}
