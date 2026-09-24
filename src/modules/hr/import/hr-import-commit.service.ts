import { ConflictException, Injectable } from "@nestjs/common";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import {
  hrPeople,
  hrEmployments,
  organizationPeople,
  attendance,
  assets,
  leaveBalances,
  leaveTypes,
  documents,
} from "../../../db/schema";
import { getPostgresErrorDetails } from "../../../common/db/postgres-error";
import { hrImportRows } from "../../../db/schema/hr/import-jobs";
import {
  employeeRowSchema,
  leaveBalanceRowSchema,
  attendanceRowSchema,
  assetRowSchema,
  documentMetadataRowSchema,
  type EmployeeRow,
  type LeaveBalanceRow,
  type AttendanceRow,
  type AssetRow,
  type DocumentMetadataRow,
} from "./schemas/entity-row-schemas";
import type { HrImportEntity } from "./dto/import-job.dto";
import { normalizeCode, normalizeName } from "./schemas/import-row-identity";

/**
 * What a committed row did. A rollback may only undo `created` rows: an import
 * that updated a record the operator already had must not delete it when the job
 * is rolled back, and an `unchanged` row touched nothing to undo.
 */
export type CommitOutcome = "created" | "updated" | "unchanged";

export interface CommitRef {
  table: string;
  id: number;
  outcome: CommitOutcome;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

@Injectable()
export class HrImportCommitService {
  constructor() {}

  async commitRow(
    tx: Tx,
    orgId: string,
    entity: HrImportEntity,
    payload: Record<string, unknown>,
  ): Promise<CommitRef | null> {
    if (entity === "employees") return this.commitEmployee(tx, orgId, employeeRowSchema.parse(payload));
    if (entity === "leave_balances") return this.commitLeaveBalance(tx, orgId, leaveBalanceRowSchema.parse(payload));
    if (entity === "attendance") return this.commitAttendance(tx, orgId, attendanceRowSchema.parse(payload));
    if (entity === "assets") return this.commitAsset(tx, orgId, assetRowSchema.parse(payload));
    if (entity === "document_metadata") return this.commitDocument(tx, orgId, documentMetadataRowSchema.parse(payload));
    return null;
  }

  private async resolveImportOrgPersonId(
    tx: Tx,
    orgId: string,
    workEmail: string,
    firstName: string,
    lastName: string,
    phone: string | null = null,
    gender: string | null = null,
  ): Promise<string> {
    const byEmail = await tx.query.organizationPeople.findFirst({
      where: and(
        eq(organizationPeople.organizationId, orgId),
        sql`lower(trim(${organizationPeople.workEmail})) = ${workEmail}`,
        isNull(organizationPeople.deletedAt),
      ),
      columns: { organizationPersonId: true },
    });
    if (byEmail) return byEmail.organizationPersonId;

    const [created] = await tx
      .insert(organizationPeople)
      .values({ organizationId: orgId, firstName, lastName, workEmail, phone, gender })
      .returning({ organizationPersonId: organizationPeople.organizationPersonId });
    if (!created) throw new Error("Failed to create canonical person record");
    return created.organizationPersonId;
  }

