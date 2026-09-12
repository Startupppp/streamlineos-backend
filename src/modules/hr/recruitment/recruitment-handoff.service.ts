import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  candidates,
  candidateOffers,
  hrPeople,
  hrEmployments,
  hrEmployeeSensitiveFields,
  organizationPeople,
  users,
  organizationMembers,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { getPostgresErrorDetails } from "../../../common/db/postgres-error";
import { resolveOrgSalaryCurrency } from "../directory/employment-salary-currency";

/**
 * Offer accepted → single Person + Employment path.
 * Reuses existing person by work email; links userId when a matching org member exists.
 * Never creates a second person for the same candidate email.
 */
@Injectable()
export class RecruitmentHandoffService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async handleOfferAccepted(orgId: string, candidateId: number, offerId: number): Promise<void> {
    const [candidate, offer] = await Promise.all([
      this.db.query.candidates.findFirst({
        where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
        columns: { firstName: true, lastName: true, email: true, phone: true },
      }),
      this.db.query.candidateOffers.findFirst({
        where: and(eq(candidateOffers.id, offerId), eq(candidateOffers.orgId, orgId)),
        columns: { offeredSalary: true, offeredDesignation: true, joiningDate: true },
      }),
    ]);

    if (!candidate?.email || !offer) return;

    const workEmail = candidate.email.toLowerCase().trim();

