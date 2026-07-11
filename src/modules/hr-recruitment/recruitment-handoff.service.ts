import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import {
  candidates,
  candidateOffers,
  hrPeople,
  hrEmployments,
  hrEmployeeSensitiveFields,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";

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

    if (!candidate || !offer) return;

    const workEmail = candidate.email.toLowerCase();

    await this.db.transaction(async (tx) => {
      const existing = await tx.query.hrPeople.findFirst({
        where: and(
          eq(hrPeople.orgId, orgId),
          eq(hrPeople.workEmail, workEmail),
          isNull(hrPeople.deletedAt),
        ),
        columns: { id: true },
      });

      let personId: number;

      if (existing) {
        personId = existing.id;
      } else {
        const [inserted] = await tx
          .insert(hrPeople)
          .values({
            orgId,
            firstName: candidate.firstName,
            lastName: candidate.lastName,
            workEmail,
            phone: candidate.phone ?? null,
          })
          .returning({ id: hrPeople.id });

        personId = inserted.id;
      }

      const employeeNumber = `CAND-${candidateId}`;

      const [employment] = await tx
        .insert(hrEmployments)
        .values({
          orgId,
          personId,
          employeeNumber,
          lifecycleStatus: "PRE_JOINING",
          workerType: "FULL_TIME",
          designation: offer.offeredDesignation ?? null,
          joiningDate: offer.joiningDate ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: hrEmployments.id });

      const employmentId = employment?.id ?? (
        await tx.query.hrEmployments.findFirst({
          where: and(
            eq(hrEmployments.orgId, orgId),
            eq(hrEmployments.employeeNumber, employeeNumber),
          ),
          columns: { id: true },
        })
      )?.id;

      if (!employmentId) return;

      if (offer.offeredSalary) {
        const salaryAmountCents = Math.round(parseFloat(offer.offeredSalary) * 100);
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

      this.audit.log({
        action: "OFFER_ACCEPTED_HANDOFF",
        userId: "system",
        orgId,
        targetId: String(employmentId),
        targetType: "hr_employment",
        metadata: { candidateId, offerId, personId },
      });
    });
  }
}
