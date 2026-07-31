import { Injectable, Inject } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  hrPeople,
  hrEmployments,
  attendance,
  assets,
  leaveBalances,
  leaveTypes,
  documents,
} from "../../../db/schema";
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

export interface CommitRef {
  table: string;
  id: string | number;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

@Injectable()
export class HrImportCommitService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

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

  private async commitEmployee(tx: Tx, orgId: string, row: EmployeeRow): Promise<CommitRef> {
    const [person] = await tx
      .insert(hrPeople)
      .values({
        orgId,
        firstName: row.firstName,
        lastName: row.lastName,
        workEmail: row.email,
        phone: row.phone ?? null,
        gender: row.gender ?? null,
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
      return { table: "hr_people", id: person.id };
    }

    const existing = await tx
      .select({ id: hrPeople.id })
      .from(hrPeople)
      .where(and(eq(hrPeople.orgId, orgId), eq(hrPeople.workEmail, row.email)))
      .limit(1);

    const existingId = existing[0]?.id;
    if (!existingId) throw new Error(`Employee with email ${row.email} could not be inserted or found`);
    return { table: "hr_people", id: existingId };
  }

  private async commitLeaveBalance(tx: Tx, orgId: string, row: LeaveBalanceRow): Promise<CommitRef> {
    const person = await tx
      .select({ userId: hrPeople.userId })
      .from(hrPeople)
      .where(and(eq(hrPeople.orgId, orgId), eq(hrPeople.workEmail, row.employeeEmail)))
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

    const [lb] = await tx
      .insert(leaveBalances)
      .values({ orgId, userId, leaveTypeId, balance, year })
      .onConflictDoUpdate({
        target: [leaveBalances.userId, leaveBalances.leaveTypeId, leaveBalances.year],
        set: { balance },
      })
      .returning({ id: leaveBalances.id });

    if (!lb) throw new Error("Failed to upsert leave balance");
    return { table: "leave_balances", id: lb.id };
  }

  private async commitAttendance(tx: Tx, orgId: string, row: AttendanceRow): Promise<CommitRef> {
    const person = await tx
      .select({ userId: hrPeople.userId })
      .from(hrPeople)
      .where(and(eq(hrPeople.orgId, orgId), eq(hrPeople.workEmail, row.employeeEmail)))
      .limit(1);

    const userId = person[0]?.userId;
    if (!userId) throw new Error(`No user found for email ${row.employeeEmail}`);

    const checkIn = row.checkIn ? new Date(row.checkIn) : null;
    const checkOut = row.checkOut ? new Date(row.checkOut) : null;

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
      .onConflictDoNothing()
      .returning({ id: attendance.id });

    if (!rec) throw new Error(`Attendance for ${row.employeeEmail} on ${row.date} already exists`);
    return { table: "attendance", id: rec.id };
  }

  private async commitAsset(tx: Tx, orgId: string, row: AssetRow): Promise<CommitRef> {
    let assignedTo: string | null = null;

    if (row.assignedToEmail) {
      const person = await tx
        .select({ userId: hrPeople.userId })
        .from(hrPeople)
        .where(and(eq(hrPeople.orgId, orgId), eq(hrPeople.workEmail, row.assignedToEmail)))
        .limit(1);
      assignedTo = person[0]?.userId ?? null;
    }

    const [asset] = await tx
      .insert(assets)
      .values({
        orgId,
        name: row.name,
        type: row.type,
        brand: row.brand ?? null,
        model: row.model ?? null,
        serialNumber: row.serialNumber ?? null,
        assignedTo,
        status: row.status ?? "AVAILABLE",
        purchaseDate: row.purchaseDate || null,
        location: row.location ?? null,
      })
      .returning({ id: assets.id });

    if (!asset) throw new Error("Failed to insert asset");
    return { table: "assets", id: asset.id };
  }

  private async commitDocument(tx: Tx, orgId: string, row: DocumentMetadataRow): Promise<CommitRef> {
    const person = await tx
      .select({ userId: hrPeople.userId })
      .from(hrPeople)
      .where(and(eq(hrPeople.orgId, orgId), eq(hrPeople.workEmail, row.employeeEmail)))
      .limit(1);

    const userId = person[0]?.userId ?? null;

    const [doc] = await tx
      .insert(documents)
      .values({
        orgId,
        userId,
        name: row.name,
        type: "OTHER",
        category: row.category ?? null,
        fileUrl: row.fileUrl,
        expiryDate: row.expiryDate || null,
        isActive: true,
      })
      .returning({ id: documents.id });

    if (!doc) throw new Error("Failed to insert document metadata");
    return { table: "documents", id: doc.id };
  }

  async rollbackRef(tx: Tx, ref: CommitRef): Promise<void> {
    const id = ref.id;
    if (ref.table === "hr_people") {
      await tx.delete(hrPeople).where(eq(hrPeople.id, id as number));
    } else if (ref.table === "attendance") {
      await tx.delete(attendance).where(eq(attendance.id, id as number));
    } else if (ref.table === "assets") {
      await tx.delete(assets).where(eq(assets.id, id as number));
    } else if (ref.table === "leave_balances") {
      await tx.delete(leaveBalances).where(eq(leaveBalances.id, id as number));
    } else if (ref.table === "documents") {
      await tx.delete(documents).where(eq(documents.id, id as number));
    }
  }

  async markRowCommitted(tx: Tx, rowId: string, ref: CommitRef): Promise<void> {
    await tx
      .update(hrImportRows)
      .set({ status: "committed", createdRecordRef: ref })
      .where(eq(hrImportRows.id, rowId));
  }
}
