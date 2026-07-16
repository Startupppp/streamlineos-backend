import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, gte, lte, sql } from "drizzle-orm";
import {
  attendance,
  candidates,
  goals,
  helpdeskTickets,
  jobPostings,
  leaveRequests,
  performanceReviews,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  attritionRiskPrompt,
  candidateScoringPrompt,
  helpdeskReplyPrompt,
  reviewDraftPrompt,
} from "../prompts/hr.prompts";
import {
  AttritionRiskSchema,
  CandidateScoreSchema,
  HelpdeskReplySchema,
  ReviewDraftSchema,
  type AttritionRiskResult,
  type CandidateScoreResult,
  type HelpdeskReplyResult,
  type ReviewDraftResult,
} from "../dto/output.schemas";
import type { GenerateJdInput } from "../dto/request.schemas";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { getFeatureCost } from "../billing/ai-cost-catalog";
import { unwrapAiResult } from "./gateway-result.util";

@Injectable()
export class HrAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
  ) {}

  async analyzeAttritionRisk(orgId: string, userId: string): Promise<AttritionRiskResult | null> {
    const [employee] = await this.db
      .select({ name: users.name, role: users.role, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.id, userId));
    if (!employee) return null;

    const tenureMonths = employee.createdAt
      ? Math.floor((Date.now() - new Date(employee.createdAt).getTime()) / (1000 * 60 * 60 * 24 * 30))
      : 0;

    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgoStr = ninetyDaysAgo.toISOString().slice(0, 10);

    const [attRate, leaveCount, openTickets, lastReview, activeGoals] = await Promise.all([
      this.db
        .select({
          total: count(),
          present: sql<number>`SUM(CASE WHEN status = 'PRESENT' THEN 1 ELSE 0 END)::int`,
        })
        .from(attendance)
        .where(and(eq(attendance.orgId, orgId), eq(attendance.userId, userId), gte(attendance.date, ninetyDaysAgoStr))),
      this.db
        .select({
          total: sql<number>`COALESCE(SUM(GREATEST(${leaveRequests.endDate}::date - ${leaveRequests.startDate}::date + 1, 0)), 0)::int`,
        })
        .from(leaveRequests)
        .where(and(eq(leaveRequests.orgId, orgId), eq(leaveRequests.userId, userId), gte(leaveRequests.startDate, ninetyDaysAgoStr))),
      this.db
        .select({ count: count() })
        .from(helpdeskTickets)
        .where(and(eq(helpdeskTickets.orgId, orgId), eq(helpdeskTickets.userId, userId), sql`${helpdeskTickets.status} != 'DONE'`)),
      this.db
        .select({ rating: performanceReviews.overallRating })
        .from(performanceReviews)
        .where(and(eq(performanceReviews.orgId, orgId), eq(performanceReviews.userId, userId)))
        .orderBy(desc(performanceReviews.createdAt))
        .limit(1),
      this.db
        .select({ count: count() })
        .from(goals)
        .where(and(eq(goals.orgId, orgId), eq(goals.userId, userId), sql`${goals.status} IN ('IN_PROGRESS', 'NOT_STARTED')`)),
    ]);

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
      lastReviewRating: lastReview[0]?.rating ? Number(lastReview[0].rating) : null,
      lastPromotionMonths: null,
      hasGoals: (activeGoals[0]?.count ?? 0) > 0,
    });

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "hr.attrition-risk",
      prompt: { system: prompt.system, user: prompt.user, promptKey: "hr.attrition_risk", promptVersion: 1 },
      schema: AttritionRiskSchema,
      tier: "fast",
      maxTokens: 512,
      charge: { credits: getFeatureCost("hr.attrition-risk") },
    });

    const data = unwrapAiResult(result);
    data.attritionRiskScore = Math.max(0, Math.min(100, Math.round(data.attritionRiskScore)));
    return data;
  }

  async generateReview(
    orgId: string,
    userId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<ReviewDraftResult | null> {
    const [employee] = await this.db
      .select({ name: users.name, role: users.role })
      .from(users)
      .where(eq(users.id, userId));
    if (!employee) return null;

    const [employeeGoals, attendanceData] = await Promise.all([
      this.db
        .select({ goal: goals.title, achieved: goals.status, progress: goals.progress })
        .from(goals)
        .where(and(eq(goals.orgId, orgId), eq(goals.userId, userId), gte(goals.createdAt, new Date(periodStart)), lte(goals.createdAt, new Date(periodEnd))))
        .limit(20),
      this.db
        .select({
          total: count(),
          present: sql<number>`SUM(CASE WHEN status = 'PRESENT' THEN 1 ELSE 0 END)::int`,
        })
        .from(attendance)
        .where(and(eq(attendance.orgId, orgId), eq(attendance.userId, userId), gte(attendance.date, periodStart), lte(attendance.date, periodEnd))),
    ]);

    const attendanceRate =
      attendanceData[0] && attendanceData[0].total > 0
        ? Math.round((Number(attendanceData[0].present) / attendanceData[0].total) * 100)
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
      prompt: { system: prompt.system, user: prompt.user, promptKey: "hr.review_draft", promptVersion: 1 },
      schema: ReviewDraftSchema,
      tier: "fast",
      maxTokens: 1536,
      charge: { credits: getFeatureCost("hr.generate-review") },
    });

    const data = unwrapAiResult(result);
    data.overallRating = Math.max(1, Math.min(5, data.overallRating));
    data.ratings = data.ratings.map((r) => ({ ...r, score: Math.max(1, Math.min(5, r.score)) }));
    return data;
  }

  async suggestHelpdeskReply(orgId: string, ticketId: number): Promise<HelpdeskReplyResult | null> {
    const [ticket] = await this.db
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
      .where(and(eq(helpdeskTickets.id, ticketId), eq(helpdeskTickets.orgId, orgId)));
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
      prompt: { system: prompt.system, user: prompt.user, promptKey: "hr.helpdesk_reply", promptVersion: 1 },
      schema: HelpdeskReplySchema,
      tier: "fast",
      maxTokens: 768,
      charge: { credits: getFeatureCost("hr.helpdesk-reply") },
    });

    return unwrapAiResult(result);
  }

  async scoreCandidate(
    orgId: string,
    candidateId: number,
    jobId?: number,
  ): Promise<CandidateScoreResult | null> {
    const [candidate] = await this.db
      .select()
      .from(candidates)
      .where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)));
    if (!candidate) return null;

    let job: { title: string; description: string | null; requirements: string | null } | null = null;
    if (jobId) {
      const [jobRecord] = await this.db
        .select({ title: jobPostings.title, description: jobPostings.description, requirements: jobPostings.requirements })
        .from(jobPostings)
        .where(and(eq(jobPostings.id, jobId), eq(jobPostings.orgId, orgId)));
      if (jobRecord) job = jobRecord;
    }

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
      prompt: { system: prompt.system, user: prompt.user, promptKey: "hr.candidate_scoring", promptVersion: 1 },
      schema: CandidateScoreSchema,
      tier: "fast",
      maxTokens: 512,
      charge: { credits: getFeatureCost("hr.score-candidate") },
    });

    const data = unwrapAiResult(result);
    data.score = Math.max(0, Math.min(100, Math.round(data.score)));

    const ratingFiveScale = Math.round((data.score / 100) * 5);
    await this.db
      .update(candidates)
      .set({ rating: ratingFiveScale, updatedAt: new Date() })
      .where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)));

    return data;
  }

  async generateJd(input: GenerateJdInput) {
    const orgId = "system";
    const userId = null;
    const contextLines: string[] = [`Job Title: ${input.title}`];
    if (input.location) contextLines.push(`Location: ${input.location}`);
    if (input.type) contextLines.push(`Employment Type: ${input.type.replace("_", " ")}`);
    if (input.salaryMin && input.salaryMax) {
      contextLines.push(`Salary Range: ₹${input.salaryMin.toLocaleString("en-IN")} – ₹${input.salaryMax.toLocaleString("en-IN")} per annum`);
    }
    if (input.requirements) contextLines.push(`Key Requirements / Skills:\n${input.requirements.slice(0, 2000)}`);

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
      charge: { credits: getFeatureCost("hr.generate-jd") },
    });

    const description = unwrapAiResult(result);
    return { description: description.trim() };
  }
}
