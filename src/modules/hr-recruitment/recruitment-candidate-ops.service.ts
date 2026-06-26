import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { candidateApplications, candidateSlaTracking, candidates } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import type {
  BgvStatusInput,
  BulkImportInput,
  BulkRejectInput,
  CreateApplicationInput,
  ImportInput,
  SlaResetInput,
} from "./dto/candidates.schemas";

@Injectable()
export class RecruitmentCandidateOpsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async bulkImport(orgId: string, input: BulkImportInput) {
    const existingCandidates = await this.db.query.candidates.findMany({
      where: eq(candidates.orgId, orgId),
      columns: { email: true },
    });
    const existingEmails = new Set(existingCandidates.map((c) => c.email.toLowerCase()));

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
      const chunkSize = 50;
      for (let i = 0; i < toInsert.length; i += chunkSize) {
        const chunk = toInsert.slice(i, i + chunkSize);
        await this.db.insert(candidates).values(chunk).onConflictDoNothing();
        results.created += chunk.length;
      }
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

    const inserted = await this.db.insert(candidates).values(values).returning({ id: candidates.id });
    return { imported: inserted.length };
  }

  async bulkReject(orgId: string, userId: string, input: BulkRejectInput) {
    const existing = await this.db
      .select({
        id: candidates.id,
        firstName: candidates.firstName,
        lastName: candidates.lastName,
        email: candidates.email,
        status: candidates.status,
      })
      .from(candidates)
      .where(and(inArray(candidates.id, input.candidateIds), eq(candidates.orgId, orgId)));

    if (existing.length === 0) {
      throw new NotFoundException("No matching candidates found");
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
      .where(inArray(candidates.id, toRejectIds));

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

    return { rejected: toReject.length, alreadyRejected, emailsSent: 0 };
  }

  async getSla(orgId: string, candidateId: number) {
    await this.ensureCandidate(orgId, candidateId);
    return this.db.query.candidateSlaTracking.findMany({
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
    await this.ensureCandidate(orgId, candidateId);
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

    return application;
  }

  async updateBgvStatus(orgId: string, candidateId: number, input: BgvStatusInput) {
    const candidate = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
    });
    if (!candidate) throw new NotFoundException("Candidate not found");

    const now = new Date();
    const updateFields: Partial<typeof candidates.$inferInsert> = { bgvStatus: input.bgvStatus, updatedAt: now };
    if (input.bgvAgency !== undefined) updateFields.bgvAgency = input.bgvAgency;
    if (input.bgvNotes !== undefined) updateFields.bgvNotes = input.bgvNotes;
    if (input.bgvStatus === "INITIATED" && candidate.bgvStatus === "NOT_INITIATED") {
      updateFields.bgvInitiatedAt = now;
    }
    if (input.bgvStatus === "CLEARED" || input.bgvStatus === "FAILED") {
      updateFields.bgvCompletedAt = now;
    }

    await this.db.update(candidates).set(updateFields).where(eq(candidates.id, candidateId));

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
