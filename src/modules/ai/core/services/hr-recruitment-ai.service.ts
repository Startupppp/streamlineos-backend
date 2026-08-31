import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import {
  candidates,
  hiringFlowRounds,
  interviews,
  jobPostings,
  users,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import {
  candidateScoringPrompt,
  interviewKitPrompt,
  interviewNotesSummaryPrompt,
} from "../prompts/hr.prompts";
import {
  CandidateScoreSchema,
  InterviewKitSchema,
  InterviewNotesSummarySchema,
  type CandidateScoreResult,
  type InterviewKitResult,
  type InterviewNotesSummaryResult,
} from "../dto/output.schemas";
import type { GenerateJdInput } from "../dto/request.schemas";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { unwrapAiResult } from "./gateway-result.util";
import { redactSensitiveData } from "../redaction.util";

@Injectable()
export class HrRecruitmentAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
  ) {}

  async scoreCandidate(
    orgId: string,
    candidateId: number,
    jobId?: number,
  ): Promise<CandidateScoreResult | null> {
    const ctx = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [candidate] = await tx
          .select()
          .from(candidates)
          .where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)));
        if (!candidate) return null;

        let job: {
          title: string;
          description: string | null;
          requirements: string | null;
        } | null = null;
        if (jobId) {
          const [jobRecord] = await tx
            .select({
              title: jobPostings.title,
              description: jobPostings.description,
              requirements: jobPostings.requirements,
            })
            .from(jobPostings)
            .where(and(eq(jobPostings.id, jobId), eq(jobPostings.orgId, orgId)));
          if (jobRecord) job = jobRecord;
        }

        return { candidate, job };
      },
      { orgId },
    );
    if (!ctx) return null;

    const { candidate, job } = ctx;

    const prompt = candidateScoringPrompt({
      firstName: candidate.firstName,
      lastName: candidate.lastName,
      email: candidate.email,
      currentCompany: candidate.currentCompany,
      currentRole: candidate.currentRole,
      experienceYears: candidate.experienceYears,
      skills: candidate.skills,
      source: candidate.source,
      notes: candidate.notes,
      jobTitle: job?.title,
      jobDescription: job?.description,
      jobRequiredSkills: job?.requirements ? [job.requirements] : null,
    });

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId: null },
      feature: "hr.score-candidate",
      prompt: {
        system: prompt.system,
        user: prompt.user,
        promptKey: "hr.candidate_scoring",
        promptVersion: 1,
      },
      schema: CandidateScoreSchema,
      tier: "fast",
      maxTokens: 512,
      charge: true,
    });

    const data = unwrapAiResult(result);
    data.score = Math.max(0, Math.min(100, Math.round(data.score)));

    return data;
  }

  async acceptCandidateScore(
    orgId: string,
    candidateId: number,
    aiScore: number,
  ): Promise<{ accepted: boolean }> {
    const ratingFiveScale = Math.round((aiScore / 100) * 5);
    await runInTenantTransaction(
      this.db,
      async (tx) => {
        await tx
          .update(candidates)
          .set({
            rating: ratingFiveScale,
            aiScore,
            aiScoreGeneratedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)));
      },
      { orgId },
    );
    return { accepted: true };
  }

  async generateInterviewKit(
    orgId: string,
    jobPostingId: number,
  ): Promise<InterviewKitResult | null> {
    const ctx = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [job] = await tx
          .select({
            title: jobPostings.title,
            description: jobPostings.description,
            requirements: jobPostings.requirements,
            hiringFlowId: jobPostings.hiringFlowId,
          })
          .from(jobPostings)
          .where(
            and(eq(jobPostings.id, jobPostingId), eq(jobPostings.orgId, orgId)),
          );
        if (!job) return null;

        let roundTypes: string[] | null = null;
        if (job.hiringFlowId) {
          const roundRows = await tx
            .select({ roundType: hiringFlowRounds.roundType })
            .from(hiringFlowRounds)
            .where(eq(hiringFlowRounds.flowId, job.hiringFlowId))
            .orderBy(hiringFlowRounds.orderIndex);
          if (roundRows.length > 0) roundTypes = roundRows.map((r) => r.roundType);
        }

        return { job, roundTypes };
      },
      { orgId },
    );
    if (!ctx) return null;

    const { job, roundTypes } = ctx;

    const prompt = interviewKitPrompt({
      jobTitle: job.title,
      jobDescription: job.description,
      requirements: job.requirements,
      roundTypes,
    });

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId: null },
      feature: "hr.interview-kit",
      prompt: {
        system: prompt.system,
        user: prompt.user,
        promptKey: "hr.interview_kit",
        promptVersion: 1,
      },
      schema: InterviewKitSchema,
      tier: "fast",
      maxTokens: 2048,
      charge: true,
    });

    return unwrapAiResult(result);
  }

  async summarizeInterviewNotes(
    orgId: string,
    candidateId: number,
    jobPostingId?: number,
  ): Promise<InterviewNotesSummaryResult | null> {
    const ctx = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [candidate] = await tx
          .select({
            firstName: candidates.firstName,
            lastName: candidates.lastName,
          })
          .from(candidates)
          .where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)));
        if (!candidate) return null;

        const conditions = [
          eq(interviews.orgId, orgId),
          eq(interviews.candidateId, candidateId),
        ];
        if (jobPostingId)
          conditions.push(eq(interviews.jobPostingId, jobPostingId));

        const interviewRows = await tx
          .select({
            type: interviews.type,
            feedback: interviews.feedback,
            notes: interviews.notes,
            rating: interviews.rating,
            result: interviews.result,
          })
          .from(interviews)
          .where(and(...conditions))
          .orderBy(desc(interviews.scheduledAt))
          .limit(10);

        let jobTitle: string | null = null;
        if (interviewRows.length > 0 && jobPostingId) {
          const [job] = await tx
            .select({ title: jobPostings.title })
            .from(jobPostings)
            .where(
              and(eq(jobPostings.id, jobPostingId), eq(jobPostings.orgId, orgId)),
            );
          if (job) jobTitle = job.title;
        }

        return { candidate, interviewRows, jobTitle };
      },
      { orgId },
    );
    if (!ctx || ctx.interviewRows.length === 0) return null;

    const { candidate, interviewRows, jobTitle } = ctx;

    const rounds = interviewRows.map((r) => ({
      roundType: r.type,
      feedback: r.feedback ? redactSensitiveData(r.feedback) : null,
      notes: r.notes ? redactSensitiveData(r.notes) : null,
      rating: r.rating,
      result: r.result,
    }));

    const candidateName = `${candidate.firstName} ${candidate.lastName}`;
    const prompt = interviewNotesSummaryPrompt({
      candidateName,
      jobTitle,
      rounds,
    });

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId: null },
      feature: "hr.interview-notes-summary",
      prompt: {
        system: prompt.system,
        user: prompt.user,
        promptKey: "hr.interview_notes_summary",
        promptVersion: 1,
      },
      schema: InterviewNotesSummarySchema,
      tier: "fast",
      maxTokens: 1024,
      charge: true,
    });

    return unwrapAiResult(result);
  }

  async generateJd(input: GenerateJdInput) {
    const orgId = "system";
    const userId = null;
    const contextLines: string[] = [`Job Title: ${input.title}`];
    if (input.location) contextLines.push(`Location: ${input.location}`);
    if (input.type)
      contextLines.push(`Employment Type: ${input.type.replace("_", " ")}`);
    if (input.salaryMin && input.salaryMax) {
      contextLines.push(
        `Salary Range: ₹${input.salaryMin.toLocaleString("en-IN")} – ₹${input.salaryMax.toLocaleString("en-IN")} per annum`,
      );
    }
    if (input.requirements)
      contextLines.push(
        `Key Requirements / Skills:\n${input.requirements.slice(0, 2000)}`,
      );

    const system = `You are an expert HR recruiter and technical writer.
Write a professional, engaging job description in plain text (no markdown formatting).
Structure: Overview paragraph (3-4 sentences), Key Responsibilities (5-7 bullet points starting with "-"), Requirements (5-7 bullet points starting with "-"), What We Offer (3-4 bullet points starting with "-").
Keep it concise, specific, and compelling. Do not use bold, headers, or markdown.`;

    const user = `Write a job description for the following role:\n\n${contextLines.join("\n")}`;

    const result = await this.gateway.invokeText({
      actor: { orgId, userId },
      feature: "hr.generate-jd",
      prompt: { system, user },
      tier: "fast",
      maxTokens: 1024,
      charge: true,
    });

    const description = unwrapAiResult(result);
    return { description: description.trim() };
  }
}
