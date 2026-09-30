import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { isUniqueViolation } from "../../../common/db/postgres-error";
import { organizationPeople } from "../../../db/schema/directory/organization-people";
import {
  hrEmployments,
  hrPeople,
  organizationMembers,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { HrAuditService } from "./hr-audit.service";
import {
  toEnsureInput,
  type EnsurePersonEmploymentInput,
  type EnsurePersonEmploymentResult,
} from "./person-employment-sync.types";
import {
  ensureManyFromUsers,
  type EnsureManyInput,
  type EnsureManyRow,
} from "./person-employment-sync-batch";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";

@Injectable()
export class PersonEmploymentSyncService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
  ) {}

  private async resolveOrgPersonId(
    db: Db,
    orgId: string,
    userId: string,
    workEmail: string,
    firstName: string,
    lastName: string,
  ): Promise<string> {
    const byUser = await db.query.organizationPeople.findFirst({
      where: and(
        eq(organizationPeople.organizationId, orgId),
        eq(organizationPeople.userId, userId),
        isNull(organizationPeople.deletedAt),
      ),
      columns: { organizationPersonId: true },
    });
    if (byUser) return byUser.organizationPersonId;

    const byEmail = await db.query.organizationPeople.findFirst({
      where: and(
        eq(organizationPeople.organizationId, orgId),
        sql`lower(trim(${organizationPeople.workEmail})) = ${workEmail}`,
        isNull(organizationPeople.deletedAt),
      ),
      columns: { organizationPersonId: true },
    });
    if (byEmail) return byEmail.organizationPersonId;

    const restored = await this.restoreDeletedOrgPerson(db, orgId, userId, workEmail);
    if (restored) return restored;

    try {
      const [created] = await db
        .insert(organizationPeople)
        .values({ organizationId: orgId, userId, firstName, lastName, workEmail })
        .returning({ organizationPersonId: organizationPeople.organizationPersonId });
      if (!created) throw new Error("Failed to create canonical person record");
      return created.organizationPersonId;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      throw new ConflictException({
        code: "DIRECTORY_PERSON_ALREADY_LINKED",
        message:
          "This person already exists in the organization directory. Refresh and select that person instead.",
      });
    }
  }

  private async restoreDeletedOrgPerson(
    db: Db,
    orgId: string,
    userId: string,
    workEmail: string,
  ): Promise<string | null> {
    const deletedByUser = await db.query.organizationPeople.findFirst({
      where: and(
        eq(organizationPeople.organizationId, orgId),
        eq(organizationPeople.userId, userId),
        isNotNull(organizationPeople.deletedAt),
      ),
      columns: { organizationPersonId: true },
    });
    const deleted =
      deletedByUser ??
      (await db.query.organizationPeople.findFirst({
        where: and(
          eq(organizationPeople.organizationId, orgId),
          sql`lower(trim(${organizationPeople.workEmail})) = ${workEmail}`,
          isNotNull(organizationPeople.deletedAt),
        ),
        columns: { organizationPersonId: true },
      }));
    if (!deleted) return null;

    const [row] = await db
      .update(organizationPeople)
      .set({ deletedAt: null, userId })
      .where(
        and(
          eq(organizationPeople.organizationPersonId, deleted.organizationPersonId),
          eq(organizationPeople.organizationId, orgId),
          isNotNull(organizationPeople.deletedAt),
        ),
      )
      .returning({ organizationPersonId: organizationPeople.organizationPersonId });
    return row?.organizationPersonId ?? null;
  }

  private async restoreDeletedPerson(
    db: Db,
    orgId: string,
    userId: string,
    organizationPersonId: string,
  ): Promise<number | null> {
    const deleted = await db.query.hrPeople.findFirst({
      where: and(
        eq(hrPeople.orgId, orgId),
        eq(hrPeople.organizationPersonId, organizationPersonId),
        isNotNull(hrPeople.deletedAt),
      ),
      columns: { id: true },
    });
    if (!deleted) return null;

    const [row] = await db
      .update(hrPeople)
      .set({ deletedAt: null, userId })
      .where(and(eq(hrPeople.id, deleted.id), eq(hrPeople.orgId, orgId)))
      .returning({ id: hrPeople.id });
    return row?.id ?? null;
  }

  /**
   * Batched `ensureFromUser` for an import: fixed statement count for any batch
   * size, and one audit INSERT instead of one per person.
   */
  async ensureManyFromUsers(
    orgId: string,
    actorId: string | null,
    inputs: readonly EnsureManyInput[],
    tx: DbOrTx,
  ): Promise<EnsureManyRow[]> {
    const outcome = await ensureManyFromUsers(tx, orgId, inputs);
    if (outcome.auditEntries.length > 0)
      await this.audit.logMany({ orgId, actorId, entries: outcome.auditEntries }, tx);
    return outcome.rows;
  }

  async ensureFromUser(
    orgId: string,
    actorId: string | null,
    input: EnsurePersonEmploymentInput,
    tx?: Db,
  ): Promise<EnsurePersonEmploymentResult> {
    const db = tx ?? this.db;
    const email = input.workEmail.toLowerCase().trim();

    const existingPersonByUser = await db.query.hrPeople.findFirst({
      where: and(
        eq(hrPeople.orgId, orgId),
        eq(hrPeople.userId, input.userId),
        isNull(hrPeople.deletedAt),
      ),
    });

    let personId: number;
    let createdPerson = false;

    if (existingPersonByUser) {
      personId = existingPersonByUser.id;
    } else {
      const [existingByEmail] = await db
        .select({ id: hrPeople.id, organizationPersonId: hrPeople.organizationPersonId })
        .from(hrPeople)
        .innerJoin(
          organizationPeople,
          and(
            eq(organizationPeople.organizationId, hrPeople.orgId),
            eq(organizationPeople.organizationPersonId, hrPeople.organizationPersonId),
          ),
        )
        .where(
          and(
            eq(hrPeople.orgId, orgId),
            sql`lower(trim(${organizationPeople.workEmail})) = ${email}`,
            isNull(hrPeople.deletedAt),
          ),
        )
        .limit(1);

      if (existingByEmail) {
        const linkId = existingByEmail.organizationPersonId === null
          ? await this.resolveOrgPersonId(db, orgId, input.userId, email, input.firstName, input.lastName)
          : null;
        await db
          .update(hrPeople)
          .set({
            userId: input.userId,
            ...(linkId !== null && { organizationPersonId: linkId }),
          })
          .where(and(eq(hrPeople.id, existingByEmail.id), eq(hrPeople.orgId, orgId)));
        personId = existingByEmail.id;
      } else {
        const organizationPersonId = await this.resolveOrgPersonId(
          db, orgId, input.userId, email, input.firstName, input.lastName,
        );
        const restoredPersonId = await this.restoreDeletedPerson(
          db, orgId, input.userId, organizationPersonId,
        );
        if (restoredPersonId !== null) {
          personId = restoredPersonId;
        } else {
          const [created] = await db
            .insert(hrPeople)
            .values({
              orgId,
              userId: input.userId,
              organizationPersonId,
            })
            .returning({ id: hrPeople.id });
          if (!created) throw new Error("Failed to create person record");
          personId = created.id;
          createdPerson = true;
          await this.audit.log(
            {
              orgId,
              actorId,
              entityType: "hr_people",
              entityId: String(personId),
              action: "synced_from_user",
              after: { userId: input.userId, workEmail: email },
            },
            tx,
          );
        }
      }
    }

    const existingEmployment = await db.query.hrEmployments.findFirst({
      where: and(
        eq(hrEmployments.orgId, orgId),
        eq(hrEmployments.personId, personId),
        eq(hrEmployments.isPrimary, true),
        isNull(hrEmployments.deletedAt),
      ),
    });

    if (existingEmployment) {
      return {
        personId,
        employmentId: existingEmployment.id,
        createdPerson,
        createdEmployment: false,
      };
    }

    const suffix = input.userId.slice(0, 6).toUpperCase();
    const claimed =
      (await this.claimEmploymentNumber(db, orgId, personId, input.employeeNumber, input)) ??
      (await this.claimEmploymentNumber(
        db,
        orgId,
        personId,
        `${input.employeeNumber}-${suffix}`,
        input,
      ));

    if (!claimed)
      throw new ConflictException(
        `Employee number "${input.employeeNumber}" is already in use in this organization.`,
      );

    if (claimed.createdEmployment)
      await this.audit.log(
        {
          orgId,
          actorId,
          entityType: "hr_employments",
          entityId: String(claimed.employmentId),
          action: "synced_from_user",
          after: { personId, employeeNumber: claimed.employeeNumber },
        },
        tx,
      );

    return {
      personId,
      employmentId: claimed.employmentId,
      createdPerson,
      createdEmployment: claimed.createdEmployment,
    };
  }

  private async claimEmploymentNumber(
    db: Db,
    orgId: string,
    personId: number,
    employeeNumber: string,
    input: EnsurePersonEmploymentInput,
  ): Promise<
    { employmentId: number; employeeNumber: string; createdEmployment: boolean } | null
  > {
    const existing = await db.query.hrEmployments.findFirst({
      where: and(
        eq(hrEmployments.orgId, orgId),
        eq(hrEmployments.employeeNumber, employeeNumber),
      ),
    });

    if (existing) {
      if (existing.personId !== personId) return null;
      if (existing.deletedAt === null)
        return { employmentId: existing.id, employeeNumber, createdEmployment: false };

      const [restored] = await db
        .update(hrEmployments)
        .set({
          deletedAt: null,
          lifecycleStatus: input.lifecycleStatus ?? "ONBOARDING",
          isPrimary: true,
        })
        .where(
          and(
            eq(hrEmployments.id, existing.id),
            eq(hrEmployments.orgId, orgId),
            isNotNull(hrEmployments.deletedAt),
          ),
        )
        .returning({ id: hrEmployments.id });
      if (!restored) return null;
      return { employmentId: restored.id, employeeNumber, createdEmployment: false };
    }

    const [created] = await db
      .insert(hrEmployments)
      .values({
        orgId,
        personId,
        employeeNumber,
        lifecycleStatus: input.lifecycleStatus ?? "ONBOARDING",
        workerType: input.workerType ?? "FULL_TIME",
        designation: input.designation ?? null,
        joiningDate: input.joiningDate ?? null,
        locationId: input.locationId ?? null,
        isPrimary: true,
      })
      .returning({ id: hrEmployments.id });

    if (!created) return null;
    return { employmentId: created.id, employeeNumber, createdEmployment: true };
  }

  async ensureFromUserId(
    orgId: string,
    actorId: string | null,
    userId: string,
    tx?: Db,
    lifecycleStatus: EnsurePersonEmploymentInput["lifecycleStatus"] = "ACTIVE",
  ): Promise<EnsurePersonEmploymentResult | null> {
    const db = tx ?? this.db;
    const membership = await db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { userId: true },
    });
    if (!membership) return null;

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true,
        firstName: true,
        lastName: true,
        name: true,
        email: true,
        phone: true,
      },
    });
    if (!user?.email) return null;

    return this.ensureFromUser(
      orgId,
      actorId,
      toEnsureInput(
        {
          userId: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          name: user.name,
          email: user.email,
          phone: user.phone,
        },
        lifecycleStatus,
      ),
      tx,
    );
  }
}