    await this.db.transaction(async (tx) => {
      const matchedUser = await tx
        .select({ id: users.id })
        .from(users)
        .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(users.email, workEmail),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);

      const orgPersonRow = matchedUser
        ? await tx.query.organizationPeople.findFirst({
            where: and(
              eq(organizationPeople.organizationId, orgId),
              eq(organizationPeople.userId, matchedUser.id),
              isNull(organizationPeople.deletedAt),
            ),
            columns: { organizationPersonId: true },
          })
        : await tx.query.organizationPeople.findFirst({
            where: and(
              eq(organizationPeople.organizationId, orgId),
              sql`lower(trim(${organizationPeople.workEmail})) = ${workEmail}`,
              isNull(organizationPeople.deletedAt),
            ),
            columns: { organizationPersonId: true },
          });

      const resolvedOrgPersonId = orgPersonRow?.organizationPersonId
        ?? await tx
            .insert(organizationPeople)
            .values({
              organizationId: orgId,
              userId: matchedUser?.id ?? null,
              firstName: candidate.firstName,
              lastName: candidate.lastName,
              workEmail,
              phone: candidate.phone ?? null,
            })
            .returning({ organizationPersonId: organizationPeople.organizationPersonId })
            .then((rows) => {
              const row = rows[0];
              if (!row) throw new Error("Failed to create canonical person record");
              return row.organizationPersonId;
            });

      const existingByUser = matchedUser
        ? await tx.query.hrPeople.findFirst({
            where: and(
              eq(hrPeople.orgId, orgId),
              eq(hrPeople.userId, matchedUser.id),
              isNull(hrPeople.deletedAt),
            ),
            columns: { id: true, organizationPersonId: true },
          })
        : null;

      const [existingByEmail] = await tx
        .select({
          id: hrPeople.id,
          userId: hrPeople.userId,
          organizationPersonId: hrPeople.organizationPersonId,
        })
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
            eq(organizationPeople.workEmail, workEmail),
            isNull(hrPeople.deletedAt),
          ),
        )
        .limit(1);

      let personId: number;

      if (existingByUser) {
        personId = existingByUser.id;
        if (existingByUser.organizationPersonId === null)
          await tx
            .update(hrPeople)
            .set({ organizationPersonId: resolvedOrgPersonId })
            .where(and(eq(hrPeople.id, personId), eq(hrPeople.orgId, orgId)))
            .catch((err: unknown) => {
              const { code, constraint } = getPostgresErrorDetails(err);
              if (code === "23505" && constraint === "uniq_hr_people_org_person_link")
                throw new ConflictException("This person already has an employment record in this organisation");
              throw err;
            });
      } else if (existingByEmail) {
        personId = existingByEmail.id;
        const needsLink = existingByEmail.organizationPersonId === null;
        const needsUserUpdate = matchedUser && !existingByEmail.userId;
        if (needsUserUpdate || needsLink)
          await tx
            .update(hrPeople)
            .set({
              ...(needsUserUpdate && {
                userId: matchedUser.id,
                firstName: candidate.firstName,
                lastName: candidate.lastName,
                phone: candidate.phone ?? null,
              }),
              ...(needsLink && { organizationPersonId: resolvedOrgPersonId }),
            })
            .where(and(eq(hrPeople.id, personId), eq(hrPeople.orgId, orgId)))
            .catch((err: unknown) => {
              const { code, constraint } = getPostgresErrorDetails(err);
              if (code === "23505" && constraint === "uniq_hr_people_org_person_link")
                throw new ConflictException("This person already has an employment record in this organisation");
              throw err;
            });
      } else {
        const [inserted] = await tx
          .insert(hrPeople)
          .values({
            orgId,
            userId: matchedUser?.id ?? null,
            organizationPersonId: resolvedOrgPersonId,
          })
          .returning({ id: hrPeople.id })
          .catch((err: unknown) => {
            const { code, constraint } = getPostgresErrorDetails(err);
            if (code === "23505" && constraint === "uniq_hr_people_org_person_link")
              throw new ConflictException("This person already has an employment record in this organisation");
            throw err;
          });
        personId = inserted.id;
      }

      const primaryEmployment = await tx.query.hrEmployments.findFirst({
        where: and(
          eq(hrEmployments.orgId, orgId),
          eq(hrEmployments.personId, personId),
          eq(hrEmployments.isPrimary, true),
          isNull(hrEmployments.deletedAt),
        ),
        columns: { id: true },
      });

      let employmentId = primaryEmployment?.id;

      if (!employmentId) {
        const employeeNumber = `CAND-${candidateId}`;

        const existingByNumber = await tx.query.hrEmployments.findFirst({
          where: and(
            eq(hrEmployments.orgId, orgId),
            eq(hrEmployments.employeeNumber, employeeNumber),
            isNull(hrEmployments.deletedAt),
          ),
          columns: { id: true, personId: true },
        });

        if (existingByNumber && existingByNumber.personId === personId) {
          employmentId = existingByNumber.id;
        } else if (existingByNumber && existingByNumber.personId !== personId) {
          const [created] = await tx
            .insert(hrEmployments)
            .values({
              orgId,
              personId,
              employeeNumber: `CAND-${candidateId}`,
              lifecycleStatus: "PRE_JOINING",
              workerType: "FULL_TIME",
              designation: offer.offeredDesignation ?? null,
              joiningDate: offer.joiningDate ?? null,
              isPrimary: true,
            })
            .returning({ id: hrEmployments.id });
          employmentId = created.id;
        } else {
          const [created] = await tx
            .insert(hrEmployments)
            .values({
              orgId,
              personId,
              employeeNumber,
              lifecycleStatus: "PRE_JOINING",
              workerType: "FULL_TIME",
              designation: offer.offeredDesignation ?? null,
              joiningDate: offer.joiningDate ?? null,
              isPrimary: true,
            })
            .returning({ id: hrEmployments.id });
          employmentId = created.id;
        }
      } else {
        await tx
          .update(hrEmployments)
          .set({
            lifecycleStatus: "PRE_JOINING",
            designation: offer.offeredDesignation ?? null,
            joiningDate: offer.joiningDate ?? null,
          })
          .where(and(eq(hrEmployments.id, employmentId), eq(hrEmployments.orgId, orgId)));
      }

      if (!employmentId) return;

      if (offer.offeredSalary) {
        const salaryAmountCents = Math.round(parseFloat(offer.offeredSalary) * 100);
        if (Number.isFinite(salaryAmountCents)) {
          const salaryCurrency = await resolveOrgSalaryCurrency(tx, orgId);
          await tx
            .insert(hrEmployeeSensitiveFields)
            .values({
              orgId,
              employmentId,
              salaryAmountCents,
              salaryCurrency,
              salaryFrequency: "MONTHLY",
            })
            .onConflictDoUpdate({
              target: hrEmployeeSensitiveFields.employmentId,
              set: { salaryAmountCents },
            });
        }
      }

      this.audit.log({
        action: "OFFER_ACCEPTED_HANDOFF",
        userId: "system",
        orgId,
        targetId: String(employmentId),
        targetType: "hr_employment",
        metadata: {
          candidateId,
          offerId,
          personId,
          linkedUserId: matchedUser?.id ?? null,
          reusedPerson: Boolean(existingByUser || existingByEmail),
        },
      });
    });
  }
}
