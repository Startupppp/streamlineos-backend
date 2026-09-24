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
  canComplete,
  parseVoiceScreenResult,
  resolveVoiceScreen,
  VOICE_SCREEN_PLATFORM,
} from "./voice-screen";

const VOICE_PLATFORM_TAG = "VOICE_SCREEN";

export interface VoiceScreenView {
  id: number;
  candidateId: number;
  reference: string | null;
  result: "PENDING" | "PASSED" | "FAILED" | "NO_SHOW";
  rating: number | null;
  /** The questions the screen was asked to put, as stored. */
  script: string[];
  /** The answers, once a result has come back. Empty until then. */
  answers: Array<{ question: string; answer: string; confidence: number | null }>;
  requestedAt: Date;
  /** Present only once a screen has genuinely completed. */
  completedBy: "PROVIDER" | "RECRUITER" | null;
  providerBlockedReason: string | null;
}

interface StoredScreen {
  script: string[];
  answers: Array<{ question: string; answer: string; confidence: number | null }>;
  completedBy: "PROVIDER" | "RECRUITER" | null;
}

/**
 * The screen's own data lives in `interviews.rubric`, which is already jsonb.
 *
 * Not a new column and certainly not a new table: a voice screen is an
 * evaluation producing a score against a set of questions, which is exactly
 * what `rubric` holds for every other interview type.
 */
function readStored(rubric: unknown): StoredScreen {
  if (typeof rubric !== "object" || rubric === null) {
    return { script: [], answers: [], completedBy: null };
  }
  const record = rubric as Record<string, unknown>;
  return {
    script: Array.isArray(record.script) ? record.script.filter((q): q is string => typeof q === "string") : [],
    answers: Array.isArray(record.answers)
      ? (record.answers as StoredScreen["answers"])
      : [],
    completedBy:
      record.completedBy === "PROVIDER" || record.completedBy === "RECRUITER"
        ? record.completedBy
        : null,
  };
}

