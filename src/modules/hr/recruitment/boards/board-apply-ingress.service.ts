import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  candidates,
  jobBoardPostings,
  jobPostings,
  organizations,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { outboundRequest } from "../../../../common/http/outbound-request";
import { AuditService } from "../../../../common/audit/audit.service";
import { PlanLimitsService } from "../../../billing/core/plan-limits.service";
import { StorageService } from "../../../storage/storage.service";
import { FileQuarantineService } from "../../../storage/file-quarantine.service";
import { AvScanner } from "../../../../common/security/av-scan";
import { logger } from "../../../../common/logger/logger.service";
import { orgOwnerUserId } from "../../../../common/org/org-owner-actor";
import { recordApplication, type ApplyResult } from "../../../public/public-careers-apply";
import {
  prepareResume,
  recordResumeQuarantine,
  RESUME_MAX_BYTES,
  type ResumeIntake,
} from "../../../public/careers-resume-intake";
import { ProviderCredentialsService } from "../integrations/provider-credentials.service";
import { isSupportedBoard } from "./job-board-adapters";
import { normaliseBoardApply, verifyBoardSignature } from "./board-apply-payload";

const RESUME_FETCH_TIMEOUT_MS = 15_000;

/**
 * Applications arriving from a job board, through the same door as the careers
 * form.
 *
 * The temptation here is a second apply implementation, and §10.3 of the
 * inventory is a record of what that costs: the product already had two
 * half-doors, one with consent and an event and no org scope, the other with
 * org scope and neither. So this service does the three things that are
 * genuinely different about an inbound webhook — prove the board sent it,
 * translate its vocabulary, fetch the résumé it linked rather than received —
 * and then calls `recordApplication`, which is the one place an application is
 * written.
 *
 * Three properties the public apply path does not have to worry about:
 *
 * - **Authenticity.** There is no session. The body is HMAC-verified against a
 *   per-organisation, per-board secret before any field is read.
 * - **Idempotency.** A board retries its webhook. `candidates.external_id`
 *   carries `{platform}:{applicationId}`, and a repeat is answered with the
 *   original outcome rather than a second candidate.
 * - **Consent.** A board that sends no consent signal produces an application
 *   with `consentAt: null`. That is not a degraded application; it is an
 *   accurate one, and it is what stops the sequence sender from mailing that
 *   person.
 */
