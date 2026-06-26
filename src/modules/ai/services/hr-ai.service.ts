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
import { LlmService } from "../providers/llm.service";
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

@Injectable()
export class HrAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly llm: LlmService,
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

    const [attRate] = await this.db
      .select({
        total: count(),
        present: sql<number>`SUM(CASE WHEN status = 'PRESENT' THEN 1 ELSE 0 END)::int`,
      })
      .from(attendance)
      .where(
        and(
          eq(attendance.orgId, orgId),
          eq(attendance.userId, userId),
          gte(attendance.date, ninetyDaysAgo.toISOString().slice(0, 10)),
        ),
      );

    const attendanceRate =
      attRate && attRate.total > 0 ? Math.round((Number(attRate.present) / attRate.total) * 100) : null;

    const [leaveCount] = await this.db
      .select({
        total: sql<number>`COALESCE(SUM(GREATEST(${leaveRequests.endDate}::date - ${leaveRequests.startDate}::date + 1, 0)), 0)::int`,
      })
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.orgId, orgId),
          eq(leaveRequests.userId, userId),
          gte(leaveRequests.startDate, ninetyDaysAgo.toISOString().slice(0, 10)),
        ),
      );

    const [openTickets] = await this.db
      .select({ count: count() })
      .from(helpdeskTickets)
      .where(
        and(
          eq(helpdeskTickets.orgId, orgId),
          eq(helpdeskTickets.userId, userId),
          sql`${helpdeskTickets.status} != 'DONE'`,
        ),
      );

    const [lastReview] = await this.db
      .select({ rating: performanceReviews.overallRating })
      .from(performanceReviews)
      .where(and(eq(performanceReviews.orgId, orgId), eq(performanceReviews.userId, userId)))
      .orderBy(desc(performanceReviews.createdAt))
      .limit(1);

    const [activeGoals] = await this.db
      .select({ count: count() })
      .from(goals)
      .where(
        and(
          eq(goals.orgId, orgId),
          eq(goals.userId, userId),
          sql`${goals.status} IN ('IN_PROGRESS', 'NOT_STARTED')`,
        ),
      );

    const prompt = attritionRiskPrompt({
      employeeName: employee.name ?? "Employee",
      role: employee.role,
      department: null,
      tenureMonths,
      attendanceRate,
      recentLeaveDays: Number(leaveCount?.total ?? 0),
      openTickets: openTickets?.count ?? 0,
      lastReviewRating: lastReview?.rating ? Number(lastReview.rating) : null,
      lastPromotionMonths: null,
      hasGoals: (activeGoals?.count ?? 0) > 0,
    });

    const result = await this.llm.invokeStructured({
      model: "fast",
      schema: AttritionRiskSchema,
      schemaName: "attrition_risk",
      system: prompt.system,
      user: prompt.user,
    });

    result.attritionRiskScore = Math.max(0, Math.min(100, Math.round(result.attritionRiskScore)));
    return result;
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

    const employeeGoals = await this.db
      .select({ goal: goals.title, achieved: goals.status, progress: goals.progress })
      .from(goals)
      .where(
        and(
          eq(goals.orgId, orgId),
          eq(goals.userId, userId),
          gte(goals.createdAt, new Date(periodStart)),
          lte(goals.createdAt, new Date(periodEnd)),
        ),
      )
      .limit(20);

    const [attendanceData] = await this.db
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
      );

    const attendanceRate =
      attendanceData && attendanceData.total > 0
        ? Math.round((Number(attendanceData.present) / attendanceData.total) * 100)
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

    const result = await this.llm.invokeStructured({
      model: "fast",
      schema: ReviewDraftSchema,
      schemaName: "review_draft",
      system: prompt.system,
      user: prompt.user,
    });

    result.overallRating = Math.max(1, Math.min(5, result.overallRating));
    result.ratings = result.ratings.map((r) => ({ ...r, score: Math.max(1, Math.min(5, r.score)) }));
    return result;
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

    return this.llm.invokeStructured({
      model: "fast",
      schema: HelpdeskReplySchema,
      schemaName: "helpdesk_reply",
      system: prompt.system,
      user: prompt.user,
    });
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
        .select({
          title: jobPostings.title,
          description: jobPostings.description,
          requirements: jobPostings.requirements,
        })
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

    const result = await this.llm.invokeStructured({
      model: "fast",
      schema: CandidateScoreSchema,
      schemaName: "candidate_score",
      system: prompt.system,
      user: prompt.user,
    });

    result.score = Math.max(0, Math.min(100, Math.round(result.score)));

    const ratingFiveScale = Math.round((result.score / 100) * 5);
    await this.db
      .update(candidates)
      .set({ rating: ratingFiveScale, updatedAt: new Date() })
      .where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)));

    return result;
  }

  async generateJd(input: GenerateJdInput) {
    const contextLines: string[] = [`Job Title: ${input.title}`];
    if (input.location) contextLines.push(`Location: ${input.location}`);
    if (input.type) contextLines.push(`Employment Type: ${input.type.replace("_", " ")}`);
    if (input.salaryMin && input.salaryMax) {
      contextLines.push(
        `Salary Range: ₹${input.salaryMin.toLocaleString("en-IN")} – ₹${input.salaryMax.toLocaleString("en-IN")} per annum`,
      );
    }
    if (input.requirements) contextLines.push(`Key Requirements / Skills:\n${input.requirements}`);

    const systemPrompt = `You are an expert HR recruiter and technical writer.
Write a professional, engaging job description in plain text (no markdown formatting).
Structure: Overview paragraph (3-4 sentences), Key Responsibilities (5-7 bullet points starting with "-"), Requirements (5-7 bullet points starting with "-"), What We Offer (3-4 bullet points starting with "-").
Keep it concise, specific, and compelling. Do not use bold, headers, or markdown.`;

    const userPrompt = `Write a job description for the following role:\n\n${contextLines.join("\n")}`;

    const description = await this.llm.invokeText({
      model: "fast",
      system: systemPrompt,
      user: userPrompt,
      temperature: 0.7,
    });

    return { description: description.trim() };
  }
}
