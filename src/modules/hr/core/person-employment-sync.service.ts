import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
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

    const [created] = await db
      .insert(organizationPeople)
      .values({ organizationId: orgId, userId, firstName, lastName, workEmail })
      .returning({ organizationPersonId: organizationPeople.organizationPersonId });
    if (!created) throw new Error("Failed to create canonical person record");
    return created.organizationPersonId;
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

    const byNumber = await db.query.hrEmployments.findFirst({
      where: and(
        eq(hrEmployments.orgId, orgId),
        eq(hrEmployments.employeeNumber, input.employeeNumber),
        isNull(hrEmployments.deletedAt),
      ),
    });

    if (byNumber) {
      if (byNumber.personId !== personId) {
        const suffix = input.userId.slice(0, 6).toUpperCase();
        const [created] = await db
          .insert(hrEmployments)
          .values({
            orgId,
            personId,
            employeeNumber: `${input.employeeNumber}-${suffix}`,
            lifecycleStatus: input.lifecycleStatus ?? "ONBOARDING",
            workerType: input.workerType ?? "FULL_TIME",
            designation: input.designation ?? null,
            joiningDate: input.joiningDate ?? null,
            isPrimary: true,
          })
          .returning({ id: hrEmployments.id });
        if (!created) throw new Error("Failed to create employment record");
        await this.audit.log(
          {
            orgId,
            actorId,
            entityType: "hr_employments",
            entityId: String(created.id),
            action: "synced_from_user",
            after: { personId, employeeNumber: `${input.employeeNumber}-${suffix}` },
          },
          tx,
        );
        return {
          personId,
          employmentId: created.id,
          createdPerson,
          createdEmployment: true,
        };
      }
      return {
        personId,
        employmentId: byNumber.id,
        createdPerson,
        createdEmployment: false,
      };
    }

    const [employment] = await db
      .insert(hrEmployments)
      .values({
        orgId,
        personId,
        employeeNumber: input.employeeNumber,
        lifecycleStatus: input.lifecycleStatus ?? "ONBOARDING",
        workerType: input.workerType ?? "FULL_TIME",
        designation: input.designation ?? null,
        joiningDate: input.joiningDate ?? null,
        isPrimary: true,
      })
      .returning({ id: hrEmployments.id });

    if (!employment) throw new Error("Failed to create employment record");

    await this.audit.log(
      {
        orgId,
        actorId,
        entityType: "hr_employments",
        entityId: String(employment.id),
        action: "synced_from_user",
        after: { personId, employeeNumber: input.employeeNumber },
      },
      tx,
    );

    return {
      personId,
      employmentId: employment.id,
      createdPerson,
      createdEmployment: true,
    };
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
