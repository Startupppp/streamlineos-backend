import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import {
  candidates,
  candidateOffers,
  hrPeople,
  hrEmployments,
  hrEmployeeSensitiveFields,
  users,
  organizationMembers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";

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

      const existingByUser = matchedUser
        ? await tx.query.hrPeople.findFirst({
            where: and(
              eq(hrPeople.orgId, orgId),
              eq(hrPeople.userId, matchedUser.id),
              isNull(hrPeople.deletedAt),
            ),
            columns: { id: true },
          })
        : null;

      const existingByEmail = await tx.query.hrPeople.findFirst({
        where: and(
          eq(hrPeople.orgId, orgId),
          eq(hrPeople.workEmail, workEmail),
          isNull(hrPeople.deletedAt),
        ),
        columns: { id: true, userId: true },
      });

      let personId: number;

      if (existingByUser) {
        personId = existingByUser.id;
      } else if (existingByEmail) {
        personId = existingByEmail.id;
        if (matchedUser && !existingByEmail.userId) {
          await tx
            .update(hrPeople)
            .set({
              userId: matchedUser.id,
              firstName: candidate.firstName,
              lastName: candidate.lastName,
              phone: candidate.phone ?? null,
            })
            .where(and(eq(hrPeople.id, personId), eq(hrPeople.orgId, orgId)));
        }
      } else {
        const [inserted] = await tx
          .insert(hrPeople)
          .values({
            orgId,
            userId: matchedUser?.id ?? null,
            firstName: candidate.firstName,
            lastName: candidate.lastName,
            workEmail,
            phone: candidate.phone ?? null,
          })
          .returning({ id: hrPeople.id });
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
        const employeeNumber = matchedUser
          ? (
              await tx.query.users.findFirst({
                where: eq(users.id, matchedUser.id),
                columns: { employeeId: true },
              })
            )?.employeeId?.trim() || `CAND-${candidateId}`
          : `CAND-${candidateId}`;

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
          await tx
            .insert(hrEmployeeSensitiveFields)
            .values({
              orgId,
              employmentId,
              salaryAmountCents,
              salaryCurrency: "INR",
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
