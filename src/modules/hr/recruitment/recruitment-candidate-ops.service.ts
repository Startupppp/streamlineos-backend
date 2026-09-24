import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  candidateApplications,
  candidateSlaTracking,
  candidates,
  jobPostings,
  organizations,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { EmailService } from "../../email/email.service";
import { AutomationService } from "../../automation/automation.service";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { getCandidateRejectionEmail } from "../../email/templates/recruitment";
import type {
  BgvStatusInput,
  BulkImportInput,
  BulkRejectInput,
  BulkShortlistInput,
  CreateApplicationInput,
  ImportInput,
  SlaResetInput,
} from "./dto/candidates.schemas";

@Injectable()
export class RecruitmentCandidateOpsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly email: EmailService,
    private readonly automation: AutomationService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  async bulkImport(orgId: string, input: BulkImportInput) {
    // Bounded by the REQUEST, not the organisation: this used to select every
    // candidate row the org holds, unlimited, to answer <=500 questions.
    // `candidates` has no unique on (org_id, email), so the onConflictDoNothing()
    // below can never fire and this probe IS the dedupe. lower() on both sides
    // because email is stored verbatim at some insert sites; selectDistinct with
    // limit(requested.length) is exact rather than truncating.
    const requestedEmails = [
      ...new Set(input.rows.map((row) => row.email.toLowerCase().trim())),
    ];
    const existingCandidates = await this.db
      .selectDistinct({ email: sql<string>`lower(${candidates.email})` })
      .from(candidates)
      .where(
        and(
          eq(candidates.orgId, orgId),
          inArray(sql`lower(${candidates.email})`, requestedEmails),
        ),
      )
      .limit(requestedEmails.length);
    const existingEmails = new Set(existingCandidates.map((c) => c.email));

    const results = { created: 0, skipped: 0, errors: [] as string[] };
    const toInsert: Array<typeof candidates.$inferInsert> = [];

    for (const row of input.rows) {
      const emailLower = row.email.toLowerCase();
      if (existingEmails.has(emailLower)) {
        results.skipped++;
        continue;
      }
      existingEmails.add(emailLower);
      toInsert.push({
        orgId,
        firstName: row.firstName,
        lastName: row.lastName,
        email: emailLower,
        phone: row.phone ?? null,
        currentCompany: row.currentCompany ?? null,
        currentRole: row.currentRole ?? null,
        resumeUrl: row.resumeUrl ?? null,
        linkedinUrl: row.linkedinUrl ?? null,
        location: row.location ?? null,
        skills: row.skills ? row.skills.split(",").map((s) => s.trim()).filter(Boolean) : [],
        source: row.source ?? "IMPORT",
        status: "NEW",
      });
    }

    if (toInsert.length > 0) {
      await this.planLimits.assertWithinLimit(orgId, "hrCandidates", toInsert.length);
      const chunkSize = 50;
      for (let i = 0; i < toInsert.length; i += chunkSize) {
        const chunk = toInsert.slice(i, i + chunkSize);
        await this.db.insert(candidates).values(chunk).onConflictDoNothing();
        results.created += chunk.length;
      }
      await this.cache.invalidateNamespace(`hr:candidates:list:${orgId}`);
    }

    return results;
  }

  async importCandidates(orgId: string, input: ImportInput) {
    const values = input.candidates.map((c) => ({
      orgId,
      firstName: c.firstName.trim(),
      lastName: c.lastName.trim(),
      email: c.email.toLowerCase().trim(),
      phone: c.phone,
      currentCompany: c.currentCompany,
      currentRole: c.currentRole,
      source: c.source ?? "IMPORT",
      skills: c.skills ? c.skills.split(",").map((s) => s.trim()) : undefined,
      status: "NEW" as const,
    }));

    await this.planLimits.assertWithinLimit(orgId, "hrCandidates", values.length);
    const inserted = await this.db.insert(candidates).values(values).returning({ id: candidates.id });
    await this.cache.invalidateNamespace(`hr:candidates:list:${orgId}`);
    return { imported: inserted.length };
  }

  async bulkReject(orgId: string, userId: string, input: BulkRejectInput) {
    const requestedIds = [...new Set(input.candidateIds)];
    const existing = await this.db
      .select({
        id: candidates.id,
        firstName: candidates.firstName,
        lastName: candidates.lastName,
        email: candidates.email,
        status: candidates.status,
      })
      .from(candidates)
      .where(and(inArray(candidates.id, requestedIds), eq(candidates.orgId, orgId)))
      .limit(requestedIds.length);

    if (existing.length !== requestedIds.length) {
      throw new NotFoundException("One or more candidate IDs not found in this organization");
    }

    const toReject = existing.filter((c) => c.status !== "REJECTED");
    const alreadyRejected = existing.length - toReject.length;

    if (toReject.length === 0) {
      return { rejected: 0, alreadyRejected, emailsSent: 0 };
    }

    const toRejectIds = toReject.map((c) => c.id);
    await this.db
      .update(candidates)
      .set({ status: "REJECTED", updatedAt: new Date() })
      .where(and(inArray(candidates.id, toRejectIds), eq(candidates.orgId, orgId)));

    for (const c of toReject) {
      this.audit.log({
        action: "CANDIDATE_STAGE_CHANGED",
        userId,
        orgId,
        targetId: String(c.id),
        targetType: "candidate",
        metadata: { from: c.status, to: "REJECTED", candidateName: `${c.firstName} ${c.lastName}`, bulk: true },
      });
    }

    let emailsSent = 0;
    if (input.sendRejectionEmail) {
      const [org, actor] = await Promise.all([
        this.db.query.organizations.findFirst({
          where: eq(organizations.id, orgId),
          columns: { name: true },
        }),
        this.db.query.users.findFirst({
          where: eq(users.id, userId),
          columns: { name: true },
        }),
      ]);
      const companyName = org?.name ?? "our company";
      const senderName = actor?.name ?? undefined;

      const recipients = toReject.filter((c) => Boolean(c.email));
      const results = await Promise.allSettled(
        recipients.map((c) => {
          const { subject, html } = getCandidateRejectionEmail({
            candidateName: `${c.firstName} ${c.lastName}`,
            jobTitle: "the position",
            companyName,
            senderName,
          });
          return this.email.sendEmail({ to: c.email, subject, html });
        }),
      );
      emailsSent = results.filter((r) => r.status === "fulfilled").length;
    }

    await this.cache.invalidateNamespace(`hr:candidates:list:${orgId}`);
    return { rejected: toReject.length, alreadyRejected, emailsSent };
  }

  async bulkShortlist(orgId: string, userId: string, input: BulkShortlistInput) {
    const requestedIds = [...new Set(input.candidateIds)];
    const existing = await this.db
      .select({ id: candidates.id, firstName: candidates.firstName, lastName: candidates.lastName, status: candidates.status })
      .from(candidates)
      .where(and(inArray(candidates.id, requestedIds), eq(candidates.orgId, orgId)))
      .limit(requestedIds.length);

    if (existing.length !== requestedIds.length) {
      throw new NotFoundException("One or more candidate IDs not found in this organization");
    }

    const toShortlist = existing.filter((c) => c.status === "NEW");
    const skipped = existing.length - toShortlist.length;

    if (toShortlist.length === 0) {
      return { shortlisted: 0, skipped };
    }

    const ids = toShortlist.map((c) => c.id);
    await this.db
      .update(candidates)
      .set({ status: "SCREENING", updatedAt: new Date() })
      .where(and(inArray(candidates.id, ids), eq(candidates.orgId, orgId)));

    for (const c of toShortlist) {
      this.audit.log({
        action: "CANDIDATE_STAGE_CHANGED",
        userId,
        orgId,
        targetId: String(c.id),
        targetType: "candidate",
        metadata: { from: "NEW", to: "SCREENING", candidateName: `${c.firstName} ${c.lastName}`, bulk: true },
      });
    }

    await this.cache.invalidateNamespace(`hr:candidates:list:${orgId}`);
    return { shortlisted: toShortlist.length, skipped };
  }

  async getSla(orgId: string, candidateId: number) {
    await this.ensureCandidate(orgId, candidateId);
    return this.db.query.candidateSlaTracking.findMany({
      limit: 100,
      where: and(eq(candidateSlaTracking.candidateId, candidateId), eq(candidateSlaTracking.orgId, orgId)),
      orderBy: (t, { asc }) => [asc(t.stage)],
    });
  }

  async resetSla(orgId: string, candidateId: number, input: SlaResetInput) {
    await this.ensureCandidate(orgId, candidateId);
    const [record] = await this.db
      .insert(candidateSlaTracking)
      .values({
        orgId,
        candidateId,
        stage: input.stage,
        enteredAt: new Date(),
        breachedAt: null,
        status: input.status,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [candidateSlaTracking.candidateId, candidateSlaTracking.stage],
        set: { enteredAt: new Date(), breachedAt: null, status: input.status, updatedAt: new Date() },
      })
      .returning();
    return record;
  }

  async createApplication(orgId: string, candidateId: number, input: CreateApplicationInput) {
    const candidate = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
      columns: { id: true, firstName: true, lastName: true, email: true, source: true },
    });
    if (!candidate) throw new NotFoundException("Candidate not found.");
    if (!input.jobPostingId) throw new BadRequestException("jobPostingId is required.");

    const existingApplication = await this.db.query.candidateApplications.findFirst({
      where: and(
        eq(candidateApplications.candidateId, candidateId),
        eq(candidateApplications.jobPostingId, input.jobPostingId),
        eq(candidateApplications.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (existingApplication) {
      throw new ConflictException("This candidate has already applied for this position.");
    }

    const [application] = await this.db
      .insert(candidateApplications)
      .values({
        orgId,
        candidateId,
        jobPostingId: input.jobPostingId,
        coverLetter: input.coverLetter,
        status: "APPLIED",
      })
      .returning();

    void this.dispatchApplicationAutomation(orgId, candidateId, candidate, input.jobPostingId, application.appliedAt).catch(
      () => undefined,
    );

    return application;
  }

  private async dispatchApplicationAutomation(
    orgId: string,
    candidateId: number,
    candidate: { firstName: string; lastName: string; email: string; source: string },
    jobPostingId: number,
    appliedAt: Date | null,
  ): Promise<void> {
    const job = await this.db.query.jobPostings.findFirst({
      where: eq(jobPostings.id, jobPostingId),
      columns: { title: true },
    });

    await this.automation.runAutomationsForEvent(orgId, "candidate.application_created", {
      candidateId,
      candidateName: `${candidate.firstName} ${candidate.lastName}`,
      candidateEmail: candidate.email ?? "",
      jobPostingId,
      jobTitle: job?.title ?? "",
      source: candidate.source ?? "DIRECT",
      appliedAt: (appliedAt ?? new Date()).toISOString(),
    });
  }

  async updateBgvStatus(orgId: string, candidateId: number, input: BgvStatusInput) {
    const candidate = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
    });
    if (!candidate) throw new NotFoundException("Candidate not found");

    const now = new Date();
    /*
      Stamped MANUAL, always.

      This route predates the agency integration and cannot produce an agency
      verdict — a recruiter recording a clearance they obtained themselves is
      legitimate and is the manual fallback the whole feature leans on, but the
      row has to say so. Leaving `bgv_source` null here would let a
      recruiter-typed CLEARED and an agency-returned CLEARED stay
      indistinguishable, which is the distinction `isAgencyClearance` exists to
      make.
    */
    const updateFields: Partial<typeof candidates.$inferInsert> = {
      bgvStatus: input.bgvStatus,
      bgvSource: "MANUAL",
      updatedAt: now,
    };
    if (input.bgvAgency !== undefined) updateFields.bgvAgency = input.bgvAgency;
    if (input.bgvNotes !== undefined) updateFields.bgvNotes = input.bgvNotes;
    if (input.bgvStatus === "INITIATED" && candidate.bgvStatus === "NOT_INITIATED") {
      updateFields.bgvInitiatedAt = now;
    }
    if (input.bgvStatus === "CLEARED" || input.bgvStatus === "FAILED") {
      updateFields.bgvCompletedAt = now;
    }
    if (input.bgvStatus === "NOT_INITIATED") {
      // Re-opening drops the agency's case reference; a later verdict carrying
      // the old one would attach to a check nobody re-ran.
      updateFields.bgvReference = null;
    }

    await this.db.update(candidates).set(updateFields).where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)));

    void this.automation
      .runAutomationsForEvent(orgId, "candidate.bgv_status_changed", {
        candidateId,
        candidateName: `${candidate.firstName} ${candidate.lastName}`,
        candidateEmail: candidate.email ?? "",
        previousBgvStatus: candidate.bgvStatus ?? "NOT_INITIATED",
        newBgvStatus: input.bgvStatus,
        bgvAgency: input.bgvAgency ?? null,
      })
      .catch(() => undefined);

    return this.db.query.candidates.findFirst({ where: eq(candidates.id, candidateId) });
  }

  private async ensureCandidate(orgId: string, candidateId: number) {
    const candidate = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
      columns: { id: true },
    });
    if (!candidate) throw new NotFoundException("Candidate not found.");
  }
}
