import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { candidateApplications, candidates, interviews } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { LlmService } from "../ai/providers/llm.service";
import {
  AiScoreSchema,
  CompositeScoreSchema,
  ParsedResumeSchema,
  resumeParseBodySchema,
  type AiScoreResult,
  type CompositeScoreResult,
  type ParsedResume,
} from "./dto/candidate-ai.schemas";

const RESUME_ALLOWED_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "text/plain",
];
const RESUME_MAX_SIZE = 5 * 1024 * 1024;

function clamp(n: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

@Injectable()
export class RecruitmentCandidateAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly llm: LlmService,
  ) {}

  async aiScore(orgId: string, candidateId: number): Promise<AiScoreResult> {
    const candidate = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
    });
    if (!candidate) throw new NotFoundException("Candidate not found.");

    if (!this.llm.isConfigured()) {
      throw new ServiceUnavailableException("AI scoring is not configured.");
    }

    const application = await this.db.query.candidateApplications.findFirst({
      where: and(eq(candidateApplications.candidateId, candidateId), eq(candidateApplications.orgId, orgId)),
      with: { jobPosting: true },
      orderBy: (t, { desc: d }) => [d(t.appliedAt)],
    });

    const jobTitle = application?.jobPosting?.title ?? "an unspecified position";
    const jobRequirements = application?.jobPosting?.requirements ?? "";

    const profile: string[] = [`Name: ${candidate.firstName} ${candidate.lastName}`];
    if (candidate.currentRole) profile.push(`Current Role: ${candidate.currentRole}`);
    if (candidate.currentCompany) profile.push(`Current Company: ${candidate.currentCompany}`);
    if (candidate.experienceYears) profile.push(`Years of Experience: ${candidate.experienceYears}`);
    if (candidate.skills?.length) profile.push(`Skills: ${candidate.skills.join(", ")}`);
    if (candidate.resumeText) profile.push(`\nResume Text:\n${candidate.resumeText.slice(0, 3000)}`);

    const result = await this.llm.invokeStructured({
      model: "fast",
      schema: AiScoreSchema,
      schemaName: "candidate_ai_score",
      system:
        "You are an expert HR recruiter evaluating a candidate. Score each dimension from 0 to 100 based on the candidate profile and job requirements.",
      user: `Position: "${jobTitle}"

Job Requirements:
${jobRequirements || "Not specified."}

Candidate Profile:
${profile.join("\n")}

Score the candidate on technicalSkills, experience, communication, cultureFit and leadership (0-100 each), provide an overall (0-100) and a 2-3 sentence summary.`,
    });

    const scored: AiScoreResult = {
      overall: clamp(result.overall),
      breakdown: {
        technicalSkills: clamp(result.breakdown.technicalSkills),
        experience: clamp(result.breakdown.experience),
        communication: clamp(result.breakdown.communication),
        cultureFit: clamp(result.breakdown.cultureFit),
        leadership: clamp(result.breakdown.leadership),
      },
      summary: result.summary,
    };

    await this.db
      .update(candidates)
      .set({
        aiScore: scored.overall,
        aiScoreBreakdown: scored.breakdown,
        aiScoreGeneratedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(candidates.id, candidateId));

    return scored;
  }

  async compositeScore(orgId: string, candidateId: number): Promise<CompositeScoreResult> {
    const candidate = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
    });
    if (!candidate) throw new NotFoundException("Candidate not found.");

    const candidateInterviews = await this.db.query.interviews.findMany({
      where: and(eq(interviews.candidateId, candidateId), eq(interviews.orgId, orgId)),
      with: { scorecards: { where: (sc, { isNotNull: nn }) => nn(sc.submittedAt) } },
      orderBy: (t, { asc }) => [asc(t.scheduledAt)],
    });

    const submitted = candidateInterviews.flatMap((iv) => iv.scorecards ?? []);
    if (submitted.length === 0) {
      throw new BadRequestException(
        "No submitted scorecards found. At least one scorecard must be submitted before generating a composite score.",
      );
    }

    if (!this.llm.isConfigured()) {
      throw new ServiceUnavailableException("AI composite scoring is not configured.");
    }

    const application = await this.db.query.candidateApplications.findFirst({
      where: and(eq(candidateApplications.candidateId, candidateId), eq(candidateApplications.orgId, orgId)),
      with: { jobPosting: true },
      orderBy: (t, { desc: d }) => [d(t.appliedAt)],
    });

    const jobTitle = application?.jobPosting?.title ?? "an unspecified position";
    const jobRequirements = application?.jobPosting?.requirements ?? "";

    const roundBlocks = candidateInterviews
      .filter((iv) => (iv.scorecards ?? []).length > 0)
      .map((iv, i) => {
        const scs = iv.scorecards ?? [];
        const ratingValues = scs.flatMap((sc) => Object.values(sc.ratings ?? {}));
        const avg = ratingValues.length > 0 ? ratingValues.reduce((a, b) => a + b, 0) / ratingValues.length : null;
        const recommendations = scs.map((sc) => sc.recommendation).join(", ");
        const notes = scs.map((sc) => sc.notes).filter(Boolean).join(" | ");
        return `Round ${i + 1} (${iv.type}) — ${iv.scheduledAt.toISOString().split("T")[0]}:
  Recommendations: ${recommendations}
  Avg Score: ${avg != null ? avg.toFixed(1) : "N/A"}
  Notes: ${notes || "None"}`;
      })
      .join("\n\n");

    const result = await this.llm.invokeStructured({
      model: "fast",
      schema: CompositeScoreSchema,
      schemaName: "candidate_composite_score",
      system:
        "You are a senior talent acquisition expert generating a holistic composite hire/no-hire recommendation across all interview rounds.",
      user: `Job Title: ${jobTitle}
Job Requirements:
${jobRequirements || "Not specified."}

Candidate: ${candidate.firstName} ${candidate.lastName}${candidate.currentRole ? ` — ${candidate.currentRole}` : ""}

Interview Scorecard Data:
${roundBlocks}

Provide a verdict (STRONG_HIRE, HIRE, ON_FENCE or NO_HIRE), an overall composite score (0-100), reasoning, strengths across rounds, concerns across rounds, and a per-round summary.`,
    });

    return {
      verdict: result.verdict,
      overall: clamp(result.overall),
      reasoning: result.reasoning,
      strengthsAcrossRounds: result.strengthsAcrossRounds,
      concernsAcrossRounds: result.concernsAcrossRounds,
      roundSummaries: result.roundSummaries.map((rs) => ({
        interviewType: rs.interviewType,
        scheduledAt: rs.scheduledAt,
        recommendation: rs.recommendation,
        overallRating: rs.overallRating != null ? clamp(rs.overallRating) : null,
        keyNotes: rs.keyNotes,
      })),
    };
  }

  async parseResume(orgId: string, candidateId: number, file: Express.Multer.File | undefined, body: unknown) {
    const candidate = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
      columns: { id: true, firstName: true, lastName: true, email: true, phone: true },
    });
    if (!candidate) throw new NotFoundException("Candidate not found");

    let text: string;
    if (file) {
      if (file.size > RESUME_MAX_SIZE) throw new BadRequestException("File too large (max 5MB)");
      if (!RESUME_ALLOWED_TYPES.includes(file.mimetype)) {
        throw new BadRequestException("Unsupported file type. Please upload a PDF, DOCX, or TXT file.");
      }
      text = file.buffer.toString("utf-8");
    } else {
      const parsedBody = resumeParseBodySchema.parse(body);
      text = parsedBody.resumeText.trim().slice(0, 100000);
      if (!text) throw new BadRequestException("resumeText is required");
    }

    const parsed = await this.parseResumeText(text);

    await this.db
      .update(candidates)
      .set({ resumeText: text.slice(0, 100000), updatedAt: new Date() })
      .where(eq(candidates.id, candidateId));

    return {
      parsed,
      suggestions: {
        firstName: parsed.name && !candidate.firstName ? parsed.name.split(" ")[0] : null,
        lastName:
          parsed.name && !candidate.firstName ? parsed.name.split(" ").slice(1).join(" ") || null : null,
        email: parsed.email && !candidate.email ? parsed.email : null,
        phone: parsed.phone && !candidate.phone ? parsed.phone : null,
        currentCompany: parsed.currentCompany,
        currentRole: parsed.currentRole,
        experienceYears: parsed.experienceYears,
        skills: parsed.skills,
        location: parsed.location,
        linkedinUrl: parsed.linkedinUrl,
        portfolioUrl: parsed.portfolioUrl,
      },
    };
  }

  private async parseResumeText(text: string): Promise<ParsedResume> {
    const trimmed = text.slice(0, 12000);
    if (!this.llm.isConfigured()) return this.fallbackExtract(trimmed);
    try {
      return await this.llm.invokeStructured({
        model: "fast",
        schema: ParsedResumeSchema,
        schemaName: "ParsedResume",
        system:
          "You are an expert resume parser. Extract structured information from the resume text provided. Return null for fields that cannot be found. For skills, return a list of technical and professional skills mentioned. For experienceYears, calculate based on work history if possible, otherwise return null.",
        user: `Parse the following resume and extract the requested fields:\n\n${trimmed}`,
      });
    } catch {
      return this.fallbackExtract(trimmed);
    }
  }

  private fallbackExtract(text: string): ParsedResume {
    const email = text.match(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/);
    const phone = text.match(/(\+?[\d\s\-().]{7,15}\d)/);
    const name = text.match(/^([A-Z][a-z]+(?:\s[A-Z][a-z]+){1,3})/m);
    const linkedin = text.match(/(https?:\/\/(?:www\.)?linkedin\.com\/in\/[^\s]+)/i);
    const portfolio = text.match(/(https?:\/\/(?:github\.com|portfolio\.|behance\.net|dribbble\.com)[^\s]+)/i);
    return {
      name: name?.[1] ?? null,
      email: email?.[1] ?? null,
      phone: phone?.[1] ?? null,
      currentCompany: null,
      currentRole: null,
      experienceYears: null,
      skills: [],
      location: null,
      education: null,
      linkedinUrl: linkedin?.[1] ?? null,
      portfolioUrl: portfolio?.[1] ?? null,
    };
  }
}
