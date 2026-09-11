import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  candidateReferenceChecks,
  candidateReferrals,
  candidates,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type {
  CreateReferenceCheckInput,
  CreateReferralInput,
  UpdateReferenceCheckInput,
  UpdateReferralInput,
} from "./dto/candidate-records.schemas";

@Injectable()
export class RecruitmentReferralChecksService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listReferrals(orgId: string, candidateId: number) {
    await this.ensureCandidate(orgId, candidateId);
    return this.db
      .select()
      .from(candidateReferrals)
      .where(
        and(
          eq(candidateReferrals.candidateId, candidateId),
          eq(candidateReferrals.orgId, orgId),
        ),
      )
      .limit(100);
  }

  async createReferral(
    orgId: string,
    candidateId: number,
    input: CreateReferralInput,
  ) {
    await this.ensureCandidate(orgId, candidateId);
    const [created] = await this.db
      .insert(candidateReferrals)
      .values({
        orgId,
        candidateId,
        referredBy: input.referredBy,
        relationship: input.relationship ?? null,
        notes: input.notes ?? null,
        bonusEligible: input.bonusEligible,
        bonusAmount:
          input.bonusAmount !== undefined ? String(input.bonusAmount) : null,
      })
      .returning();
    return created;
  }

  async updateReferral(
    orgId: string,
    candidateId: number,
    input: UpdateReferralInput,
  ) {
    const updates: Partial<typeof candidateReferrals.$inferInsert> = {};
    if (input.bonusEligible !== undefined)
      updates.bonusEligible = input.bonusEligible;
    if (input.bonusAmount !== undefined) {
      updates.bonusAmount =
        input.bonusAmount !== null ? String(input.bonusAmount) : null;
    }
    if (input.bonusPaidAt !== undefined) {
      updates.bonusPaidAt = input.bonusPaidAt
        ? new Date(input.bonusPaidAt)
        : null;
    }
    if (input.notes !== undefined) updates.notes = input.notes;

    const [updated] = await this.db
      .update(candidateReferrals)
      .set(updates)
      .where(
        and(
          eq(candidateReferrals.id, input.id),
          eq(candidateReferrals.orgId, orgId),
          eq(candidateReferrals.candidateId, candidateId),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException("Referral not found.");
    return updated;
  }

  async listReferenceChecks(orgId: string, candidateId: number) {
    await this.ensureCandidate(orgId, candidateId, "Candidate not found");
    return this.db.query.candidateReferenceChecks.findMany({
      limit: 100,
      where: and(
        eq(candidateReferenceChecks.candidateId, candidateId),
        eq(candidateReferenceChecks.orgId, orgId),
      ),
      orderBy: (t, { desc: d }) => [d(t.createdAt)],
    });
  }

  async createReferenceCheck(
    orgId: string,
    userId: string,
    candidateId: number,
    input: CreateReferenceCheckInput,
  ) {
    await this.ensureCandidate(orgId, candidateId, "Candidate not found");
    const [created] = await this.db
      .insert(candidateReferenceChecks)
      .values({
        candidateId,
        orgId,
        referenceName: input.referenceName,
        referenceDesignation: input.referenceDesignation ?? null,
        referenceCompany: input.referenceCompany ?? null,
        referenceEmail: input.referenceEmail ?? null,
        referencePhone: input.referencePhone ?? null,
        relationship: input.relationship ?? null,
        notes: input.notes ?? null,
        createdBy: userId,
      })
      .returning();
    return created;
  }

  async updateReferenceCheck(
    orgId: string,
    candidateId: number,
    checkId: number,
    input: UpdateReferenceCheckInput,
  ) {
    const existing = await this.db.query.candidateReferenceChecks.findFirst({
      where: and(
        eq(candidateReferenceChecks.id, checkId),
        eq(candidateReferenceChecks.candidateId, candidateId),
        eq(candidateReferenceChecks.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Reference check not found");

    const updateData: Partial<typeof candidateReferenceChecks.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (input.status !== undefined) updateData.status = input.status;
    if (input.outcome !== undefined) updateData.outcome = input.outcome;
    if (input.notes !== undefined) updateData.notes = input.notes;
    if (input.contactedAt !== undefined) {
      updateData.contactedAt = new Date(input.contactedAt);
    }
    if (input.referenceDesignation !== undefined) {
      updateData.referenceDesignation = input.referenceDesignation;
    }
    if (input.referenceCompany !== undefined) {
      updateData.referenceCompany = input.referenceCompany;
    }
    if (input.referenceEmail !== undefined) {
      updateData.referenceEmail = input.referenceEmail;
    }
    if (input.referencePhone !== undefined) {
      updateData.referencePhone = input.referencePhone;
    }

    await this.db
      .update(candidateReferenceChecks)
      .set(updateData)
      .where(
        and(
          eq(candidateReferenceChecks.id, checkId),
          eq(candidateReferenceChecks.orgId, orgId),
        ),
      );
    return { success: true };
  }

  async deleteReferenceCheck(
    orgId: string,
    candidateId: number,
    checkId: number,
  ) {
    const existing = await this.db.query.candidateReferenceChecks.findFirst({
      where: and(
        eq(candidateReferenceChecks.id, checkId),
        eq(candidateReferenceChecks.candidateId, candidateId),
        eq(candidateReferenceChecks.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Reference check not found");

    await this.db
      .delete(candidateReferenceChecks)
      .where(
        and(
          eq(candidateReferenceChecks.id, checkId),
          eq(candidateReferenceChecks.orgId, orgId),
        ),
      );
    return { success: true };
  }

  private async ensureCandidate(
    orgId: string,
    candidateId: number,
    message = "Candidate not found.",
  ): Promise<void> {
    const candidate = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
      columns: { id: true },
    });
    if (!candidate) throw new NotFoundException(message);
  }
}
