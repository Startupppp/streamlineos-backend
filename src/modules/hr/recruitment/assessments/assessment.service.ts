import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { candidates, interviews, organizations } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { AuditService } from "../../../../common/audit/audit.service";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { ProviderCredentialsService } from "../integrations/provider-credentials.service";
import { verifyVendorSignature } from "../integrations/vendor-signature";
import {
  ASSESSMENT_PLATFORM,
  normaliseScore,
  resolveAssessment,
  verdictFor,
} from "./assessment-provider";

export interface AssessmentView {
  id: number;
  candidateId: number;
  testId: string | null;
  reference: string | null;
  candidateUrl: string | null;
  result: "PENDING" | "PASSED" | "FAILED" | "NO_SHOW";
  score: number | null;
  scoredAt: Date | null;
  invitedAt: Date;
  /** Why an assessment cannot be sent from here, when it cannot. */
  providerBlockedReason: string | null;
}

const ASSESSMENT_PLATFORM_TAG = "ASSESSMENT";

@Injectable()
export class AssessmentService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly credentials: ProviderCredentialsService,
  ) {}

  async listForCandidate(orgId: string, candidateId: number): Promise<AssessmentView[]> {
    const rows = await this.db
      .select({
        id: interviews.id,
        candidateId: interviews.candidateId,
        externalRef: interviews.externalRef,
        meetingLink: interviews.meetingLink,
        notes: interviews.notes,
        result: interviews.result,
        rating: interviews.rating,
        scheduledAt: interviews.scheduledAt,
        updatedAt: interviews.updatedAt,
      })
      .from(interviews)
      .where(
        and(
          eq(interviews.orgId, orgId),
          eq(interviews.candidateId, candidateId),
          eq(interviews.type, "ASSESSMENT"),
        ),
      )
      .orderBy(desc(interviews.scheduledAt))
      .limit(50);

    const blocked = await this.blockedReason(orgId);
    return rows.map((row) => ({
      id: row.id,
      candidateId: row.candidateId,
      testId: row.notes,
      reference: row.externalRef,
      candidateUrl: row.meetingLink,
      result: row.result,
      score: row.rating,
      scoredAt: row.result === "PENDING" ? null : row.updatedAt,
      invitedAt: row.scheduledAt,
      providerBlockedReason: blocked,
    }));
  }

  /**
   * Sends a candidate a test, or explains why it cannot.
   *
   * Refuses before writing anything. A row created first and an invitation that
   * never went out would leave a recruiter watching a PENDING assessment for a
   * test nobody was ever sent — which is the same failure as a candidate parked
   * at INITIATED with no background check anywhere.
   */
  async invite(
    orgId: string,
    userId: string,
    membershipId: number | null,
    candidateId: number,
    testId: string,
  ): Promise<AssessmentView> {
    const candidate = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
      columns: { id: true, firstName: true, lastName: true, email: true },
    });
    if (!candidate) throw new NotFoundException("Candidate not found.");
    if (membershipId === null) {
      throw new BadRequestException("An assessment must be sent by a member of this organisation.");
    }

    const credentials = await this.credentials.forPlatform(orgId, ASSESSMENT_PLATFORM);
    const resolved = resolveAssessment(credentials);
    if (!("adapter" in resolved)) throw new BadRequestException(resolved.message);

    const accepted = await resolved.adapter.invite(resolved.credentials, {
      testId,
      candidateEmail: candidate.email,
      candidateName: `${candidate.firstName} ${candidate.lastName}`,
      externalCaseKey: randomUUID(),
    });

    const now = new Date();
    const [created] = await this.db
      .insert(interviews)
      .values({
        orgId,
        candidateId,
        type: "ASSESSMENT",
        scheduledAt: now,
        /*
          Zero minutes: an assessment has no scheduled slot to block. Leaving
          the default 60 would make the candidate look busy for an hour they
          are not, and the free/busy suggester reads exactly this column.
        */
        duration: 0,
        interviewerMembershipId: membershipId,
        interviewerId: userId,
        meetingLink: accepted.candidateUrl,
        notes: testId,
        externalRef: accepted.reference,
        externalPlatform: ASSESSMENT_PLATFORM_TAG,
        result: "PENDING",
        remindersSent: {},
      })
      .returning({ id: interviews.id });
    if (!created) throw new BadRequestException("Failed to record the assessment.");

    await this.audit.logCritical({
      action: "hr.recruitment.assessment.invited",
      orgId,
      userId,
      resourceType: "candidate",
      resourceId: String(candidateId),
      metadata: { testId, reference: accepted.reference },
    });

    const all = await this.listForCandidate(orgId, candidateId);
    const view = all.find((row) => row.id === created.id);
    if (!view) throw new BadRequestException("Assessment disappeared after being recorded.");
    return view;
  }

  /**
   * Records a score a vendor pushed to us.
   *
   * Idempotent by the vendor's own reference: a redelivery of a score already
   * recorded writes nothing and answers `replay`, so a vendor retrying does not
   * produce a second audit row claiming the candidate sat the test twice.
   */
  async recordScore(
    orgSlug: string,
    rawBody: Buffer | string,
    signature: string | undefined,
  ): Promise<{ replay: boolean; result: string; percent: number }> {
    const org = await this.db.query.organizations.findFirst({
      where: and(eq(organizations.slug, orgSlug), isNull(organizations.deletedAt)),
      columns: { id: true },
    });
    if (!org) throw new NotFoundException("Unknown organisation.");

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const credentials = await this.credentials.forPlatform(org.id, ASSESSMENT_PLATFORM);
        const secret =
          credentials && typeof credentials.meta.inboundSecret === "string"
            ? credentials.meta.inboundSecret
            : null;
        if (!secret) throw new ForbiddenException("No callback secret is configured.");
        if (!verifyVendorSignature(rawBody, secret, signature)) {
          throw new ForbiddenException("Signature did not match.");
        }

        const payload: unknown = JSON.parse(
          typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"),
        );
        const parsed = assessmentScorePayload(payload);
        if (!parsed) throw new BadRequestException("Score payload was not understood.");

        const normalised = normaliseScore(parsed.score, parsed.maxScore);
        if (!normalised) {
          throw new BadRequestException("Score was outside the range the vendor declared.");
        }

        const row = await tx.query.interviews.findFirst({
          where: and(
            eq(interviews.orgId, org.id),
            eq(interviews.externalPlatform, ASSESSMENT_PLATFORM_TAG),
            eq(interviews.externalRef, parsed.reference),
          ),
          columns: { id: true, candidateId: true, result: true, rating: true },
        });
        if (!row) throw new NotFoundException("No assessment matches that reference.");

        const passPercent =
          credentials && typeof credentials.meta.passPercent === "number"
            ? credentials.meta.passPercent
            : null;
        const verdict = verdictFor(normalised.percent, passPercent);

        if (row.result !== "PENDING" && row.rating === Math.round(normalised.percent)) {
          return { replay: true, result: row.result, percent: normalised.percent };
        }

        await tx
          .update(interviews)
          .set({
            /*
              PENDING when the organisation has set no pass mark. Writing PASSED
              on a default bar would put a verdict on a candidate's record that
              this product invented rather than the organisation deciding.
            */
            result: verdict ?? "PENDING",
            rating: Math.round(normalised.percent),
            feedback: `Scored ${normalised.score} of ${normalised.maxScore} (${normalised.percent}%).`,
          })
          .where(and(eq(interviews.id, row.id), eq(interviews.orgId, org.id)));

        await this.audit.logCritical({
          action: "hr.recruitment.assessment.scored",
          orgId: org.id,
          systemActor: "assessment-vendor-callback",
          resourceType: "candidate",
          resourceId: String(row.candidateId),
          metadata: {
            reference: parsed.reference,
            percent: normalised.percent,
            verdict: verdict ?? "NO_PASS_MARK_SET",
          },
        });

        return { replay: false, result: verdict ?? "PENDING", percent: normalised.percent };
      },
      { orgId: org.id },
    );
  }

  private async blockedReason(orgId: string): Promise<string | null> {
    const credentials = await this.credentials.forPlatform(orgId, ASSESSMENT_PLATFORM);
    const resolved = resolveAssessment(credentials);
    return "adapter" in resolved ? null : resolved.message;
  }
}

/**
 * The shape a vendor's score webhook must have, checked without a schema
 * library so the failure is a `null` the caller turns into a 400 rather than a
 * thrown ZodError from inside a transaction.
 */
function assessmentScorePayload(
  value: unknown,
): { reference: string; score: number; maxScore: number } | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("reference" in value) || !("score" in value) || !("maxScore" in value)) return null;
  const { reference, score, maxScore } = value as Record<string, unknown>;
  if (typeof reference !== "string" || reference.length === 0 || reference.length > 200) return null;
  if (typeof score !== "number" || typeof maxScore !== "number") return null;
  return { reference, score, maxScore };
}
