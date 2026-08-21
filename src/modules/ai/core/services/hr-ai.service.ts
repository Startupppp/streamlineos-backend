import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, gte, lte, sql } from "drizzle-orm";
import {
  attendance,
  candidates,
  goals,
  helpdeskTickets,
  hiringFlowRounds,
  interviews,
  jobPostings,
  leaveRequests,
  organizationMembers,
  performanceReviews,
  users,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import {
  attritionRiskPrompt,
  candidateScoringPrompt,
  helpdeskReplyPrompt,
  interviewKitPrompt,
  interviewNotesSummaryPrompt,
  letterDraftPrompt,
  policyQaPrompt,
  reviewDraftPrompt,
} from "../prompts/hr.prompts";
import {
  AttritionRiskSchema,
  CandidateScoreSchema,
  HelpdeskReplySchema,
  InterviewKitSchema,
  InterviewNotesSummarySchema,
  LetterDraftSchema,
  PolicyQaSchema,
  ReviewDraftSchema,
  type AttritionRiskResult,
  type CandidateScoreResult,
  type HelpdeskReplyResult,
  type InterviewKitResult,
  type InterviewNotesSummaryResult,
  type LetterDraftResult,
  type PolicyQaResult,
  type ReviewDraftResult,
} from "../dto/output.schemas";
import type { GenerateJdInput } from "../dto/request.schemas";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { unwrapAiResult } from "./gateway-result.util";
import { redactSensitiveData } from "../redaction.util";
import {
  HR_POLICY_AI_CAPABILITY,
  FORBIDDEN_HR_AI_ACTIONS,
  sanitizePolicyCitations,
  type PolicyEvidenceCitation,
} from "../lib/hr-ai-guardrails";

@Injectable()
export class HrAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
  ) {}

  async analyzeAttritionRisk(
    orgId: string,
    userId: string,
  ): Promise<AttritionRiskResult | null> {
    const ctx = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [employee] = await tx
          .select({
            name: users.name,
            role: organizationMembers.role,
            createdAt: users.createdAt,
          })
          .from(users)
          .innerJoin(
            organizationMembers,
            and(
              eq(organizationMembers.userId, users.id),
              eq(organizationMembers.orgId, orgId),
            ),
          )
          .where(eq(users.id, userId));
        if (!employee) return null;

        const tenureMonths = employee.createdAt
          ? Math.floor(
              (Date.now() - new Date(employee.createdAt).getTime()) /
                (1000 * 60 * 60 * 24 * 30),
            )
          : 0;

        const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
        const ninetyDaysAgoStr = ninetyDaysAgo.toISOString().slice(0, 10);

        const [attRate, leaveCount, openTickets, lastReview, activeGoals] =
          await Promise.all([
            tx
              .select({
                total: count(),
                present: sql<number>`SUM(CASE WHEN status = 'PRESENT' THEN 1 ELSE 0 END)::int`,
              })
              .from(attendance)
              .where(
                and(
                  eq(attendance.orgId, orgId),
                  eq(attendance.userId, userId),
                  gte(attendance.date, ninetyDaysAgoStr),
                ),
              ),
            tx
              .select({
                total: sql<number>`COALESCE(SUM(GREATEST(${leaveRequests.endDate}::date - ${leaveRequests.startDate}::date + 1, 0)), 0)::int`,
              })
              .from(leaveRequests)
              .where(
                and(
                  eq(leaveRequests.orgId, orgId),
                  eq(leaveRequests.userId, userId),
                  gte(leaveRequests.startDate, ninetyDaysAgoStr),
                ),
              ),
            tx
              .select({ count: count() })
              .from(helpdeskTickets)
              .where(
                and(
                  eq(helpdeskTickets.orgId, orgId),
                  eq(helpdeskTickets.userId, userId),
                  sql`${helpdeskTickets.status} != 'DONE'`,
                ),
              ),
            tx
              .select({ rating: performanceReviews.overallRating })
              .from(performanceReviews)
              .where(
                and(
                  eq(performanceReviews.orgId, orgId),
                  eq(performanceReviews.userId, userId),
                ),
              )
              .orderBy(desc(performanceReviews.createdAt))
              .limit(1),
            tx
              .select({ count: count() })
              .from(goals)
              .where(
                and(
                  eq(goals.orgId, orgId),
                  eq(goals.userId, userId),
                  sql`${goals.status} IN ('IN_PROGRESS', 'NOT_STARTED')`,
                ),
              ),
          ]);

        return { employee, tenureMonths, attRate, leaveCount, openTickets, lastReview, activeGoals };
      },
      { orgId },
    );
    if (!ctx) return null;

    const { employee, tenureMonths, attRate, leaveCount, openTickets, lastReview, activeGoals } = ctx;

    const attendanceRate =
      attRate[0] && attRate[0].total > 0
        ? Math.round((Number(attRate[0].present) / attRate[0].total) * 100)
        : null;

    const prompt = attritionRiskPrompt({
      employeeName: employee.name ?? "Employee",
      role: employee.role,
      department: null,
      tenureMonths,
      attendanceRate,
      recentLeaveDays: Number(leaveCount[0]?.total ?? 0),
      openTickets: openTickets[0]?.count ?? 0,
      lastReviewRating: lastReview[0]?.rating
        ? Number(lastReview[0].rating)
        : null,
      lastPromotionMonths: null,
      hasGoals: (activeGoals[0]?.count ?? 0) > 0,
    });

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "hr.attrition-risk",
      prompt: {
        system: prompt.system,
        user: prompt.user,
        promptKey: "hr.attrition_risk",
        promptVersion: 1,
      },
      schema: AttritionRiskSchema,
      tier: "fast",
      maxTokens: 512,
      charge: true,
    });

    const data = unwrapAiResult(result);
    data.attritionRiskScore = Math.max(
      0,
      Math.min(100, Math.round(data.attritionRiskScore)),
    );
    return data;
  }

  async generateReview(
    orgId: string,
    userId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<ReviewDraftResult | null> {
    const ctx = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [[employee], employeeGoals, attendanceData] = await Promise.all([
          tx
            .select({ name: users.name, role: organizationMembers.role })
            .from(users)
            .innerJoin(
              organizationMembers,
              and(
                eq(organizationMembers.userId, users.id),
                eq(organizationMembers.orgId, orgId),
              ),
            )
            .where(eq(users.id, userId)),
          tx
            .select({
              goal: goals.title,
              achieved: goals.status,
              progress: goals.progress,
            })
            .from(goals)
            .where(
              and(
                eq(goals.orgId, orgId),
                eq(goals.userId, userId),
                gte(goals.createdAt, new Date(periodStart)),
                lte(goals.createdAt, new Date(periodEnd)),
              ),
            )
            .limit(20),
          tx
            .select({
              total: count(),
              present: sql<number>`SUM(CASE WHEN status = 'PRESENT' THEN 1 ELSE 0 END)::int`,
            })
            .from(attendance)
            .where(
              and(
                eq(attendance.orgId, orgId),
                eq(attendance.userId, userId),
                gte(attendance.date, periodStart),
                lte(attendance.date, periodEnd),
              ),
            ),
        ]);
        if (!employee) return null;
        return { employee, employeeGoals, attendanceData };
      },
      { orgId },
    );
    if (!ctx) return null;

    const { employee, employeeGoals, attendanceData } = ctx;

    const attendanceRate =
      attendanceData[0] && attendanceData[0].total > 0
        ? Math.round(
            (Number(attendanceData[0].present) / attendanceData[0].total) * 100,
          )
        : null;

    const prompt = reviewDraftPrompt({
      employeeName: employee.name ?? "Employee",
      role: employee.role,
      department: null,
      periodStart,
      periodEnd,
      goals: employeeGoals.map((g) => ({
        goal: g.goal,
        achieved: g.achieved === "COMPLETED",
        progress: g.progress ?? 0,
      })),
      recentActivities: null,
      attendanceRate,
      managerNotes: null,
    });

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "hr.generate-review",
      prompt: {
        system: prompt.system,
        user: prompt.user,
        promptKey: "hr.review_draft",
        promptVersion: 1,
      },
      schema: ReviewDraftSchema,
      tier: "fast",
      maxTokens: 1536,
      charge: true,
    });

    const data = unwrapAiResult(result);
    data.overallRating = Math.max(1, Math.min(5, data.overallRating));
    data.ratings = data.ratings.map((r) => ({
      ...r,
      score: Math.max(1, Math.min(5, r.score)),
    }));
    return data;
  }

  async suggestHelpdeskReply(
    orgId: string,
    ticketId: number,
  ): Promise<HelpdeskReplyResult | null> {
    const ticket = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [row] = await tx
          .select({
            title: helpdeskTickets.title,
            description: helpdeskTickets.description,
            category: helpdeskTickets.category,
            priority: helpdeskTickets.priority,
            userId: helpdeskTickets.userId,
            employeeName: users.name,
          })
          .from(helpdeskTickets)
          .leftJoin(users, eq(helpdeskTickets.userId, users.id))
          .where(
            and(eq(helpdeskTickets.id, ticketId), eq(helpdeskTickets.orgId, orgId)),
          );
        return row ?? null;
      },
      { orgId },
    );
    if (!ticket) return null;

    const prompt = helpdeskReplyPrompt({
      ticketTitle: ticket.title,
      ticketDescription: ticket.description,
      category: ticket.category,
      priority: ticket.priority,
      employeeName: ticket.employeeName,
    });

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId: ticket.userId ?? null },
      feature: "hr.helpdesk-reply",
      prompt: {
        system: prompt.system,
        user: prompt.user,
        promptKey: "hr.helpdesk_reply",
        promptVersion: 1,
      },
      schema: HelpdeskReplySchema,
      tier: "fast",
      maxTokens: 768,
      charge: true,
    });

    return unwrapAiResult(result);
  }

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

  async policyQa(
    orgId: string,
    userId: string,
    question: string,
  ): Promise<
    PolicyQaResult & {
      suggestTicket: boolean;
      citations: PolicyEvidenceCitation[];
      capability: typeof HR_POLICY_AI_CAPABILITY;
      forbiddenActions: typeof FORBIDDEN_HR_AI_ACTIONS;
      advisory: true;
      disclaimer: string;
    }
  > {
    const safeQuestion = redactSensitiveData(question);

    const policies = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const rows = await tx.execute(sql`
          SELECT id, policy_type, name
          FROM hr_policies
          WHERE org_id = ${orgId}
            AND status = 'active'
            AND deleted_at IS NULL
          ORDER BY priority DESC, created_at DESC
          LIMIT 20
        `);
        return (rows as Array<Record<string, unknown>>).map((p) => ({
          id: Number(p.id),
          policyType: String(p.policy_type),
          scopeType: null as string | null,
          name: p.name ? String(p.name) : null,
        }));
      },
      { orgId },
    );

    const prompt = policyQaPrompt({ question: safeQuestion, policies });

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "hr.policy-qa",
      prompt: {
        system: prompt.system,
        user: prompt.user,
        promptKey: "hr.policy_qa",
        promptVersion: 2,
      },
      schema: PolicyQaSchema,
      tier: "fast",
      maxTokens: 1024,
      charge: true,
    });

    const data = unwrapAiResult(result);
    const citations = sanitizePolicyCitations(data.citations ?? [], policies);
    const suggestTicket =
      data.confidence === "not_found" || data.shouldEscalate;
    return {
      ...data,
      citations,
      suggestTicket,
      capability: HR_POLICY_AI_CAPABILITY,
      forbiddenActions: FORBIDDEN_HR_AI_ACTIONS,
      advisory: true,
      disclaimer: HR_POLICY_AI_CAPABILITY.honestyLabel,
    };
  }

  policyQaCapabilities() {
    return {
      ...HR_POLICY_AI_CAPABILITY,
      forbiddenActions: FORBIDDEN_HR_AI_ACTIONS,
      features: [
        {
          key: "hr.policy-qa",
          mode: "answer_from_active_policies",
          requiresHumanEscalationWhenNotFound: true,
        },
      ],
    };
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

  async draftLetter(
    orgId: string,
    _: string,
    targetUserId: string,
    letterType: string,
    details: string | null,
  ): Promise<LetterDraftResult | null> {
    const ctx = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const empRows = await tx.execute(sql`
          SELECT p.first_name, p.last_name, e.designation
          FROM hr_employments e
          JOIN hr_people p ON p.id = e.person_id
          WHERE e.org_id = ${orgId}
            AND p.user_id = ${targetUserId}
            AND e.deleted_at IS NULL
          LIMIT 1
        `);

        if (empRows.length > 0) {
          const emp = empRows[0] as Record<string, unknown>;
          return {
            employeeName: `${emp.first_name ?? ""} ${emp.last_name ?? ""}`.trim(),
            currentTitle: emp.designation ? String(emp.designation) : null,
          };
        }

        const [userRow] = await tx
          .select({ name: users.name })
          .from(users)
          .where(eq(users.id, targetUserId));
        if (!userRow) return null;
        return {
          employeeName: userRow.name ?? targetUserId,
          currentTitle: null,
        };
      },
      { orgId },
    );
    if (!ctx) return null;

    const { employeeName, currentTitle } = ctx;

    const safeDetails = details ? redactSensitiveData(details) : null;
    const prompt = letterDraftPrompt({
      letterType,
      employeeName,
      currentTitle,
      details: safeDetails,
    });

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId: targetUserId },
      feature: "hr.letter-draft",
      prompt: {
        system: prompt.system,
        user: prompt.user,
        promptKey: "hr.letter_draft",
        promptVersion: 1,
      },
      schema: LetterDraftSchema,
      tier: "fast",
      maxTokens: 1024,
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
