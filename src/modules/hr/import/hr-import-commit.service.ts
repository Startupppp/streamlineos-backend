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
  attendanceInstant,
} from "./schemas/entity-row-schemas";
import type { HrImportEntity } from "./dto/import-job.dto";
import { normalizeCode, normalizeName } from "./schemas/import-row-identity";
import { MembershipAdmissionService, admissionRefusalMessage, canonicalAdmissionEmail } from "../../organization/core/membership-admission.service";
import type { AdmissionOutcome } from "../../organization/core/membership-admission.service";
import type { MembershipMutations } from "../../../common/org/membership-mutations";
import { PersonEmploymentSyncService } from "../core/person-employment-sync.service";
import { ORG_MEMBER_ROLES } from "../../../common/rbac/org-roles";

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

/**
 * Who is importing, and the membership writer their writes must go through.
 *
 * Only the employees entity needs these: it is the one import that admits people
 * to the organisation. The other four resolve an existing person and are given
 * the context anyway so every commit path has one shape.
 */
export interface ImportCommitContext {
  orgId: string;
  actorId: string;
  membership: MembershipMutations;
}

@Injectable()
export class HrImportCommitService {
  constructor(
    private readonly admission: MembershipAdmissionService,
    private readonly personEmployment: PersonEmploymentSyncService,
  ) {}

  async commitRow(
    tx: Tx,
    ctx: ImportCommitContext,
    entity: HrImportEntity,
    payload: Record<string, unknown>,
  ): Promise<CommitRef | null> {
    const orgId = ctx.orgId;
    if (entity === "employees") return this.commitEmployee(tx, ctx, employeeRowSchema.parse(payload));
    if (entity === "leave_balances") return this.commitLeaveBalance(tx, orgId, leaveBalanceRowSchema.parse(payload));
    if (entity === "attendance") return this.commitAttendance(tx, orgId, attendanceRowSchema.parse(payload));
    if (entity === "assets") return this.commitAsset(tx, orgId, assetRowSchema.parse(payload));
    if (entity === "document_metadata") return this.commitDocument(tx, orgId, documentMetadataRowSchema.parse(payload));
    return null;
  }

