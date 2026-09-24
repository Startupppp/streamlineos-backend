import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gt, isNotNull } from "drizzle-orm";
import {
  candidateApplications,
  candidateOffers,
  candidateResumes,
  interviewBookingLinks,
  jobPostings,
  organizations,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { withPublicToken } from "../../common/tenant/with-public-token";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { registerAfterCommit } from "../../common/tenant/tenant-context";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { StorageService } from "../storage/storage.service";
import { FileQuarantineService } from "../storage/file-quarantine.service";
import { AvScanner } from "../../common/security/av-scan";
import { logger } from "../../common/logger/logger.service";
import { extractDocumentText, isExtractableMime } from "../../common/documents/extract-document-text.util";
import {
  assertNoLeak,
  PORTAL_STATUS_COPY,
  toPortalStatus,
} from "./portal/candidate-portal-view";
import {
  RESUME_REJECTION_MESSAGE,
  prepareResume,
  recordResumeQuarantine,
  refuseResume,
  type ResumeIntake,
  type ResumeUpload,
} from "./careers-resume-intake";
import { recordApplication, screenOrRefuse, type ApplyResult } from "./public-careers-apply";
import type { ApplyInput } from "./dto/public.schemas";

@Injectable()
export class PublicCareersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly planLimits: PlanLimitsService,
    private readonly storage: StorageService,
    private readonly quarantine: FileQuarantineService,
    private readonly scanner: AvScanner,
  ) {}

  /**
   * What a candidate is told about their own application.
   *
   * Coarse by design. Internally the application moves through seven states;
   * this returns six, and SHORTLISTED in particular collapses into `in_review`
   * because it is the most tempting one to expose and the most damaging — its
   * absence would then be information too.
   *
   * The response is checked against an allow-list before it leaves. That guard
   * exists for a specific failure: a `with: { candidate: true }` added later to
   * fix a missing name pulls in notes, ratings, AI scores and BGV notes, on an
   * endpoint that is public and unauthenticated.
   */
  async getApplicationStatus(token: string) {
    const application = await withPublicToken(this.db, token, (tx) =>
      tx.query.candidateApplications.findFirst({
        where: eq(candidateApplications.trackingToken, token),
        columns: { orgId: true },
      }),
    );

    if (!application) throw new NotFoundException("Application not found");

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const full = await tx.query.candidateApplications.findFirst({
          where: eq(candidateApplications.trackingToken, token),
          columns: { status: true, appliedAt: true, updatedAt: true, candidateId: true },
          with: {
            /*
              Explicit column lists on both relations, not `true`. The candidate
              row carries notes, rating, aiScore, bgvNotes and an email address;
              the only field this page needs from it is a first name to greet
              somebody by.
            */
            candidate: { columns: { firstName: true } },
            jobPosting: { columns: { title: true, location: true, type: true } },
          },
        });
        if (!full) throw new NotFoundException("Application not found");

        const org = await tx.query.organizations.findFirst({
          where: eq(organizations.id, application.orgId),
          columns: { name: true },
        });

        const now = new Date();
        const booking = await tx.query.interviewBookingLinks.findFirst({
          where: and(
            eq(interviewBookingLinks.orgId, application.orgId),
            eq(interviewBookingLinks.candidateId, full.candidateId),
            eq(interviewBookingLinks.status, "pending"),
            gt(interviewBookingLinks.expiresAt, now),
          ),
          columns: { token: true },
          orderBy: (t, { desc: d }) => [d(t.createdAt)],
        });

        const offer = await tx.query.candidateOffers.findFirst({
          where: and(
            eq(candidateOffers.orgId, application.orgId),
            eq(candidateOffers.candidateId, full.candidateId),
            eq(candidateOffers.offerStatus, "SENT"),
            isNotNull(candidateOffers.acceptanceToken),
            gt(candidateOffers.acceptanceTokenExpiresAt, now),
          ),
          columns: { acceptanceToken: true },
          orderBy: (t, { desc: d }) => [d(t.id)],
        });

        const status = toPortalStatus(full.status);
        const response = {
          status,
          statusText: PORTAL_STATUS_COPY[status],
          appliedAt: full.appliedAt,
          updatedAt: full.updatedAt,
          jobTitle: full.jobPosting?.title ?? "",
          jobLocation: full.jobPosting?.location ?? null,
          jobType: full.jobPosting?.type ?? null,
          organisationName: org?.name ?? "",
          candidateFirstName: full.candidate?.firstName ?? "",
          /*
            Paths, not absolute URLs. The candidate is already on the careers
            host when they read this, and building an absolute link here would
            bake a deployment's hostname into a response the frontend can route
            better itself.
          */
          bookingUrl: booking ? `/interview-booking/${booking.token}` : null,
          offerUrl: offer?.acceptanceToken ? `/offer/${offer.acceptanceToken}` : null,
        };

        assertNoLeak(response);
        return response;
      },
      { orgId: application.orgId },
    );
  }

  async listOrgJobs(orgSlug: string) {
    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.slug, orgSlug),
      columns: { id: true, name: true, logo: true, industry: true },
    });
    if (!org) throw new NotFoundException("Organization not found");

    const jobs = await this.db
      .select({
        id: jobPostings.id,
        title: jobPostings.title,
        location: jobPostings.location,
        type: jobPostings.type,
        experience: jobPostings.experience,
        salaryMin: jobPostings.salaryMin,
        salaryMax: jobPostings.salaryMax,
        openings: jobPostings.openings,
        applicationDeadline: jobPostings.applicationDeadline,
        createdAt: jobPostings.createdAt,
      })
      .from(jobPostings)
      .where(and(eq(jobPostings.orgId, org.id), eq(jobPostings.status, "OPEN")))
      .orderBy(desc(jobPostings.createdAt));

    return { org, jobs };
  }

  async getOrgJob(orgSlug: string, jobId: number) {
    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.slug, orgSlug),
      columns: { id: true, name: true, logo: true },
    });
    if (!org) throw new NotFoundException("Organization not found");

    const job = await this.db.query.jobPostings.findFirst({
      where: and(
        eq(jobPostings.id, jobId),
        eq(jobPostings.orgId, org.id),
        eq(jobPostings.status, "OPEN"),
      ),
      columns: {
        id: true,
        title: true,
        location: true,
        type: true,
        experience: true,
        salaryMin: true,
        salaryMax: true,
        openings: true,
        applicationDeadline: true,
        createdAt: true,
        description: true,
        requirements: true,
        benefits: true,
        closingDate: true,
        screeningQuestions: true,
      },
    });
    if (!job) throw new NotFoundException("Job not found");

    /**
     * `knockoutAnswer` never leaves the building. It is the answer that passes,
     * and publishing it on the form the candidate fills in would make the
     * knockout decorative.
     */
    const screeningQuestions =
      job.screeningQuestions?.map(({ id, question, type, required, options }) => ({
        id,
        question,
        type,
        required,
        ...(options ? { options } : {}),
      })) ?? null;

    return { org, job: { ...job, screeningQuestions } };
  }

  /**
   * The one public apply door.
   *
   * Org-scoped, `OPEN` jobs only, consent required, screening answers screened
   * before anything is written, one application per email per job, résumé bytes
   * into the vault, and `candidate.applied` committed with the rows it
   * describes. The legacy `POST /careers/apply` — which had consent and the
   * event but no org scope — and this endpoint — which had the org scope and
   * neither — were two half-doors; this is the whole one.
   */
  async applyToOrgJob(
    orgSlug: string,
    jobId: number,
    input: ApplyInput,
    file?: ResumeUpload,
  ): Promise<ApplyResult> {
    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.slug, orgSlug),
      columns: { id: true, name: true },
    });
    if (!org) throw new NotFoundException("Organization not found");

    const job = await this.db.query.jobPostings.findFirst({
      where: and(
        eq(jobPostings.id, jobId),
        eq(jobPostings.orgId, org.id),
        eq(jobPostings.status, "OPEN"),
      ),
      columns: { id: true, title: true, screeningQuestions: true, postedBy: true },
    });
    if (!job) throw new NotFoundException("Job not found or no longer accepting applications.");

    const answers = screenOrRefuse(job, input);

    /**
     * A file that fails validation is a client error and refuses the whole
     * application, because the candidate meant to attach it. A file that
     * validates but cannot be STORED does not — `prepareResume` reports that and
     * the application still lands, since losing the application over an object
     * store outage would be the worse failure.
     */
    let resume: ResumeIntake = { stored: false, reason: "no-file" };
    if (file) {
      const rejection = refuseResume(file);
      if (rejection) throw new BadRequestException(RESUME_REJECTION_MESSAGE[rejection]);
      resume = await prepareResume(this.storage, this.scanner, org.id, file);
      if (!resume.stored && resume.reason === "infected")
        throw new BadRequestException(RESUME_REJECTION_MESSAGE.infected);
    }

    const result = await runInTenantTransaction(
      this.db,
      async (tx) => {
        /**
         * Inside the transaction, because `file_quarantine_records` is behind
         * RLS: the tenant GUC only exists here.
         */
        if (resume.stored) await recordResumeQuarantine(this.quarantine, org.id, resume);
        return recordApplication({
          tx,
          planLimits: this.planLimits,
          orgId: org.id,
          job,
          input,
          answers,
          resume,
        });
      },
      { orgId: org.id },
    );

    if (file && result.duplicate === false) this.deferResumeText(org.id, result, file);
    return result;
  }

  /**
   * Résumé text extraction, after the application has committed.
   *
   * Deferred because parsing is the one part of an application that may fail
   * without the candidate having done anything wrong, and the instruction is
   * explicit that a parser failure must not cost them the application. It runs
   * in its own tenant transaction (backend CLAUDE.md §4): the request's
   * transaction has committed by then and its GUC is gone.
   *
   * No AI gateway call happens here. `candidate_resumes.resume_text` is the raw
   * extracted text; the recruiter's "AI parse" button still spends a credit on
   * the structured extraction. An unauthenticated route that charged the tenant
   * per submission would be a denial-of-wallet.
   */
  private deferResumeText(orgId: string, result: ApplyResult, file: ResumeUpload): void {
    if (!isExtractableMime(file.mimetype)) return;
    const work = async (): Promise<void> => {
      try {
        const text = (await extractDocumentText(file.buffer, file.mimetype)).trim();
        if (!text) return;
        await runInNewTenantTransaction(this.db, orgId, async (tx) => {
            const application = await tx.query.candidateApplications.findFirst({
              where: eq(candidateApplications.trackingToken, result.trackingToken),
              columns: { candidateId: true },
            });
            if (!application) return;
            await tx
              .insert(candidateResumes)
              .values({ orgId, candidateId: application.candidateId, resumeText: text.slice(0, 100_000) })
              .onConflictDoUpdate({
                target: candidateResumes.candidateId,
                set: { resumeText: text.slice(0, 100_000), updatedAt: new Date() },
              });
        });
      } catch (error) {
        logger.warn("[public-careers] résumé text extraction failed; application is unaffected", {
          orgId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    if (!registerAfterCommit(work)) void work();
  }
}