  private async commitEmployee(tx: Tx, orgId: string, row: EmployeeRow): Promise<CommitRef> {
    const workEmail = row.email.toLowerCase().trim();
    const organizationPersonId = await this.resolveImportOrgPersonId(
      tx,
      orgId,
      workEmail,
      row.firstName,
      row.lastName,
      row.phone ?? null,
      row.gender ?? null,
    );

    const [person] = await tx
      .insert(hrPeople)
      .values({
        orgId,
        organizationPersonId,
      })
      .onConflictDoNothing()
      .returning({ id: hrPeople.id });

    if (person) {
      const empNumber = row.employeeNumber ?? `EMP-${Date.now()}`;
      await tx
        .insert(hrEmployments)
        .values({
          orgId,
          personId: person.id,
          employeeNumber: empNumber,
          lifecycleStatus: "ACTIVE",
          joiningDate: row.joiningDate || null,
          designation: row.designation ?? null,
        })
        .onConflictDoNothing();
      return { table: "hr_people", id: person.id, outcome: "created" };
    }

    const existing = await tx
      .select({ id: hrPeople.id, organizationPersonId: hrPeople.organizationPersonId })
      .from(hrPeople)
      .innerJoin(
        organizationPeople,
        and(
          eq(organizationPeople.organizationId, hrPeople.orgId),
          eq(organizationPeople.organizationPersonId, hrPeople.organizationPersonId),
        ),
      )
      .where(and(eq(hrPeople.orgId, orgId), eq(organizationPeople.workEmail, workEmail), isNull(hrPeople.deletedAt)))
      .limit(1);

    const existingRow = existing[0];
    if (!existingRow) throw new Error(`Employee with email ${row.email} could not be inserted or found`);

    if (existingRow.organizationPersonId === null)
      await tx
        .update(hrPeople)
        .set({ organizationPersonId })
        .where(and(eq(hrPeople.id, existingRow.id), eq(hrPeople.orgId, orgId)))
        .catch((err: unknown) => {
          const { code, constraint } = getPostgresErrorDetails(err);
          if (code === "23505" && constraint === "uniq_hr_people_org_person_link")
            throw new ConflictException("Duplicate directory-person link detected during import");
          throw err;
        });

    return { table: "hr_people", id: existingRow.id, outcome: "updated" };
  }

  private async commitLeaveBalance(tx: Tx, orgId: string, row: LeaveBalanceRow): Promise<CommitRef> {
    const person = await tx
      .select({ userId: hrPeople.userId })
      .from(hrPeople)
      .innerJoin(
        organizationPeople,
        and(
          eq(organizationPeople.organizationId, hrPeople.orgId),
          eq(organizationPeople.organizationPersonId, hrPeople.organizationPersonId),
        ),
      )
      .where(and(eq(hrPeople.orgId, orgId), isNull(hrPeople.deletedAt), eq(organizationPeople.workEmail, row.employeeEmail)))
      .limit(1);

    const userId = person[0]?.userId;
    if (!userId) throw new Error(`No user found for email ${row.employeeEmail}`);

    const leaveType = await tx
      .select({ id: leaveTypes.id })
      .from(leaveTypes)
      .where(and(eq(leaveTypes.orgId, orgId), eq(leaveTypes.name, row.leaveTypeName)))
      .limit(1);

    const leaveTypeId = leaveType[0]?.id;
    if (!leaveTypeId) throw new Error(`Leave type '${row.leaveTypeName}' not found`);

    const balance = String(typeof row.balance === "number" ? row.balance : parseFloat(String(row.balance)));
    const year = typeof row.year === "number" ? row.year : parseInt(String(row.year));

    // The upsert already set the balance absolutely — the file wins over whatever
    // was there — but it could not say whether the row was new, so a re-import
    // reported the same "valid" count as a first import and an operator had no
    // way to tell a no-op apart from a fresh load. The prior read is what turns
    // that into created/updated. `uniq_leave_balances_user_type_year` is on
    // (user_id, leave_type_id, year) with no org column, and leave_type_id is
    // itself org-scoped, so the conflict target below matches that index exactly.
    const [before] = await tx
      .select({ id: leaveBalances.id, balance: leaveBalances.balance })
      .from(leaveBalances)
      .where(
        and(
          eq(leaveBalances.orgId, orgId),
          eq(leaveBalances.userId, userId),
          eq(leaveBalances.leaveTypeId, leaveTypeId),
          eq(leaveBalances.year, year),
        ),
      )
      .limit(1);

    const [lb] = await tx
      .insert(leaveBalances)
      .values({ orgId, userId, leaveTypeId, balance, year })
      .onConflictDoUpdate({
        target: [leaveBalances.userId, leaveBalances.leaveTypeId, leaveBalances.year],
        set: { balance },
      })
      .returning({ id: leaveBalances.id });

    if (!lb) throw new Error("Failed to upsert leave balance");
    if (!before) return { table: "leave_balances", id: lb.id, outcome: "created" };
    return {
      table: "leave_balances",
      id: lb.id,
      outcome: Number(before.balance) === Number(balance) ? "unchanged" : "updated",
    };
  }

