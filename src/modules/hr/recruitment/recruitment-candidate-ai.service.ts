import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../common/http/api-exceptions";
import { and, eq } from "drizzle-orm";
import { candidateApplications, candidateResumes, candidates, interviews } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
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
    private readonly gateway: AiGatewayService,
  ) {}

  async aiScore(
    orgId: string,
    candidateId: number,
    userId: string,
  ): Promise<AiScoreResult> {
    const candidate = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
      with: { resume: { columns: { resumeText: true } } },
    });
    if (!candidate) throw new NotFoundException("Candidate not found.");

    const application = await this.db.query.candidateApplications.findFirst({
      where: and(
        eq(candidateApplications.candidateId, candidateId),
        eq(candidateApplications.orgId, orgId),
      ),
      columns: { id: true },
      with: { jobPosting: { columns: { title: true, requirements: true } } },
      orderBy: (t, { desc: d }) => [d(t.appliedAt)],
    });

    const jobTitle =
      application?.jobPosting?.title ?? "an unspecified position";
    const jobRequirements = application?.jobPosting?.requirements ?? "";

    const profile: string[] = [
      `Name: ${candidate.firstName} ${candidate.lastName}`,
    ];
    if (candidate.currentRole)
      profile.push(`Current Role: ${candidate.currentRole}`);
    if (candidate.currentCompany)
      profile.push(`Current Company: ${candidate.currentCompany}`);
    if (candidate.experienceYears)
      profile.push(`Years of Experience: ${candidate.experienceYears}`);
    if (candidate.skills?.length)
      profile.push(`Skills: ${candidate.skills.join(", ")}`);
    if (candidate.resume?.resumeText)
      profile.push(`\nResume Text:\n${candidate.resume.resumeText.slice(0, 3000)}`);

    const gatewayResult = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "hr.score-candidate",
      tier: "fast",
      maxTokens: 1024,
      charge: true,
      schema: AiScoreSchema,
      prompt: {
        system:
          "You are an expert HR recruiter evaluating a candidate. Score each dimension from 0 to 100 based on the candidate profile and job requirements.",
        user: `Position: "${jobTitle}"

Job Requirements:
${jobRequirements || "Not specified."}

Candidate Profile:
${profile.join("\n")}

Score the candidate on technicalSkills, experience, communication, cultureFit and leadership (0-100 each), provide an overall (0-100) and a 2-3 sentence summary.`,
      },
    });

    if (!gatewayResult.ok) {
      if (gatewayResult.kind === "quota_exceeded")
        throw new InsufficientAiCreditsException({ message: gatewayResult.message });
      throw new ServiceUnavailableException(
        "AI scoring is temporarily unavailable",
      );
    }

    const scored: AiScoreResult = {
      overall: clamp(gatewayResult.data.overall),
      breakdown: {
        technicalSkills: clamp(gatewayResult.data.breakdown.technicalSkills),
        experience: clamp(gatewayResult.data.breakdown.experience),
        communication: clamp(gatewayResult.data.breakdown.communication),
        cultureFit: clamp(gatewayResult.data.breakdown.cultureFit),
        leadership: clamp(gatewayResult.data.breakdown.leadership),
      },
      summary: gatewayResult.data.summary,
    };

    await this.db
      .update(candidates)
      .set({
        aiScore: scored.overall,
        aiScoreBreakdown: scored.breakdown,
        aiScoreGeneratedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)));

    return scored;
  }

  async compositeScore(
    orgId: string,
    candidateId: number,
    userId: string,
  ): Promise<CompositeScoreResult> {
    const candidate = await this.db.query.candidates.findFirst({
      columns: { id: true, firstName: true, lastName: true, currentRole: true },
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
    });
    if (!candidate) throw new NotFoundException("Candidate not found.");

    const candidateInterviews = await this.db.query.interviews.findMany({
      limit: 100,
      columns: { id: true, type: true, scheduledAt: true },
      where: and(
        eq(interviews.candidateId, candidateId),
        eq(interviews.orgId, orgId),
      ),
      with: {
        scorecards: { where: (sc, { isNotNull: nn }) => nn(sc.submittedAt) },
      },
      orderBy: (t, { asc }) => [asc(t.scheduledAt)],
    });

    const submitted = candidateInterviews.flatMap((iv) => iv.scorecards ?? []);
    if (submitted.length === 0) {
      throw new BadRequestException(
        "No submitted scorecards found. At least one scorecard must be submitted before generating a composite score.",
      );
    }

    const application = await this.db.query.candidateApplications.findFirst({
      where: and(
        eq(candidateApplications.candidateId, candidateId),
        eq(candidateApplications.orgId, orgId),
      ),
      columns: { id: true },
      with: { jobPosting: { columns: { title: true, requirements: true } } },
      orderBy: (t, { desc: d }) => [d(t.appliedAt)],
    });

    const jobTitle =
      application?.jobPosting?.title ?? "an unspecified position";
    const jobRequirements = application?.jobPosting?.requirements ?? "";

    const roundBlocks = candidateInterviews
      .filter((iv) => (iv.scorecards ?? []).length > 0)
      .map((iv, i) => {
        const scs = iv.scorecards ?? [];
        const ratingValues = scs.flatMap((sc) =>
          Object.values(sc.ratings ?? {}),
        );
        const avg =
          ratingValues.length > 0
            ? ratingValues.reduce((a, b) => a + b, 0) / ratingValues.length
            : null;
        const recommendations = scs.map((sc) => sc.recommendation).join(", ");
        const notes = scs
          .map((sc) => sc.notes)
          .filter(Boolean)
          .join(" | ");
        return `Round ${i + 1} (${iv.type}) — ${iv.scheduledAt.toISOString().split("T")[0]}:
  Recommendations: ${recommendations}
  Avg Score: ${avg != null ? avg.toFixed(1) : "N/A"}
  Notes: ${notes || "None"}`;
      })
      .join("\n\n");

    const gatewayResult = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "hr.composite-score",
      tier: "fast",
      maxTokens: 1536,
      charge: true,
      schema: CompositeScoreSchema,
      prompt: {
        system:
          "You are a senior talent acquisition expert generating a holistic composite hire/no-hire recommendation across all interview rounds.",
        user: `Job Title: ${jobTitle}
Job Requirements:
${jobRequirements || "Not specified."}

Candidate: ${candidate.firstName} ${candidate.lastName}${candidate.currentRole ? ` — ${candidate.currentRole}` : ""}

Interview Scorecard Data:
${roundBlocks}

Provide a verdict (STRONG_HIRE, HIRE, ON_FENCE or NO_HIRE), an overall composite score (0-100), reasoning, strengths across rounds, concerns across rounds, and a per-round summary.`,
      },
    });

    if (!gatewayResult.ok) {
      if (gatewayResult.kind === "quota_exceeded")
        throw new InsufficientAiCreditsException({ message: gatewayResult.message });
      throw new ServiceUnavailableException(
        "AI scoring is temporarily unavailable",
      );
    }

    const result = gatewayResult.data;
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
        overallRating:
          rs.overallRating != null ? clamp(rs.overallRating) : null,
        keyNotes: rs.keyNotes,
      })),
    };
  }

  async parseResume(
    orgId: string,
    candidateId: number,
    userId: string,
    file: Express.Multer.File | undefined,
    body: unknown,
  ) {
    const candidate = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
      columns: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
      },
    });
    if (!candidate) throw new NotFoundException("Candidate not found");

    let text: string;
    if (file) {
      if (file.size > RESUME_MAX_SIZE)
        throw new BadRequestException("File too large (max 5MB)");
      if (!RESUME_ALLOWED_TYPES.includes(file.mimetype)) {
        throw new BadRequestException(
          "Unsupported file type. Please upload a PDF, DOCX, or TXT file.",
        );
      }
      text = file.buffer.toString("utf-8");
    } else {
      const parsedBody = resumeParseBodySchema.parse(body);
      text = parsedBody.resumeText.trim().slice(0, 100000);
      if (!text) throw new BadRequestException("resumeText is required");
    }

    const parsed = await this.parseResumeText(text, orgId, userId);

    await this.db
      .insert(candidateResumes)
      .values({ orgId, candidateId, resumeText: text.slice(0, 100000) })
      .onConflictDoUpdate({
        target: candidateResumes.candidateId,
        set: { resumeText: text.slice(0, 100000), updatedAt: new Date() },
      });

    return {
      parsed,
      suggestions: {
        firstName:
          parsed.name && !candidate.firstName
            ? parsed.name.split(" ")[0]
            : null,
        lastName:
          parsed.name && !candidate.firstName
            ? parsed.name.split(" ").slice(1).join(" ") || null
            : null,
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

  private async parseResumeText(
    text: string,
    orgId: string,
    userId: string,
  ): Promise<ParsedResume> {
    const trimmed = text.slice(0, 12000);
    const gatewayResult = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "hr.resume-parse",
      tier: "fast",
      maxTokens: 1024,
      charge: true,
      schema: ParsedResumeSchema,
      prompt: {
        system:
          "You are an expert resume parser. Extract structured information from the resume text provided. Return null for fields that cannot be found. For skills, return a list of technical and professional skills mentioned. For experienceYears, calculate based on work history if possible, otherwise return null.",
        user: `Parse the following resume and extract the requested fields:\n\n${trimmed}`,
      },
    });

    if (!gatewayResult.ok) return this.fallbackExtract(trimmed);
    return gatewayResult.data;
  }

  private fallbackExtract(text: string): ParsedResume {
    const email = text.match(
      /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/,
    );
    const phone = text.match(/(\+?[\d\s\-().]{7,15}\d)/);
    const name = text.match(/^([A-Z][a-z]+(?:\s[A-Z][a-z]+){1,3})/m);
    const linkedin = text.match(
      /(https?:\/\/(?:www\.)?linkedin\.com\/in\/[^\s]+)/i,
    );
    const portfolio = text.match(
      /(https?:\/\/(?:github\.com|portfolio\.|behance\.net|dribbble\.com)[^\s]+)/i,
    );
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
