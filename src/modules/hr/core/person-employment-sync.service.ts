import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { organizationPeople } from "../../../db/schema/directory/organization-people";
import {
  hrEmployments,
  hrPeople,
  organizationMembers,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { HrAuditService } from "./hr-audit.service";

const BACKFILL_FETCH_SIZE = 100;
const BACKFILL_CONCURRENCY = 4;
const BACKFILL_ERROR_MESSAGE = "Member synchronization failed";

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

type PrefetchedActiveMember = {
  membershipId: number;
  userId: string;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  email: string;
  employeeId: string | null;
  designation: string | null;
  phone: string | null;
  joiningDate: string | null;
};

type BackfillResult = {
  scanned: number;
  createdPeople: number;
  createdEmployments: number;
  skipped: number;
  errors: Array<{ userId: string; message: string }>;
};

function toEnsureInput(
  user: Omit<PrefetchedActiveMember, "membershipId">,
  lifecycleStatus: EnsurePersonEmploymentInput["lifecycleStatus"],
): EnsurePersonEmploymentInput {
  const firstName = user.firstName?.trim() || user.name?.split(" ")[0] || "Employee";
  const lastName =
    user.lastName?.trim() ||
    user.name?.split(" ").slice(1).join(" ") ||
    "User";
  const employeeNumber =
    user.employeeId?.trim() || `EMP-${user.userId.slice(0, 8).toUpperCase()}`;

  return {
    userId: user.userId,
    firstName,
    lastName,
    workEmail: user.email,
    employeeNumber,
    joiningDate: user.joiningDate ?? null,
    designation: user.designation ?? null,
    phone: user.phone ?? null,
    lifecycleStatus,
  };
}

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
        employeeId: true,
        designation: true,
        phone: true,
        joiningDate: true,
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
          employeeId: user.employeeId,
          designation: user.designation,
          phone: user.phone,
          joiningDate: user.joiningDate,
        },
        lifecycleStatus,
      ),
      tx,
    );
  }

  async backfillOrg(
    orgId: string,
    actorId: string | null,
  ): Promise<BackfillResult> {
    const result: BackfillResult = {
      scanned: 0,
      createdPeople: 0,
      createdEmployments: 0,
      skipped: 0,
      errors: [],
    };
    const highWatermark = await this.getBackfillHighWatermark(orgId);

    if (highWatermark !== null) {
      let afterMembershipId = 0;
      while (afterMembershipId < highWatermark) {
        const members = await this.loadActiveMemberBatch(
          orgId,
          afterMembershipId,
          highWatermark,
        );
        if (members.length === 0) break;

        result.scanned += members.length;
        await this.processMemberBatch(orgId, actorId, members, result);

        const lastMember = members.at(-1);
        if (!lastMember) break;
        afterMembershipId = lastMember.membershipId;
        if (members.length < BACKFILL_FETCH_SIZE) break;
      }
    }

    await runInNewTenantTransaction(this.db, orgId, () =>
      this.audit.log({
        orgId,
        actorId,
        entityType: "hr_people",
        entityId: orgId,
        action: "backfill_from_members",
        after: {
          scanned: result.scanned,
          createdPeople: result.createdPeople,
          createdEmployments: result.createdEmployments,
          skipped: result.skipped,
          errorCount: result.errors.length,
        },
      }),
    );

    return result;
  }

  private async getBackfillHighWatermark(orgId: string): Promise<number | null> {
    return runInNewTenantTransaction(this.db, orgId, async (tx) => {
      const [row] = await tx
        .select({ membershipId: organizationMembers.id })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.status, "ACTIVE"),
          ),
        )
        .orderBy(desc(organizationMembers.id))
        .limit(1);
      return row?.membershipId ?? null;
    });
  }

  private loadActiveMemberBatch(
    orgId: string,
    afterMembershipId: number,
    highWatermark: number,
  ): Promise<PrefetchedActiveMember[]> {
    return runInNewTenantTransaction(this.db, orgId, (tx) =>
      tx
        .select({
          membershipId: organizationMembers.id,
          userId: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          name: users.name,
          email: users.email,
          employeeId: users.employeeId,
          designation: users.designation,
          phone: users.phone,
          joiningDate: users.joiningDate,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.status, "ACTIVE"),
            gt(organizationMembers.id, afterMembershipId),
            lte(organizationMembers.id, highWatermark),
          ),
        )
        .orderBy(asc(organizationMembers.id))
        .limit(BACKFILL_FETCH_SIZE),
    );
  }

  private async processMemberBatch(
    orgId: string,
    actorId: string | null,
    members: PrefetchedActiveMember[],
    result: BackfillResult,
  ): Promise<void> {
    for (let start = 0; start < members.length; start += BACKFILL_CONCURRENCY) {
      const window = members.slice(start, start + BACKFILL_CONCURRENCY);
      const settled = await Promise.allSettled(
        window.map((member) =>
          runInNewTenantTransaction(this.db, orgId, () =>
            this.ensureFromUser(orgId, actorId, toEnsureInput(member, "ACTIVE")),
          ),
        ),
      );

      for (let index = 0; index < settled.length; index += 1) {
        const outcome = settled[index];
        const member = window[index];
        if (!outcome || !member) continue;
        if (outcome.status === "rejected") {
          result.errors.push({
            userId: member.userId,
            message: BACKFILL_ERROR_MESSAGE,
          });
          continue;
        }
        if (outcome.value.createdPerson) result.createdPeople += 1;
        if (outcome.value.createdEmployment) result.createdEmployments += 1;
        if (!outcome.value.createdPerson && !outcome.value.createdEmployment)
          result.skipped += 1;
      }
    }
  }
}
