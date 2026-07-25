import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import {
  hrEmployments,
  hrPeople,
  organizationMembers,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { HrAuditService } from "./hr-audit.service";

export type EnsurePersonEmploymentInput = {
  userId: string;
  firstName: string;
  lastName: string;
  workEmail: string;
  employeeNumber: string;
  joiningDate?: string | null;
  designation?: string | null;
  phone?: string | null;
  lifecycleStatus?:
    | "PRE_JOINING"
    | "ONBOARDING"
    | "ACTIVE"
    | "PROBATION"
    | "CONFIRMED";
  workerType?:
    | "FULL_TIME"
    | "PART_TIME"
    | "CONTRACTOR"
    | "CONSULTANT"
    | "INTERN"
    | "TEMPORARY"
    | "AGENCY"
    | "FREELANCER";
};

export type EnsurePersonEmploymentResult = {
  personId: number;
  employmentId: number;
  createdPerson: boolean;
  createdEmployment: boolean;
};

@Injectable()
export class PersonEmploymentSyncService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
  ) {}

  async ensureFromUser(
    orgId: string,
    actorId: string,
    input: EnsurePersonEmploymentInput,
  ): Promise<EnsurePersonEmploymentResult> {
    const email = input.workEmail.toLowerCase().trim();

    const existingPersonByUser = await this.db.query.hrPeople.findFirst({
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
      const existingByEmail = await this.db.query.hrPeople.findFirst({
        where: and(
          eq(hrPeople.orgId, orgId),
          eq(hrPeople.workEmail, email),
          isNull(hrPeople.deletedAt),
        ),
      });

      if (existingByEmail) {
        await this.db
          .update(hrPeople)
          .set({
            userId: input.userId,
            firstName: input.firstName,
            lastName: input.lastName,
            phone: input.phone ?? existingByEmail.phone,
          })
          .where(and(eq(hrPeople.id, existingByEmail.id), eq(hrPeople.orgId, orgId)));
        personId = existingByEmail.id;
      } else {
        const [created] = await this.db
          .insert(hrPeople)
          .values({
            orgId,
            userId: input.userId,
            firstName: input.firstName,
            lastName: input.lastName,
            workEmail: email,
            phone: input.phone ?? null,
          })
          .returning({ id: hrPeople.id });
        if (!created) throw new Error("Failed to create person record");
        personId = created.id;
        createdPerson = true;
        await this.audit.log({
          orgId,
          actorId,
          entityType: "hr_people",
          entityId: String(personId),
          action: "synced_from_user",
          after: { userId: input.userId, workEmail: email },
        });
      }
    }

    const existingEmployment = await this.db.query.hrEmployments.findFirst({
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

    const byNumber = await this.db.query.hrEmployments.findFirst({
      where: and(
        eq(hrEmployments.orgId, orgId),
        eq(hrEmployments.employeeNumber, input.employeeNumber),
        isNull(hrEmployments.deletedAt),
      ),
    });

    if (byNumber) {
      if (byNumber.personId !== personId) {
        const suffix = input.userId.slice(0, 6).toUpperCase();
        const [created] = await this.db
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
        await this.audit.log({
          orgId,
          actorId,
          entityType: "hr_employments",
          entityId: String(created.id),
          action: "synced_from_user",
          after: { personId, employeeNumber: `${input.employeeNumber}-${suffix}` },
        });
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

    const [employment] = await this.db
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

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_employments",
      entityId: String(employment.id),
      action: "synced_from_user",
      after: { personId, employeeNumber: input.employeeNumber },
    });

    return {
      personId,
      employmentId: employment.id,
      createdPerson,
      createdEmployment: true,
    };
  }

  async ensureFromUserId(
    orgId: string,
    actorId: string,
    userId: string,
  ): Promise<EnsurePersonEmploymentResult | null> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true,
        firstName: true,
        lastName: true,
        name: true,
        email: true,
        employeeId: true,
        designation: true,
        phone: true,
        joiningDate: true,
      },
    });
    if (!user?.email) return null;

    const firstName = user.firstName?.trim() || user.name?.split(" ")[0] || "Employee";
    const lastName =
      user.lastName?.trim() ||
      user.name?.split(" ").slice(1).join(" ") ||
      "User";
    const employeeNumber = user.employeeId?.trim() || `EMP-${userId.slice(0, 8).toUpperCase()}`;

    return this.ensureFromUser(orgId, actorId, {
      userId: user.id,
      firstName,
      lastName,
      workEmail: user.email,
      employeeNumber,
      joiningDate: user.joiningDate ?? null,
      designation: user.designation ?? null,
      phone: user.phone ?? null,
      lifecycleStatus: "ACTIVE",
    });
  }

  async backfillOrg(
    orgId: string,
    actorId: string,
  ): Promise<{
    scanned: number;
    createdPeople: number;
    createdEmployments: number;
    skipped: number;
    errors: Array<{ userId: string; message: string }>;
  }> {
    const members = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, orgId));

    let createdPeople = 0;
    let createdEmployments = 0;
    let skipped = 0;
    const errors: Array<{ userId: string; message: string }> = [];

    for (const member of members) {
      try {
        const result = await this.ensureFromUserId(orgId, actorId, member.userId);
        if (!result) {
          skipped += 1;
          continue;
        }
        if (result.createdPerson) createdPeople += 1;
        if (result.createdEmployment) createdEmployments += 1;
        if (!result.createdPerson && !result.createdEmployment) skipped += 1;
      } catch (err) {
        errors.push({
          userId: member.userId,
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_people",
      entityId: orgId,
      action: "backfill_from_members",
      after: {
        scanned: members.length,
        createdPeople,
        createdEmployments,
        skipped,
        errorCount: errors.length,
      },
    });

    return {
      scanned: members.length,
      createdPeople,
      createdEmployments,
      skipped,
      errors,
    };
  }
}
