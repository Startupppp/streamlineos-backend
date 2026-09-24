import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import { interviews } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { AuditService } from "../../../../common/audit/audit.service";
import { ProviderCredentialsService } from "../../recruitment/integrations/provider-credentials.service";
import {
  DEFAULT_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  resolveTranscription,
  TRANSCRIPTION_PLATFORM,
} from "./transcription-provider";

export interface StoreTranscriptInput {
  text: string;
  /**
   * When the candidate agreed to being recorded. Required, and a real instant:
   * a transcript held without one is a recording of somebody who never said yes.
   */
  consentAt: Date;
  retentionDays?: number;
}

export interface TranscriptView {
  interviewId: number;
  transcript: string | null;
  source: "MANUAL_UPLOAD" | "PROVIDER" | null;
  consentAt: Date | null;
  retainUntil: Date | null;
  storedAt: Date | null;
  /** Why an automatic transcription is unavailable, when it is. */
  providerBlockedReason: string | null;
}

@Injectable()
export class InterviewTranscriptService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly credentials: ProviderCredentialsService,
  ) {}

  /**
   * Stores a transcript somebody typed or pasted in.
   *
   * This path exists whether or not a vendor is connected, and it writes the
   * same column the vendor path would, so nothing downstream has to know which
   * produced it beyond `transcript_source`.
   */
  async store(
    orgId: string,
    userId: string,
    membershipId: number | null,
    interviewId: number,
    input: StoreTranscriptInput,
  ): Promise<TranscriptView> {
    const existing = await this.db.query.interviews.findFirst({
      where: and(eq(interviews.id, interviewId), eq(interviews.orgId, orgId)),
      columns: { id: true, scheduledAt: true },
    });
    if (!existing) throw new NotFoundException("Interview not found.");

    /*
      Consent cannot be in the future and cannot predate the interview by more
      than a day. Both bounds catch the same mistake from opposite sides: a
      client sending `new Date()` for a consent that was never asked for, and a
      client sending an epoch or a default that would make the record look like
      consent was collected years before the conversation happened.
    */
    const now = new Date();
    if (input.consentAt.getTime() > now.getTime() + 60_000) {
      throw new BadRequestException("Consent cannot be recorded in the future.");
    }
    const earliest = existing.scheduledAt.getTime() - 24 * 60 * 60 * 1000;
    if (input.consentAt.getTime() < earliest) {
      throw new BadRequestException(
        "Consent must have been given around the time of the interview.",
      );
    }

    const retentionDays = Math.min(
      input.retentionDays ?? DEFAULT_RETENTION_DAYS,
      MAX_RETENTION_DAYS,
    );
    const retainUntil = new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);

    await this.db
      .update(interviews)
      .set({
        transcript: input.text,
        transcriptSource: "MANUAL_UPLOAD",
        transcriptConsentAt: input.consentAt,
        transcriptRetainUntil: retainUntil,
        transcriptStoredAt: now,
        transcriptStoredByMembershipId: membershipId,
      })
      .where(and(eq(interviews.id, interviewId), eq(interviews.orgId, orgId)));

    /*
      logCritical, not log. This row is the evidence that a named person stored
      a recording of a conversation under a stated consent, which is what a
      DPDP request is answered from. Best-effort telemetry that drops silently
      would leave the transcript in the database with no trace of its basis.
    */
    await this.audit.logCritical({
      action: "hr.interviews.transcript.stored",
      orgId,
      userId,
      resourceType: "interview",
      resourceId: String(interviewId),
      metadata: {
        source: "MANUAL_UPLOAD",
        characters: input.text.length,
        consentAt: input.consentAt.toISOString(),
        retainUntil: retainUntil.toISOString(),
      },
    });

    return this.read(orgId, userId, interviewId, { audit: false });
  }

  /**
   * Reads a transcript, and records who read it.
   *
   * The audit write is the point of routing this through a service rather than
   * widening the interview detail query. A transcript is the most sensitive
   * thing on an interview — it is the candidate's own words — and "who has read
   * this" is a question an organisation has to be able to answer.
   */
  async read(
    orgId: string,
    userId: string,
    interviewId: number,
    options: { audit?: boolean } = {},
  ): Promise<TranscriptView> {
    const row = await this.db.query.interviews.findFirst({
      where: and(eq(interviews.id, interviewId), eq(interviews.orgId, orgId)),
      columns: {
        id: true,
        transcript: true,
        transcriptSource: true,
        transcriptConsentAt: true,
        transcriptRetainUntil: true,
        transcriptStoredAt: true,
      },
    });
    if (!row) throw new NotFoundException("Interview not found.");

    if (options.audit !== false && row.transcript !== null) {
      this.audit.log({
        action: "hr.interviews.transcript.viewed",
        orgId,
        userId,
        resourceType: "interview",
        resourceId: String(interviewId),
      });
    }

    return {
      interviewId,
      transcript: row.transcript,
      source: row.transcriptSource,
      consentAt: row.transcriptConsentAt,
      retainUntil: row.transcriptRetainUntil,
      storedAt: row.transcriptStoredAt,
      providerBlockedReason: await this.providerBlockedReason(orgId),
    };
  }

  /**
   * Deletes a transcript and says so in the log.
   *
   * A hard delete, deliberately, and one of the exceptions the soft-delete rule
   * names: an erasure request is not satisfied by a row that is still there
   * with a flag set.
   */
  async erase(
    orgId: string,
    userId: string,
    interviewId: number,
    reason: string,
  ): Promise<{ erased: boolean }> {
    const [updated] = await this.db
      .update(interviews)
      .set({
        transcript: null,
        transcriptSource: null,
        transcriptConsentAt: null,
        transcriptRetainUntil: null,
        transcriptStoredAt: null,
        transcriptStoredByMembershipId: null,
      })
      .where(
        and(
          eq(interviews.id, interviewId),
          eq(interviews.orgId, orgId),
          isNotNull(interviews.transcript),
        ),
      )
      .returning({ id: interviews.id });

    if (!updated) return { erased: false };

    await this.audit.logCritical({
      action: "hr.interviews.transcript.erased",
      orgId,
      userId,
      resourceType: "interview",
      resourceId: String(interviewId),
      metadata: { reason },
    });
    return { erased: true };
  }

  /**
   * Transcripts whose retention date has passed, for the sweep to erase.
   *
   * Returned rather than deleted here so the caller owns the tenant loop and
   * the batching; this service is called per organisation.
   */
  async expired(orgId: string, now: Date, limit = 200): Promise<number[]> {
    const rows = await this.db
      .select({ id: interviews.id })
      .from(interviews)
      .where(
        and(
          eq(interviews.orgId, orgId),
          isNotNull(interviews.transcript),
          isNotNull(interviews.transcriptRetainUntil),
          lte(interviews.transcriptRetainUntil, now),
        ),
      )
      .limit(limit);
    return rows.map((row) => row.id);
  }

  /**
   * Whether an automatic transcription could run, and why not.
   *
   * Surfaced on every read so the screen offering the manual upload can say
   * what the alternative would need, instead of presenting hand-typing as the
   * only thing that was ever intended.
   */
  private async providerBlockedReason(orgId: string): Promise<string | null> {
    const credentials = await this.credentials.forPlatform(orgId, TRANSCRIPTION_PLATFORM);
    const resolved = resolveTranscription(credentials);
    return "adapter" in resolved ? null : resolved.message;
  }

  /**
   * The automatic path, which refuses rather than inventing a transcript.
   *
   * Kept as a real method rather than left unwritten, because the shape of the
   * refusal is the deliverable: a caller gets a 400 naming the missing vendor,
   * never a transcript nobody transcribed.
   */
  async transcribeRecording(orgId: string, interviewId: number): Promise<never> {
    const credentials = await this.credentials.forPlatform(orgId, TRANSCRIPTION_PLATFORM);
    const resolved = resolveTranscription(credentials);
    if (!("adapter" in resolved)) {
      throw new ForbiddenException(resolved.message);
    }
    /*
      Unreachable: `TRANSCRIPTION_ADAPTERS` is empty by design. Wiring a vendor
      is one map entry plus the call here, and until then this branch cannot
      produce a transcript because there is nothing to produce one with.
    */
    throw new BadRequestException(
      `No transcription ran for interview ${interviewId}; the adapter is registered but unimplemented.`,
    );
  }
}