  private async commitAttendance(tx: Tx, orgId: string, row: AttendanceRow): Promise<CommitRef> {
    const person = await tx
      .select({ userId: hrPeople.userId })
      .from(hrPeople)
      .innerJoin(
        organizationPeople,
        and(
          eq(organizationPeople.organizationId, hrPeople.orgId),
          eq(organizationPeople.organizationPersonId, hrPeople.organizationPersonId),
        ),
      )
      .where(and(eq(hrPeople.orgId, orgId), isNull(hrPeople.deletedAt), eq(organizationPeople.workEmail, row.employeeEmail)))
      .limit(1);

    const userId = person[0]?.userId;
    if (!userId) throw new Error(`No user found for email ${row.employeeEmail}`);

    const checkIn = row.checkIn ? new Date(row.checkIn) : null;
    const checkOut = row.checkOut ? new Date(row.checkOut) : null;

    // The `onConflictDoNothing()` that used to sit on this insert could never
    // fire: `attendance`'s only unique indexes are attendance_pkey (id) and
    // uniq_attendance_org_id (org_id, id), both on a generated serial the
    // insert never supplies. So no conflict was possible, `rec` was always
    // defined, the duplicate guard below was unreachable, and re-running the
    // same CSV — the ordinary correction workflow, which is why the rollback
    // endpoint exists — silently doubled every row. That inflates the
    // count()-based attendance rate and the payable days payroll reads.
    //
    // A unique index cannot replace this check: the clock path legitimately
    // writes several sessions per person per day, and `attendance` carries no
    // column recording which rows arrived by import, so there is nothing to
    // scope a partial index to. The check is therefore explicit. The whole job
    // runs inside one transaction behind a previewed -> committing status
    // transition, so no second commit of the same job races this read.
    const [duplicate] = await tx
      .select({ id: attendance.id })
      .from(attendance)
      .where(
        and(
          eq(attendance.orgId, orgId),
          eq(attendance.userId, userId),
          eq(attendance.date, row.date),
        ),
      )
      .limit(1);
    if (duplicate) {
      throw new Error(`Attendance for ${row.employeeEmail} on ${row.date} already exists`);
    }

    const [rec] = await tx
      .insert(attendance)
      .values({
        orgId,
        userId,
        date: row.date,
        checkIn,
        checkOut,
        status: row.status ?? "PRESENT",
      })
      .returning({ id: attendance.id });

    if (!rec) {
      throw new Error(`Failed to import attendance for ${row.employeeEmail} on ${row.date}`);
    }
    return { table: "attendance", id: rec.id, outcome: "created" };
  }

  private async commitAsset(tx: Tx, orgId: string, row: AssetRow): Promise<CommitRef> {
    let assignedTo: string | null = null;

    if (row.assignedToEmail) {
      const person = await tx
        .select({ userId: hrPeople.userId })
        .from(hrPeople)
        .innerJoin(
          organizationPeople,
          and(
            eq(organizationPeople.organizationId, hrPeople.orgId),
            eq(organizationPeople.organizationPersonId, hrPeople.organizationPersonId),
          ),
        )
        .where(and(eq(hrPeople.orgId, orgId), isNull(hrPeople.deletedAt), eq(organizationPeople.workEmail, row.assignedToEmail)))
        .limit(1);
      assignedTo = person[0]?.userId ?? null;
    }

    const fields = {
      name: row.name,
      type: row.type,
      brand: row.brand ?? null,
      model: row.model ?? null,
      status: row.status ?? ("AVAILABLE" as const),
      purchaseDate: row.purchaseDate || null,
      location: row.location ?? null,
    };

    // A serial number is the asset's identity: it is what is engraved on the
    // machine and what an operator re-uploads a corrected sheet against. Without
    // this lookup the importer inserted unconditionally, so re-importing the same
    // file doubled the estate — QA's four-row sheet became eight assets with
    // QA-SN-0001 present six times.
    //
    // The match is `upper(trim(serial))` rather than a unique index because the
    // existing estate has not been audited for duplicates yet (HRMS-E2E-006a);
    // an index would have to abort the migration or destroy rows. Matching in the
    // query makes re-imports idempotent now and leaves the index to a migration
    // once a cleanup is approved.
    const serial = normalizeCode(row.serialNumber);
    if (serial !== "") {
      const [existing] = await tx
        .select({ id: assets.id })
        .from(assets)
        .where(
          and(
            eq(assets.orgId, orgId),
            sql`upper(trim(${assets.serialNumber})) = ${serial}`,
          ),
        )
        .orderBy(asc(assets.id))
        .limit(1);

      if (existing) {
        await tx
          .update(assets)
          .set({
            ...fields,
            // A blank assignee column means "not stated", not "unassign": an
            // import that omits the column must not strip an assignment made in
            // the app. Unassigning stays an explicit action in the assets UI.
            ...(assignedTo === null ? {} : { assignedTo }),
          })
          .where(and(eq(assets.id, existing.id), eq(assets.orgId, orgId)));
        return { table: "assets", id: existing.id, outcome: "updated" };
      }
    }

    const [asset] = await tx
      .insert(assets)
      .values({
        orgId,
        ...fields,
        serialNumber: row.serialNumber ?? null,
        assignedTo,
      })
      .returning({ id: assets.id });

    if (!asset) throw new Error("Failed to insert asset");
    return { table: "assets", id: asset.id, outcome: "created" };
  }

