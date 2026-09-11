import { InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { decodeCursor, buildCursorPage } from "../../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../../common/pagination/keyset";
import type { Db } from "../../../../db/drizzle.module";
import { hrLaborCases } from "../../../../db/schema/hr/governance";
import { HrAuditService } from "../../core/hr-audit.service";
import type {
  CreateLaborCaseInput,
  UpdateLaborCaseInput,
  ListLaborCasesInput,
} from "./labor.dto";

async function getLaborCaseById(db: Db, orgId: string, id: number) {
  const [row] = await db.select().from(hrLaborCases).where(and(eq(hrLaborCases.orgId, orgId), eq(hrLaborCases.id, id), isNull(hrLaborCases.deletedAt))).limit(1);
  if (!row) throw new NotFoundException("Labor case not found");
  return row;
}

export async function listLaborCases(db: Db, orgId: string, input: ListLaborCasesInput) {
  const { cursor, limit, status, unionName } = input;
  const pos = decodeCursor(cursor);

  const conditions = [eq(hrLaborCases.orgId, orgId), isNull(hrLaborCases.deletedAt)];
  if (status) conditions.push(eq(hrLaborCases.status, status));
  if (unionName) conditions.push(eq(hrLaborCases.unionName, unionName));
  if (pos) conditions.push(keysetBeforeId(hrLaborCases.createdAt, hrLaborCases.id, pos));

  const rows = await db
    .select()
    .from(hrLaborCases)
    .where(and(...conditions))
    .orderBy(desc(hrLaborCases.createdAt), desc(hrLaborCases.id))
    .limit(limit + 1);

  return buildCursorPage(rows, limit, (row) => ({
    sortValue: row.createdAt.toISOString(),
    id: String(row.id),
  }));
}

export async function createLaborCase(db: Db, audit: HrAuditService, orgId: string, actorId: string, input: CreateLaborCaseInput, ipAddress?: string) {
  const [row] = await db
    .insert(hrLaborCases)
    .values({
      orgId,
      unionName: input.unionName,
      subject: input.subject,
      description: input.description,
      status: input.status ?? "open",
      createdBy: actorId,
    })
    .returning();

  // A single-row `INSERT ... RETURNING` yields exactly one row, but that is a
  // property of the statement and not something an array index type can carry.
  // Narrowed with a real check rather than `!`: an empty RETURNING now fails
  // here instead of writing an audit entry that names `undefined.id` and
  // handing the caller a labor case that does not exist.
  if (!row) throw new InternalServerErrorException("Failed to create labor case");

  await audit.log({ orgId, actorId, entityType: "hr_labor_case", entityId: String(row.id), action: "labor_case.created", after: { subject: input.subject, unionName: input.unionName }, ipAddress });

  return row;
}

export async function updateLaborCase(db: Db, audit: HrAuditService, orgId: string, caseId: number, actorId: string, input: UpdateLaborCaseInput, ipAddress?: string) {
  const existing = await getLaborCaseById(db, orgId, caseId);

  const [updated] = await db
    .update(hrLaborCases)
    .set({
      ...(input.unionName !== undefined && { unionName: input.unionName }),
      ...(input.subject !== undefined && { subject: input.subject }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.status !== undefined && { status: input.status }),
      updatedAt: new Date(),
    })
    .where(and(eq(hrLaborCases.orgId, orgId), eq(hrLaborCases.id, caseId)))
    .returning();

  // `getLaborCaseById` proved this row existed a moment ago, so an empty
  // RETURNING means it was soft-deleted or moved between the read and the
  // write. The honest answer is the 404 the read would give now — not an audit
  // entry recording an update that never landed, followed by `undefined`.
  if (!updated) throw new NotFoundException("Labor case not found");

  await audit.log({ orgId, actorId, entityType: "hr_labor_case", entityId: String(caseId), action: "labor_case.updated", before: { status: existing.status }, after: input, ipAddress });

  return updated;
}

export async function deleteLaborCase(db: Db, audit: HrAuditService, orgId: string, caseId: number, actorId: string, ipAddress?: string) {
  await getLaborCaseById(db, orgId, caseId);

  await db
    .update(hrLaborCases)
    .set({ deletedAt: new Date() })
    .where(and(eq(hrLaborCases.orgId, orgId), eq(hrLaborCases.id, caseId)));

  await audit.log({ orgId, actorId, entityType: "hr_labor_case", entityId: String(caseId), action: "labor_case.deleted", ipAddress });
}
