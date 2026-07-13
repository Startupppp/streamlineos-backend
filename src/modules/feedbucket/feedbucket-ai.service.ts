import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { feedbucketSubmissions } from "../../db/schema";
import { LlmService } from "../ai/providers/llm.service";
import { AiCreditsService } from "../billing/ai-credits.service";
import { AiUsageService } from "../ai/services/ai-usage.service";
import { AuditService } from "../../common/audit/audit.service";
import { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import { ProjectsTicketsService } from "../projects/projects-tickets.service";
import { requireFeature } from "../ai/billing/feature-gates";
import {
  FeedbackAnalysisSchema,
  type FeedbackAnalysis,
} from "./feedbucket-ai.schemas";
import {
  buildSystemPrompt,
  buildUserPrompt,
  mapToTicketType,
  buildEpicDescription,
  buildBugDescription,
} from "./feedbucket-ai.prompts";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

const AI_CREDIT_COST = 5;
const FEATURE_KEY = "feedbucket.ai-analyze" as const;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 8000;

const IMAGE_MIME_SIGNATURES: Array<{ mime: string; bytes: number[] }> = [
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46] },
];

function detectImageMime(buf: Buffer): string | null {
  for (const sig of IMAGE_MIME_SIGNATURES) {
    if (sig.bytes.every((b, i) => buf[i] === b)) return sig.mime;
  }
  return null;
}

function getAllowedStorageHost(): string | null {
  const base = process.env.NEXT_PUBLIC_R2_PUBLIC_URL?.trim();
  if (!base) return null;
  try {
    return new URL(base).hostname;
  } catch {
    return null;
  }
}