  private async commitDocument(tx: Tx, orgId: string, row: DocumentMetadataRow): Promise<CommitRef> {
    const person = await tx
      .select({ userId: hrPeople.userId })
      .from(hrPeople)
      .innerJoin(
        organizationPeople,
        and(
          eq(organizationPeople.organizationId, hrPeople.orgId),
          eq(organizationPeople.organizationPersonId, hrPeople.organizationPersonId),
        ),
      )
      .where(and(eq(hrPeople.orgId, orgId), isNull(hrPeople.deletedAt), eq(organizationPeople.workEmail, row.employeeEmail)))
      .limit(1);

    const userId = person[0]?.userId ?? null;

    const fields = {
      // The CSV's `type` column used to be parsed, validated and then thrown
      // away: every imported document was stored as OTHER. `document_type` is an
      // enum, so the row schema now rejects a value outside it rather than
      // quietly flattening OFFER_LETTER and ID_PROOF into one bucket.
      type: row.type,
      category: row.category ?? null,
      fileUrl: row.fileUrl,
      expiryDate: row.expiryDate || null,
      isActive: true,
    };

    // PROVISIONAL identity — open product decision #2. A document is the same
    // document when it is the same person's, in the same category, under the same
    // name. Without this the importer inserted unconditionally and re-running a
    // sheet doubled the file: QA's three rows became six.
    //
    // `is not distinct from` is what makes the org-wide document (userId null)
    // match itself; plain equality never matches NULL, so those rows would double
    // on every re-import. No unique index backs this yet — see decision #2.
    const [existing] = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.orgId, orgId),
          sql`${documents.userId} is not distinct from ${userId}`,
          sql`lower(trim(coalesce(${documents.category}, ''))) = ${normalizeName(row.category)}`,
          sql`lower(trim(${documents.name})) = ${normalizeName(row.name)}`,
        ),
      )
      .orderBy(asc(documents.id))
      .limit(1);

    if (existing) {
      await tx
        .update(documents)
        .set({ ...fields, name: row.name })
        .where(and(eq(documents.id, existing.id), eq(documents.orgId, orgId)));
      return { table: "documents", id: existing.id, outcome: "updated" };
    }

    const [doc] = await tx
      .insert(documents)
      .values({ orgId, userId, name: row.name, ...fields })
      .returning({ id: documents.id });

    if (!doc) throw new Error("Failed to insert document metadata");
    return { table: "documents", id: doc.id, outcome: "created" };
  }

  async rollbackRef(tx: Tx, ref: CommitRef): Promise<void> {
    const id = ref.id;
    if (ref.table === "hr_people") {
      await tx.delete(hrPeople).where(eq(hrPeople.id, id));
    } else if (ref.table === "attendance") {
      await tx.delete(attendance).where(eq(attendance.id, id));
    } else if (ref.table === "assets") {
      await tx.delete(assets).where(eq(assets.id, id));
    } else if (ref.table === "leave_balances") {
      await tx.delete(leaveBalances).where(eq(leaveBalances.id, id));
    } else if (ref.table === "documents") {
      await tx.delete(documents).where(eq(documents.id, id));
    }
  }

  async markRowCommitted(tx: Tx, rowId: string, ref: CommitRef): Promise<void> {
    await tx
      .update(hrImportRows)
      .set({ status: "committed", createdRecordRef: ref })
      .where(eq(hrImportRows.id, rowId));
  }
}
