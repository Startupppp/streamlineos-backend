import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { candidateApplications, candidates, jobPostings } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { AuditService } from "../../../../common/audit/audit.service";
import { ProviderCredentialsService } from "../integrations/provider-credentials.service";
import {
  IDENTITY_PLATFORM,
  offerGate,
  resolveIdentity,
  type IdentityStatus,
  type OfferGate,
} from "./identity-policy";

export interface IdentityView {
  candidateId: number;
  status: IdentityStatus;
  reference: string | null;
  /** Trailing characters of the document, never the document. */
  last4: string | null;
  verifiedAt: Date | null;
  /** Whether any job this candidate applied to demands verification. */
  requiredByAJob: boolean;
  providerBlockedReason: string | null;
}

@Injectable()
export class IdentityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly credentials: ProviderCredentialsService,
  ) {}

  async read(orgId: string, candidateId: number): Promise<IdentityView> {
    const row = await this.candidate(orgId, candidateId);
    const [required] = await this.db
      .select({ requires: jobPostings.requiresIdentityVerification })
      .from(candidateApplications)
      .innerJoin(
        jobPostings,
        and(
          eq(jobPostings.orgId, candidateApplications.orgId),
          eq(jobPostings.id, candidateApplications.jobPostingId),
        ),
      )
      .where(
        and(
          eq(candidateApplications.orgId, orgId),
          eq(candidateApplications.candidateId, candidateId),
          eq(jobPostings.requiresIdentityVerification, true),
        ),
      )
      .limit(1);

    return {
      candidateId,
      status: (row.identityStatus ?? "NOT_STARTED") as IdentityStatus,
      reference: row.identityReference,
      last4: row.identityLast4,
      verifiedAt: row.identityVerifiedAt,
      requiredByAJob: required?.requires === true,
      providerBlockedReason: await this.blockedReason(orgId),
    };
  }

  /**
   * Runs a verification against the vendor token the candidate's own session
   * produced.
   *
   * The token is all that leaves this process. A raw PAN or Aadhaar is never
   * accepted as a parameter, so there is no path by which one could be stored
   * or forwarded even by mistake.
   */
  async verify(
    orgId: string,
    userId: string,
    candidateId: number,
    vendorToken: string,
  ): Promise<IdentityView> {
    await this.candidate(orgId, candidateId);

    const credentials = await this.credentials.forPlatform(orgId, IDENTITY_PLATFORM);
    const resolved = resolveIdentity(credentials);
    if (!("adapter" in resolved)) {
      /*
        UNAVAILABLE is written, not FAILED. The vendor never ran a check, so
        nothing is known about this person's identity — and `offerGate` treats
        UNAVAILABLE as blocking, so the policy still holds while the integration
        is missing.
      */
      await this.write(orgId, candidateId, { identityStatus: "UNAVAILABLE" });
      throw new BadRequestException(resolved.message);
    }

    const accepted = await resolved.adapter.verify(resolved.credentials, {
      vendorToken,
      externalCaseKey: `${orgId}:${candidateId}`,
    });

    const now = new Date();
    await this.write(orgId, candidateId, {
      identityStatus: "VERIFIED",
      identityReference: accepted.reference,
      identityLast4: accepted.last4,
      identityVerifiedAt: now,
    });

    await this.audit.logCritical({
      action: "hr.recruitment.identity.verified",
      orgId,
      userId,
      resourceType: "candidate",
      resourceId: String(candidateId),
      metadata: { reference: accepted.reference, storedLast4: accepted.last4 !== null },
    });

    return this.read(orgId, candidateId);
  }

  /**
   * Whether an offer for this job may be finalised for this candidate.
   *
   * Called by the offer path rather than duplicated there, so the policy has
   * one implementation and the answer carries its own reason.
   */
  async gateForOffer(orgId: string, candidateId: number, jobPostingId: number | null): Promise<OfferGate> {
    if (jobPostingId === null) return { allowed: true };

    const job = await this.db.query.jobPostings.findFirst({
      where: and(eq(jobPostings.id, jobPostingId), eq(jobPostings.orgId, orgId)),
      columns: { requiresIdentityVerification: true },
    });
    if (!job?.requiresIdentityVerification) return { allowed: true };

    const row = await this.candidate(orgId, candidateId);
    return offerGate(true, (row.identityStatus ?? "NOT_STARTED") as IdentityStatus);
  }

  private async write(
    orgId: string,
    candidateId: number,
    fields: Partial<typeof candidates.$inferInsert>,
  ) {
    await this.db
      .update(candidates)
      .set({ ...fields, updatedAt: new Date() })
      .where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)));
  }

  private async candidate(orgId: string, candidateId: number) {
    const row = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
      columns: {
        id: true,
        identityStatus: true,
        identityReference: true,
        identityLast4: true,
        identityVerifiedAt: true,
      },
    });
    if (!row) throw new NotFoundException("Candidate not found.");
    return row;
  }

  private async blockedReason(orgId: string): Promise<string | null> {
    const credentials = await this.credentials.forPlatform(orgId, IDENTITY_PLATFORM);
    const resolved = resolveIdentity(credentials);
    return "adapter" in resolved ? null : resolved.message;
  }
}
