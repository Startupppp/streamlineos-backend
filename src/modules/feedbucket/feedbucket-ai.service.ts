import {
  BadRequestException,
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
import { AiGatewayService } from "../ai/gateway/ai-gateway.service";
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
import type { FeedbucketConsoleEntry, FeedbucketMetadata, FeedbucketNetworkEntry } from "../../db/schema/feedbucket";
import type { AiUsageMeta } from "../ai/gateway/ai-gateway.types";

const FEATURE_KEY = "feedbucket.analyze" as const;
const PUBLIC_FEATURE_KEY = "feedbucket.assist" as const;

const WIDGET_TYPE_MAP: Record<FeedbackAnalysis["type"], string> = {
  bug: "bug",
  feature: "feature",
  improvement: "idea",
  question: "question",
  praise: "praise",
  other: "other",
};

function mapPublicType(type: FeedbackAnalysis["type"]): string {
  return WIDGET_TYPE_MAP[type];
}

function buildPlaintextDescription(analysis: FeedbackAnalysis): string {
  const parts: string[] = [analysis.summary];
  if (analysis.reproductionSteps.length > 0) {
    parts.push("\nSteps to reproduce:");
    analysis.reproductionSteps.forEach((step, i) => parts.push(`${i + 1}. ${step}`));
  }
  if (analysis.suggestions.length > 0) {
    parts.push("\nSuggestions:");
    analysis.suggestions.forEach((s) => parts.push(`- ${s}`));
  }
  return parts.join("\n");
}

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

function throwOnFailure(kind: "not_configured" | "provider_unavailable" | "quota_exceeded" | "invalid_output", message: string): never {
  switch (kind) {
    case "quota_exceeded":
      throw new BadRequestException(message);
    case "not_configured":
    case "provider_unavailable":
      throw new ServiceUnavailableException(message);
    case "invalid_output":
      throw new ServiceUnavailableException("AI returned an invalid response");
    default: {
      const _exhaustive: never = kind;
      throw new ServiceUnavailableException(`Unhandled AI failure: ${String(_exhaustive)}`);
    }
  }
}

@Injectable()
export class FeedbucketAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly aiUsage: AiUsageService,
    private readonly audit: AuditService,
    private readonly rateLimiter: RateLimitService,
    private readonly ticketsService: ProjectsTicketsService,
  ) {}

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

  private async runVisionAnalysis(opts: {
    orgId: string;
    userId: string | null;
    feature: string;
    type: string;
    message: string;
    pageUrl?: string | null;
    imageDataUrls: string[];
    networkLogs?: FeedbucketNetworkEntry[] | null;
    metadata?: FeedbucketMetadata | null;
    consoleLogs?: FeedbucketConsoleEntry[] | null;
  }): Promise<FeedbackAnalysis & { aiUsage?: AiUsageMeta }> {
    const system = buildSystemPrompt();
    const userContent = buildUserPrompt({
      type: opts.type,
      message: opts.message,
      pageUrl: opts.pageUrl,
      metadata: opts.metadata ?? null,
      consoleLogs: opts.consoleLogs ?? null,
      networkLogs: opts.networkLogs,
    });

    const result = await this.gateway.invokeStructuredWithImageWithUsage({
      actor: { orgId: opts.orgId, userId: opts.userId },
      feature: opts.feature,
      tier: "standard",
      prompt: { system, user: userContent },
      schema: FeedbackAnalysisSchema,
      images: opts.imageDataUrls,
      charge: true,
      redact: false,
    });

    if (!result.ok) {
      throwOnFailure(result.kind, result.message);
    }

    const rawResult = result.data;
    return {
      ...rawResult,
      suggestedTicketType: mapToTicketType(rawResult.type),
      description: sanitizeHtml(rawResult.description),
      model: "standard",
      processedAt: new Date().toISOString(),
      aiUsage: result.aiUsage,
    };
  }

  async analyzePublic(opts: {
    orgId: string;
    actorUserId: string;
    widgetId: number;
    type: string;
    message: string;
    pageUrl?: string | null;
    screenshotBuffer?: Buffer | null;
    networkLogs?: FeedbucketNetworkEntry[] | null;
  }): Promise<{ suggestedType: string; title: string; description: string }> {
    let imageDataUrls: string[] = [];
    if (opts.screenshotBuffer) {
      const mime = detectImageMime(opts.screenshotBuffer);
      if (mime) {
        imageDataUrls = [`data:${mime};base64,${opts.screenshotBuffer.toString("base64")}`];
      }
    }

    const analysis = await this.runVisionAnalysis({
      orgId: opts.orgId,
      userId: opts.actorUserId,
      feature: PUBLIC_FEATURE_KEY,
      type: opts.type,
      message: opts.message,
      pageUrl: opts.pageUrl,
      imageDataUrls,
      networkLogs: opts.networkLogs,
    });

    return {
      suggestedType: mapPublicType(analysis.type),
      title: analysis.title,
      description: buildPlaintextDescription(analysis),
    };
  }

  async analyze(u: CurrentUserContext, submissionId: number, force = false): Promise<FeedbackAnalysis & { aiUsage?: AiUsageMeta }> {
    requireFeature(u.plan, "ai.feedbucket");

    const submission = await this.loadSubmission(u.orgId, submissionId);
    this.assertProjectAccess(submission, u.orgId);

    if (submission.aiProcessedAt && !force) {
      const stored = submission.aiAnalysis;
      if (stored) return stored;
    }

    const rateLimitResult = await this.rateLimiter.check("feedbucket:ai-analyze", u.userId);
    if (!rateLimitResult.allowed) {
      throw new HttpException(
        `AI analysis rate limit reached. Retry after ${rateLimitResult.retryAfterSecs}s.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const images = await this.resolveScreenshotForVision(submission.screenshotUrl);

    const analysis = await this.runVisionAnalysis({
      orgId: u.orgId,
      userId: u.userId,
      feature: FEATURE_KEY,
      type: submission.type,
      message: submission.message,
      pageUrl: submission.pageUrl,
      imageDataUrls: images,
      networkLogs: submission.networkLogs,
      metadata: submission.metadata,
      consoleLogs: submission.consoleLogs,
    });

    await this.db
      .update(feedbucketSubmissions)
      .set({
        aiType: analysis.type,
        aiConfidence: analysis.confidence,
        aiAnalysis: analysis,
        aiModel: "standard",
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
      metadata: { type: analysis.type, confidence: analysis.confidence, model: "standard" },
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

    let analysis = submission.aiAnalysis;
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