function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, "")
    .replace(/href\s*=\s*["']?\s*javascript:[^"'\s>]*/gi, 'href="#"')
    .replace(/src\s*=\s*["']?\s*javascript:[^"'\s>]*/gi, 'src=""');
}

@Injectable()
export class FeedbucketAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly llm: LlmService,
    private readonly credits: AiCreditsService,
    private readonly aiUsage: AiUsageService,
    private readonly audit: AuditService,
    private readonly rateLimiter: RateLimitService,
    private readonly ticketsService: ProjectsTicketsService,
  ) {}

  private ensureLlm(): void {
    if (!this.llm.isConfigured()) {
      throw new ServiceUnavailableException("AI is not configured. Set OPENAI_API_KEY.");
    }
  }

  private async loadSubmission(orgId: string, submissionId: number) {
    const row = await this.db.query.feedbucketSubmissions.findFirst({
      where: and(
        eq(feedbucketSubmissions.id, submissionId),
        eq(feedbucketSubmissions.orgId, orgId),
        isNull(feedbucketSubmissions.deletedAt),
      ),
      with: { widget: { with: { project: true } } },
    });
    if (!row) throw new NotFoundException("Submission not found");
    return row;
  }

  private assertProjectAccess(submission: Awaited<ReturnType<typeof this.loadSubmission>>, orgId: string): number {
    const widget = submission.widget;
    if (!widget) throw new NotFoundException("Submission has no associated widget");
    const project = widget.project;
    if (!project || !widget.projectId) throw new NotFoundException("Widget has no linked project");
    if (project.orgId !== orgId) throw new ForbiddenException("Project does not belong to your organisation");
    return widget.projectId;
  }

  private async resolveScreenshotForVision(
    screenshotUrl: string | null | undefined,
  ): Promise<string[]> {
    if (!screenshotUrl) return [];

    const allowedHost = getAllowedStorageHost();
    if (!allowedHost) return [];

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(screenshotUrl);
    } catch {
      return [];
    }

    if (parsedUrl.hostname !== allowedHost) return [];

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);

      let res: Response;
      try {
        res = await fetch(screenshotUrl, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) return [];

      const contentLength = Number(res.headers.get("content-length") ?? "0");
      if (contentLength > MAX_IMAGE_BYTES) return [];

      const arrayBuf = await res.arrayBuffer();
      if (arrayBuf.byteLength > MAX_IMAGE_BYTES) return [];

      const buf = Buffer.from(arrayBuf);
      const mime = detectImageMime(buf);
      if (!mime) return [];

      const b64 = buf.toString("base64");
      return [`data:${mime};base64,${b64}`];
    } catch {
      return [];
    }
  }

  async analyze(u: CurrentUserContext, submissionId: number, force = false): Promise<FeedbackAnalysis> {
    requireFeature(u.plan, "ai.feedbucket");
    this.ensureLlm();

    const submission = await this.loadSubmission(u.orgId, submissionId);
    this.assertProjectAccess(submission, u.orgId);

    if (submission.aiProcessedAt && !force) {
      const stored = submission.aiAnalysis as FeedbackAnalysis | null;
      if (stored) return stored;
    }

    const rateLimitResult = await this.rateLimiter.check("feedbucket:ai-analyze", u.userId);
    if (!rateLimitResult.allowed) {
      throw new HttpException(
        `AI analysis rate limit reached. Retry after ${rateLimitResult.retryAfterSecs}s.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const model = "standard";

    await this.credits.consumeCredits(
      u.orgId,
      u.userId,
      AI_CREDIT_COST,
      FEATURE_KEY,
      model,
      String(submissionId),
    );

    const images = await this.resolveScreenshotForVision(submission.screenshotUrl);
    const system = buildSystemPrompt();
    const userContent = buildUserPrompt({
      type: submission.type,
      message: submission.message,
      pageUrl: submission.pageUrl,
      metadata: submission.metadata,
      consoleLogs: submission.consoleLogs,
    });

    let rawResult: FeedbackAnalysis;
    try {
      rawResult = await this.llm.invokeStructuredWithImage({
        model,
        schema: FeedbackAnalysisSchema,
        schemaName: "FeedbackAnalysis",
        system,
        user: userContent,
        images,
      });
    } catch (err) {
      if (err instanceof ServiceUnavailableException) {
        await this.credits.refundCredits(u.orgId, u.userId, AI_CREDIT_COST, FEATURE_KEY, String(submissionId));
      }
      throw err;
    }

    const suggestedTicketType = mapToTicketType(rawResult.type);
    const analysis: FeedbackAnalysis = {
      ...rawResult,
      suggestedTicketType,
      description: sanitizeHtml(rawResult.description),
      model,
      processedAt: new Date().toISOString(),
    };

    await this.db
      .update(feedbucketSubmissions)
      .set({
        aiType: analysis.type,
        aiConfidence: analysis.confidence,
        aiAnalysis: analysis,
        aiModel: model,
        aiProcessedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(eq(feedbucketSubmissions.id, submissionId), eq(feedbucketSubmissions.orgId, u.orgId)),
      );

    this.audit.log({
      action: "feedbucket.ai_analyzed",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "feedbucket_submission",
      resourceId: String(submissionId),
      metadata: { type: analysis.type, confidence: analysis.confidence, model },
    });

    void this.aiUsage.track({
      orgId: u.orgId,
      userId: u.userId,
      feature: FEATURE_KEY,
      model,
    });

    return analysis;
  }

  async createTicketFromAnalysis(
    u: CurrentUserContext,
    submissionId: number,
  ): Promise<{ ticketId: number; ticketType: string }> {
    requireFeature(u.plan, "ai.feedbucket");

    const submission = await this.loadSubmission(u.orgId, submissionId);
    const projectId = this.assertProjectAccess(submission, u.orgId);

    if (submission.linkedTicketId) {
      throw new ConflictException("Submission is already linked to a ticket");
    }

    let analysis = submission.aiAnalysis as FeedbackAnalysis | null;
    if (!analysis) {
      analysis = await this.analyze(u, submissionId);
    }

    const ticketType = mapToTicketType(analysis.type);
    const description =
      ticketType === "EPIC" || ticketType === "STORY"
        ? buildEpicDescription(analysis, submission.screenshotUrl, submission.pageUrl)
        : buildBugDescription(analysis, submission.screenshotUrl, submission.pageUrl);

    const ticket = await this.ticketsService.createFromFeedback(u.orgId, u.userId, projectId, {
      title: analysis.title.slice(0, 255),
      description,
      type: ticketType,
    });

    await this.db
      .update(feedbucketSubmissions)
      .set({ linkedTicketId: ticket.id, updatedAt: new Date() })
      .where(
        and(eq(feedbucketSubmissions.id, submissionId), eq(feedbucketSubmissions.orgId, u.orgId)),
      );

    this.audit.log({
      action: "feedbucket.ai_ticket_created",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "feedbucket_submission",
      resourceId: String(submissionId),
      metadata: { ticketId: ticket.id, ticketType },
    });

    return { ticketId: ticket.id, ticketType };
  }
}