@Injectable()
export class BoardApplyIngressService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly credentials: ProviderCredentialsService,
    private readonly planLimits: PlanLimitsService,
    private readonly storage: StorageService,
    private readonly quarantine: FileQuarantineService,
    private readonly scanner: AvScanner,
    private readonly audit: AuditService,
  ) {}

  async receive(
    orgSlug: string,
    rawPlatform: string,
    rawBody: Buffer | string,
    signature: string | undefined,
  ): Promise<ApplyResult & { platform: string; replay: boolean }> {
    const platform = rawPlatform.toUpperCase();
    if (!isSupportedBoard(platform)) throw new NotFoundException("Unknown board.");

    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.slug, orgSlug),
      columns: { id: true },
    });
    if (!org) throw new NotFoundException("Organization not found.");

    /**
     * Everything from here to the résumé fetch runs inside a tenant
     * transaction, because `candidate_sources`, `candidates`,
     * `job_board_postings` and `job_postings` are all behind RLS and this is a
     * `@Public()` route — there is no ambient tenant on an unauthenticated
     * request, so a read without the GUC dies `42501`. The organisation comes
     * from the slug in the path, which is the only thing a board knows.
     *
     * The board credentials in particular are NOT in the public-token RLS arm,
     * and must not be: a secret that verifies inbound applications would be
     * readable by anyone who can reach a public route.
     */
    const decision = await runInTenantTransaction(
      this.db,
      async () => {
        /**
         * The secret is per organisation and per board, and it is NOT the
         * outbound oauth token: a board that can post jobs for us should not
         * thereby be able to forge applications, and rotating one must not
         * break the other.
         */
        const credentials = await this.credentials.forPlatform(org.id, platform);
        const secret = credentials?.meta?.inboundSecret;
        if (typeof secret !== "string" || secret.length === 0) {
          /**
           * 404, not 401. Answering "you signed it wrong" to a caller for an
           * organisation that never enabled this board tells them the
           * organisation exists and which boards it uses — §4's
           * existence-oracle rule.
           */
          throw new NotFoundException("Unknown board.");
        }
        if (!verifyBoardSignature(rawBody, secret, signature))
          throw new UnauthorizedException("Signature did not verify.");

        let payload;
        try {
          payload = normaliseBoardApply(
            JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")),
          );
        } catch (error) {
          /**
           * A poison payload is a 400 for this one delivery and nothing more —
           * it must not throw past here, because the board will retry it
           * forever and every retry would be an error log for a body that will
           * never parse.
           */
          logger.warn("[board-apply] payload could not be read", {
            orgId: org.id,
            platform,
            error: error instanceof Error ? error.message : String(error),
          });
          throw new BadRequestException("Payload could not be read.");
        }

        const externalId = `${platform}:${payload.applicationId}`;
        const [existing] = await this.db
          .select({ id: candidates.id })
          .from(candidates)
          .where(and(eq(candidates.orgId, org.id), eq(candidates.externalId, externalId)))
          .limit(1);

        const job = await this.resolveJob(org.id, platform, payload.jobReference);
        if (!job) throw new NotFoundException("No open job matches that reference.");

        return { payload, externalId, job, replay: Boolean(existing) };
      },
      { orgId: org.id },
    );

    if (decision.replay) {
      /**
       * The board is retrying. Nothing is written and no event is emitted; the
       * first delivery already did both.
       */
      return {
        platform,
        replay: true,
        trackingToken: "",
        duplicate: true,
        resumeStored: false,
        resumeReason: "replayed-delivery",
      };
    }

    const { payload, externalId, job } = decision;

    const resume = await this.fetchResume(org.id, payload.candidate.resumeUrl);

    const result = await runInTenantTransaction(
      this.db,
      async (tx) => {
        if (resume.stored) await recordResumeQuarantine(this.quarantine, org.id, resume);
        return recordApplication({
          tx,
          planLimits: this.planLimits,
          orgId: org.id,
          job,
          input: {
            name: payload.candidate.name,
            email: payload.candidate.email,
            phone: payload.candidate.phone,
            linkedinUrl: payload.candidate.profileUrl,
            coverLetter: payload.candidate.coverLetter,
            consent: true,
          },
          answers: payload.answers ?? {},
          resume,
          origin: {
            source: platform,
            consented: payload.consent === true,
            externalId,
          },
        });
      },
      { orgId: org.id },
    );

    this.audit.log({
      action: "BOARD_APPLICATION_RECEIVED",
      userId: (await orgOwnerUserId(this.db, org.id)) ?? org.id,
      orgId: org.id,
      targetId: payload.applicationId,
      targetType: "candidate_application",
      metadata: {
        platform,
        jobPostingId: job.id,
        consentGiven: payload.consent === true,
        resumeStored: result.resumeStored,
      },
    });

    return { ...result, platform, replay: false };
  }

  /**
   * Which job the board is talking about.
   *
   * A board knows the job by the reference we gave it when the advertisement
   * was posted, so the publication row is the authority; falling back to our
   * own id covers a board that echoes `referenceId` verbatim. Either way the
   * job must be OPEN and in this organisation, so a closed role stops taking
   * applications everywhere at once.
   */
  private async resolveJob(orgId: string, platform: string, reference: string | number) {
    const asNumber = Number(reference);

    const [publication] = await this.db
      .select({ jobPostingId: jobBoardPostings.jobPostingId })
      .from(jobBoardPostings)
      .where(
        and(
          eq(jobBoardPostings.orgId, orgId),
          eq(jobBoardPostings.platform, platform),
          eq(jobBoardPostings.externalPostingId, String(reference)),
        ),
      )
      .limit(1);

    const jobId = publication?.jobPostingId ?? (Number.isInteger(asNumber) ? asNumber : null);
    if (jobId === null) return null;

    const job = await this.db.query.jobPostings.findFirst({
      where: and(
        eq(jobPostings.id, jobId),
        eq(jobPostings.orgId, orgId),
        eq(jobPostings.status, "OPEN"),
      ),
      columns: { id: true, title: true, screeningQuestions: true, postedBy: true },
    });
    return job ?? null;
  }

  /**
   * Fetch the résumé the board linked, and put it through the same scanner and
   * quarantine as one a candidate uploaded.
   *
   * The URL comes from an attacker-controlled payload, so it goes through
   * `outboundRequest` and its SSRF guard — a board apply is otherwise a way to
   * make the server fetch the cloud metadata endpoint. The size is capped from
   * the declared length AND from the bytes actually read, because a lying
   * `content-length` is free.
   */
  private async fetchResume(orgId: string, url: string | undefined): Promise<ResumeIntake> {
    if (!url) return { stored: false, reason: "no-file" };
    try {
      const response = await outboundRequest(url, {
        provider: "job-board:resume",
        timeoutMs: RESUME_FETCH_TIMEOUT_MS,
        method: "GET",
      });
      if (!response.ok) return { stored: false, reason: "upload-failed" };

      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > RESUME_MAX_BYTES) return { stored: false, reason: "too-large" };

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > RESUME_MAX_BYTES) return { stored: false, reason: "too-large" };

      const filename = url.split("/").pop()?.split("?")[0] ?? "resume.pdf";
      return prepareResume(this.storage, this.scanner, orgId, {
        buffer,
        originalname: filename,
        mimetype: response.headers.get("content-type")?.split(";")[0] ?? "application/pdf",
        size: buffer.byteLength,
      });
    } catch (error) {
      logger.warn("[board-apply] résumé could not be fetched; the application is unaffected", {
        orgId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { stored: false, reason: "upload-failed" };
    }
  }
}