  /**
   * HRMS-E2E-003. The import used to write `organization_people`, `hr_people`
   * and `hr_employments` directly and stop there — but the employee directory
   * reads FROM organization_members INNER JOIN users and only LEFT JOINs
   * hr_people (employees.service.ts:156). An imported employee had neither a
   * user account nor a membership, so the directory could never show one.
   * That is the whole of "Committed, Valid 5, Errors 0 but 0 new employees":
   * five rows really were written, to three tables nothing lists from.
   *
   * It also stranded every other import. `commitLeaveBalance`,
   * `commitAttendance`, `commitDocument` and `commitAsset` all resolve
   * `hr_people.user_id`, which this path left NULL — so a leave balance or an
   * attendance row for an imported employee failed with "No user found for
   * email" no matter how correct the file was.
   *
   * The row now goes through the same two services the single-hire form uses:
   * `MembershipAdmissionService` admits the person (user + membership, seat
   * accounting included) and `PersonEmploymentSyncService.ensureFromUser`
   * establishes the canonical person and employment. Both are idempotent, which
   * is what makes re-importing a corrected sheet an update rather than a second
   * employee.
   */
  private async commitEmployee(tx: Tx, ctx: ImportCommitContext, row: EmployeeRow): Promise<CommitRef> {
    const orgId = ctx.orgId;
    const email = canonicalAdmissionEmail(row.email);

    const outcome = await this.admission.admitOne(tx, {
      orgId,
      email,
      role: ORG_MEMBER_ROLES.MEMBER,
      actor: { userId: ctx.actorId },
      membership: ctx.membership,
      seatReason: "hr-employee-import",
      createUserIfMissing: {
        name: `${row.firstName} ${row.lastName}`.trim(),
        firstName: row.firstName,
        lastName: row.lastName,
        phone: row.phone ?? null,
        gender: row.gender ?? null,
        isActive: true,
      },
    });

    const admitted = this.resolveAdmission(outcome, row.email);

    // A person already in the organisation is an update, not a refusal: the
    // ordinary correction workflow is to fix a column and re-upload the sheet.
    const existing = admitted.outcome === "updated";

    const employeeNumber = row.employeeNumber?.trim() || `EMP-${admitted.userId.slice(0, 8).toUpperCase()}`;
    await this.assertEmployeeNumberFree(tx, orgId, employeeNumber, admitted.userId, row.employeeNumber);

    const ensured = await this.personEmployment.ensureFromUser(
      orgId,
      ctx.actorId,
      {
        userId: admitted.userId,
        firstName: row.firstName,
        lastName: row.lastName,
        workEmail: email,
        employeeNumber,
        joiningDate: row.joiningDate || null,
        designation: row.designation ?? null,
        phone: row.phone ?? null,
        // PROVISIONAL — open product decision #4. An imported hire has not
        // accepted an invitation, so it is staged rather than counted as active
        // headcount. Same rung the single-hire form uses.
        lifecycleStatus: "ONBOARDING",
      },
      tx as unknown as Db,
    );

    // The columns an operator re-uploads to correct. `ensureFromUser` creates
    // the employment but leaves an existing one alone, so the sheet's values are
    // applied here or a second import would silently change nothing.
    await tx
      .update(hrEmployments)
      .set({
        ...(row.designation === undefined ? {} : { designation: row.designation || null }),
        ...(row.joiningDate ? { joiningDate: row.joiningDate } : {}),
      })
      .where(and(eq(hrEmployments.orgId, orgId), eq(hrEmployments.id, ensured.employmentId)));

    await tx
      .update(organizationPeople)
      .set({
        firstName: row.firstName,
        lastName: row.lastName,
        ...(row.phone ? { phone: row.phone } : {}),
        ...(row.gender ? { gender: row.gender } : {}),
      })
      .where(
        and(
          eq(organizationPeople.organizationId, orgId),
          sql`lower(trim(${organizationPeople.workEmail})) = ${email}`,
        ),
      );

    return {
      table: "hr_people",
      id: ensured.personId,
      outcome: existing && !ensured.createdPerson ? "updated" : "created",
    };
  }

  /** Turns an admission refusal into the row error an operator can act on. */
  private resolveAdmission(
    outcome: AdmissionOutcome,
    email: string,
  ): { userId: string; outcome: CommitOutcome } {
    if (outcome.kind === "admitted")
      return { userId: outcome.userId, outcome: outcome.createdUser ? "created" : "updated" };

    if (outcome.kind === "conflict" && outcome.reason === "already-member" && outcome.userId)
      return { userId: outcome.userId, outcome: "updated" };

    throw new Error(`${email}: ${admissionRefusalMessage(outcome)}`);
  }

  /**
   * An employee number is the organisation's own identifier for a person, so two
   * people may not share one. Without this the sheet's later row silently won an
   * `onConflictDoNothing`, or `ensureFromUser` quietly appended a suffix and the
   * operator got a number they never typed.
   */
  private async assertEmployeeNumberFree(
    tx: Tx,
    orgId: string,
    employeeNumber: string,
    userId: string,
    stated: string | undefined,
  ): Promise<void> {
    if (!stated?.trim()) return;
    const [taken] = await tx
      .select({ userId: hrPeople.userId })
      .from(hrEmployments)
      .innerJoin(hrPeople, and(eq(hrPeople.orgId, orgId), eq(hrPeople.id, hrEmployments.personId)))
      .where(and(eq(hrEmployments.orgId, orgId), eq(hrEmployments.employeeNumber, employeeNumber)))
      .limit(1);
    if (taken && taken.userId !== userId)
      throw new ConflictException(
        `Employee number "${employeeNumber}" already belongs to someone else in this organization.`,
      );
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

    // `new Date("09:30")` is an Invalid Date, and 09:30 is exactly what the
    // import dialog documents this column as. Every row written in the
    // documented format therefore failed at insert time with an error the file
    // gave no clue about. `attendanceInstant` reads a wall clock on the row's
    // own date in the organisation's zone, and passes a full timestamp through.
    const checkIn = attendanceInstant(row.date, row.checkIn);
    const checkOut = attendanceInstant(row.date, row.checkOut);

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