@Injectable()
export class VoiceScreenService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly credentials: ProviderCredentialsService,
  ) {}

  async listForCandidate(orgId: string, candidateId: number): Promise<VoiceScreenView[]> {
    const rows = await this.db
      .select({
        id: interviews.id,
        candidateId: interviews.candidateId,
        externalRef: interviews.externalRef,
        result: interviews.result,
        rating: interviews.rating,
        rubric: interviews.rubric,
        scheduledAt: interviews.scheduledAt,
      })
      .from(interviews)
      .where(
        and(
          eq(interviews.orgId, orgId),
          eq(interviews.candidateId, candidateId),
          eq(interviews.type, "VOICE_SCREEN"),
        ),
      )
      .orderBy(desc(interviews.scheduledAt))
      .limit(50);

    const blocked = await this.blockedReason(orgId);
    return rows.map((row) => {
      const stored = readStored(row.rubric);
      return {
        id: row.id,
        candidateId: row.candidateId,
        reference: row.externalRef,
        result: row.result,
        rating: row.rating,
        script: stored.script,
        answers: stored.answers,
        requestedAt: row.scheduledAt,
        completedBy: stored.completedBy,
        providerBlockedReason: blocked,
      };
    });
  }

  /**
   * Asks the vendor to place the call.
   *
   * Three things must be true before a row exists: a script, the candidate's
   * consent to an automated call, and a phone number. The consent is the one
   * that cannot be inferred — an automated voice calling somebody who never
   * agreed to it is the failure this gate exists for, and a screen requested
   * without it would leave that fact nowhere in the record.
   */
  async request(
    orgId: string,
    userId: string,
    membershipId: number | null,
    candidateId: number,
    script: readonly string[],
    consentAt: Date,
  ): Promise<VoiceScreenView> {
    if (membershipId === null) {
      throw new BadRequestException("A voice screen must be requested by a member of this organisation.");
    }

    const candidate = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
      columns: { id: true, firstName: true, lastName: true, phone: true },
    });
    if (!candidate) throw new NotFoundException("Candidate not found.");
    if (!candidate.phone) {
      throw new BadRequestException("This candidate has no phone number on record.");
    }
    if (consentAt.getTime() > Date.now() + 60_000) {
      throw new BadRequestException("Consent cannot be recorded in the future.");
    }

    const credentials = await this.credentials.forPlatform(orgId, VOICE_SCREEN_PLATFORM);
    const resolved = resolveVoiceScreen(credentials);
    if (!("adapter" in resolved)) throw new BadRequestException(resolved.message);

    const accepted = await resolved.adapter.place(resolved.credentials, {
      candidateName: `${candidate.firstName} ${candidate.lastName}`,
      candidatePhone: candidate.phone,
      script: [...script],
      externalCaseKey: randomUUID(),
    });

    const now = new Date();
    const [created] = await this.db
      .insert(interviews)
      .values({
        orgId,
        candidateId,
        type: "VOICE_SCREEN",
        scheduledAt: now,
        duration: 0,
        interviewerId: userId,
        interviewerMembershipId: membershipId,
        externalRef: accepted.reference,
        externalPlatform: VOICE_PLATFORM_TAG,
        /*
          PENDING, and it stays PENDING until a result arrives. Nothing here
          marks a screen complete on the strength of having asked for one.
        */
        result: "PENDING",
        rubric: { script: [...script], answers: [], completedBy: null } as never,
        remindersSent: {},
      })
      .returning({ id: interviews.id });
    if (!created) throw new BadRequestException("Failed to record the voice screen.");

    await this.audit.logCritical({
      action: "hr.recruitment.voice_screen.requested",
      orgId,
      userId,
      resourceType: "candidate",
      resourceId: String(candidateId),
      metadata: {
        reference: accepted.reference,
        questions: script.length,
        consentAt: consentAt.toISOString(),
      },
    });

    const all = await this.listForCandidate(orgId, candidateId);
    const view = all.find((row) => row.id === created.id);
    if (!view) throw new BadRequestException("Voice screen disappeared after being recorded.");
    return view;
  }

  /** Records a result the vendor pushed to us. */
  async recordResult(
    orgSlug: string,
    rawBody: Buffer | string,
    signature: string | undefined,
  ): Promise<{ replay: boolean; answers: number }> {
    const org = await this.db.query.organizations.findFirst({
      where: and(eq(organizations.slug, orgSlug), isNull(organizations.deletedAt)),
      columns: { id: true },
    });
    if (!org) throw new NotFoundException("Unknown organisation.");

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const credentials = await this.credentials.forPlatform(org.id, VOICE_SCREEN_PLATFORM);
        const secret =
          credentials && typeof credentials.meta.inboundSecret === "string"
            ? credentials.meta.inboundSecret
            : null;
        if (!secret) throw new ForbiddenException("No callback secret is configured.");
        if (!verifyVendorSignature(rawBody, secret, signature)) {
          throw new ForbiddenException("Signature did not match.");
        }

        const parsed = parseVoiceScreenResult(
          JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")),
        );
        if (!parsed) throw new BadRequestException("Result payload was not understood.");

        const row = await tx.query.interviews.findFirst({
          where: and(
            eq(interviews.orgId, org.id),
            eq(interviews.externalPlatform, VOICE_PLATFORM_TAG),
            eq(interviews.externalRef, parsed.reference),
          ),
          columns: { id: true, candidateId: true, rubric: true, result: true },
        });
        if (!row) throw new NotFoundException("No voice screen matches that reference.");

        const stored = readStored(row.rubric);
        if (stored.completedBy !== null) {
          return { replay: true, answers: stored.answers.length };
        }

        /*
          `canComplete` is consulted rather than assumed: a provider result with
          no answers is a call that did not happen, and marking it complete
          would put "screened" on a candidate nobody spoke to.
        */
        const complete = canComplete("PROVIDER", parsed.answers.length > 0);

        await tx
          .update(interviews)
          .set({
            result: complete ? (parsed.rating !== null && parsed.rating >= 3 ? "PASSED" : "FAILED") : "NO_SHOW",
            rating: parsed.rating,
            rubric: {
              script: stored.script,
              answers: parsed.answers,
              completedBy: complete ? "PROVIDER" : null,
            } as never,
          })
          .where(and(eq(interviews.id, row.id), eq(interviews.orgId, org.id)));

        await this.audit.logCritical({
          action: "hr.recruitment.voice_screen.result",
          orgId: org.id,
          systemActor: "voice-screen-vendor-callback",
          resourceType: "candidate",
          resourceId: String(row.candidateId),
          metadata: {
            reference: parsed.reference,
            answers: parsed.answers.length,
            rating: parsed.rating,
            completed: complete,
          },
        });

        return { replay: false, answers: parsed.answers.length };
      },
      { orgId: org.id },
    );
  }

  private async blockedReason(orgId: string): Promise<string | null> {
    const credentials = await this.credentials.forPlatform(orgId, VOICE_SCREEN_PLATFORM);
    const resolved = resolveVoiceScreen(credentials);
    return "adapter" in resolved ? null : resolved.message;
  }
}
