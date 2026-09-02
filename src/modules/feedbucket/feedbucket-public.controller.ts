import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from "@nestjs/common";
import {
  FileFieldsInterceptor,
  FileInterceptor,
} from "@nestjs/platform-express";
import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import { Public } from "../../common/auth/public.decorator";
import { MultipartAction } from "../../common/openapi/zod-operation-contracts";
import { InsufficientAiCreditsException } from "../../common/http/api-exceptions";
import { FeedbucketPublicService } from "./feedbucket-public.service";
import { FeedbucketAiService } from "./feedbucket-ai.service";
import { StorageService } from "../storage/storage.service";
import { MediaTransformRunner } from "../storage/media-transform.runner";
import {
  assertUploadableScreenshot,
  planMedia,
  queueMediaTransforms,
  type PendingMediaTransform,
  type PlannedMedia,
} from "./feedbucket-media-transforms";
import { NotificationsService } from "../notifications/notifications.service";
import { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import { ProjectsTicketsService } from "../build/core/projects-tickets.service";
import { validateMagicBytes } from "../storage/file-signatures";
import { publicSubmitSchema, publicAiAssistSchema, publicSubmitDeclSchema, publicAiAssistDeclSchema } from "./feedbucket.schemas";
import {
  feedbucketAttachments,
  feedbucketSubmissions,
  feedbucketWidgets,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { runInTenantTransaction, runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { registerAfterCommit } from "../../common/tenant/tenant-context";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const publicKeyParams = z.object({ publicKey: z.string().min(1) }).strict();


const ALLOWED_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MAX_RECORDING_BYTES = 100 * 1024 * 1024;

function projectFolder(widget: typeof feedbucketWidgets.$inferSelect): string {
  return widget.projectId
    ? `project-${widget.projectId}`
    : `org-${widget.orgId}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clientIp(req: Request): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const candidate = raw?.split(",")[0]?.trim() || req.ip;
  return candidate ? candidate.slice(0, 100) : undefined;
}

function originHostname(req: Request): string | undefined {
  const originHeader = req.headers["origin"];
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  const refererHeader = req.headers["referer"];
  const referer = Array.isArray(refererHeader)
    ? refererHeader[0]
    : refererHeader;
  const src = origin ?? referer;
  if (!src) return undefined;
  try {
    return new URL(src).hostname;
  } catch {
    return undefined;
  }
}

function parseMultipartField(raw: unknown, fieldName: string): unknown {
  if (
    fieldName === "consoleLogs" ||
    fieldName === "metadata" ||
    fieldName === "networkLogs"
  ) {
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
  }
  return raw;
}

@Public()
@Controller("public/feedbucket")
export class FeedbucketPublicController {
  private readonly logger = new Logger(FeedbucketPublicController.name);
  constructor(
    private readonly publicService: FeedbucketPublicService,
    private readonly aiService: FeedbucketAiService,
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
    private readonly rateLimitService: RateLimitService,
    private readonly ticketsService: ProjectsTicketsService,
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly transforms: MediaTransformRunner,
  ) {}

  @Get(":publicKey/config")
  @Validate({ params: publicKeyParams })
  async config(@Param("publicKey") publicKey: string, @Req() req: Request) {
    const widget = await this.publicService.resolveWidget(publicKey);
    if (!widget) throw new NotFoundException("Widget not found");

    const ip = clientIp(req);
    const rlResult = await this.rateLimitService.check(
      "feedbucket:widget-config",
      `${widget.id}:${ip ?? "anon"}`,
    );
    if (!rlResult.allowed) {
      throw new HttpException(
        { message: "Rate limit exceeded" },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return {
      name: widget.name,
      theme: widget.theme,
      defaultTicketType: widget.defaultTicketType,
      aiAssistEnabled: widget.aiAssistEnabled,
    };
  }

  @Post(":publicKey")
  @HttpCode(200)
  @MultipartAction({
    file: "screenshot",
    fileRequired: false,
    additionalFiles: ["recording"],
    fields: { type: "string", message: "string", pageUrl: "string", reporterName: "string", reporterEmail: "string", metadata: "string", consoleLogs: "string", networkLogs: "string" },
  })
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: "screenshot", maxCount: 1 },
        { name: "recording", maxCount: 1 },
      ],
      { limits: { fileSize: MAX_RECORDING_BYTES } },
    ),
  )
  @Validate({ params: publicKeyParams, body: publicSubmitDeclSchema })
  async submit(
    @Param("publicKey") publicKey: string,
    @Body() rawBody: Record<string, unknown>,
    @UploadedFiles()
    files: {
      screenshot?: Express.Multer.File[];
      recording?: Express.Multer.File[];
    },
    @Req() req: Request,
  ) {
    const widget = await this.publicService.resolveWidget(publicKey);
    if (!widget) throw new NotFoundException("Widget not found");

    const host = originHostname(req);
    if (
      widget.allowedDomains.length > 0 &&
      host !== undefined &&
      !widget.allowedDomains.includes(host)
    ) {
      throw new ForbiddenException("Origin not allowed");
    }

    const ip = clientIp(req);
    const rlResult = await this.rateLimitService.check(
      "feedbucket:widget-submit",
      `${widget.id}:${ip ?? "anon"}`,
    );
    if (!rlResult.allowed) {
      throw new HttpException({ message: "Rate limit exceeded" }, 429);
    }

    const normalizedBody: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(rawBody)) {
      normalizedBody[key] = parseMultipartField(val, key);
    }
    const dto = publicSubmitSchema.parse(normalizedBody);

    const folder = projectFolder(widget);
    const screenshot = files?.screenshot?.[0];
    const recording = files?.recording?.[0];

    if ((screenshot || recording) && !this.transforms.hasCapacity())
      throw new HttpException({ message: "Media processing is saturated — retry shortly" }, 503);

    const pendingTransforms: PendingMediaTransform[] = [];

    let screenshotUpload: PlannedMedia | undefined;
    if (screenshot) {
      assertUploadableScreenshot(screenshot, MAX_SCREENSHOT_BYTES);
      screenshotUpload = await planMedia(
        this.storage,
        widget.orgId,
        `feedbucket/${folder}/screenshots`,
        { buffer: screenshot.buffer, fileName: screenshot.originalname, mimeType: screenshot.mimetype },
        pendingTransforms,
      );
    }

    let recordingUpload: PlannedMedia | undefined;
    if (recording) {
      if (recording.size > MAX_RECORDING_BYTES)
        throw new BadRequestException("Recording must be under 100MB");

      const rawMime = recording.mimetype.split(";")[0]?.trim() ?? "";
      recordingUpload = await planMedia(
        this.storage,
        widget.orgId,
        `feedbucket/${folder}/recordings`,
        {
          buffer: recording.buffer,
          fileName: recording.originalname || "recording.webm",
          mimeType: rawMime.startsWith("video/") ? rawMime : "video/webm",
        },
        pendingTransforms,
      );
    }

    const screenshotUrl = screenshotUpload?.key;
    const recordingUrl = recordingUpload?.key;

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        const submissionId = await this.publicService.createSubmission(
          widget,
          dto,
          screenshotUrl,
        );

        if (screenshot && screenshotUpload)
          await tx.insert(feedbucketAttachments).values({
            submissionId,
            orgId: widget.orgId,
            fileUrl: screenshotUpload.key,
            fileSize: screenshotUpload.size,
            fileName: screenshot.originalname,
            mimeType: screenshotUpload.mimeType,
          });

        if (recording && recordingUpload)
          await tx.insert(feedbucketAttachments).values({
            orgId: widget.orgId,
            submissionId,
            fileUrl: recordingUpload.key,
            mimeType: recordingUpload.mimeType,
            fileName: recording.originalname,
            fileSize: recordingUpload.size,
          });

        await queueMediaTransforms(this.storage, this.transforms, widget.orgId, pendingTransforms);

        if (widget.autoCreateTicket && widget.projectId) {
          const deferred = () =>
            this.autoLinkTicket(widget, submissionId, dto.type, dto.message, {
              screenshot,
              screenshotUrl,
              recordingUrl,
            });
          if (!registerAfterCommit(deferred)) void deferred();
        }

        if (widget.createdBy) {
          void this.notifications
            .create({
              orgId: widget.orgId,
              userId: widget.createdBy,
              type: "INFO",
              category: "SYSTEM",
              sourceModule: "feedbucket",
              title: "New Feedback Received",
              message: `New ${dto.type} feedback received via widget "${widget.name}"`,
              link: widget.projectId
                ? `/projects/${widget.projectId}/feedbucket/${submissionId}`
                : `/projects/feedbucket`,
            })
            .catch(() => undefined);
        }
      },
      { orgId: widget.orgId },
    );

    return { ok: true };
  }

  @Post(":publicKey/ai-assist")
  @HttpCode(200)
  @MultipartAction({
    file: "screenshot",
    fileRequired: false,
    fields: { type: "string", message: "string", pageUrl: "string", networkLogs: "string" },
  })
  @UseInterceptors(
    FileInterceptor("screenshot", {
      limits: { fileSize: MAX_SCREENSHOT_BYTES },
    }),
  )
  @Validate({ params: publicKeyParams, body: publicAiAssistDeclSchema })
  async aiAssist(
    @Param("publicKey") publicKey: string,
    @Body() rawBody: Record<string, unknown>,
    @UploadedFile() screenshot: Express.Multer.File | undefined,
    @Req() req: Request,
  ) {
    const widget = await this.publicService.resolveWidget(publicKey);
    if (!widget) throw new NotFoundException("Widget not found");

    if (!widget.aiAssistEnabled)
      throw new NotFoundException("Widget not found");

    const host = originHostname(req);
    if (
      widget.allowedDomains.length > 0 &&
      host !== undefined &&
      !widget.allowedDomains.includes(host)
    )
      throw new ForbiddenException("Origin not allowed");

    const ip = clientIp(req);
    const perIpResult = await this.rateLimitService.check(
      "feedbucket:ai-assist",
      `${widget.id}:${ip ?? "anon"}`,
    );
    if (!perIpResult.allowed) {
      throw new HttpException(
        { message: "Rate limit exceeded" },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const dailyResult = await this.rateLimitService.check(
      "feedbucket:ai-assist-daily",
      String(widget.id),
    );
    if (!dailyResult.allowed)
      throw new HttpException(
        { message: "Widget daily AI limit reached" },
        HttpStatus.TOO_MANY_REQUESTS,
      );

    if (screenshot) {
      if (screenshot.size > MAX_SCREENSHOT_BYTES)
        throw new BadRequestException("Screenshot must be under 5MB");

      if (!ALLOWED_IMAGE_MIMES.has(screenshot.mimetype))
        throw new BadRequestException(
          "Screenshot must be an image (JPEG, PNG, GIF, or WebP)",
        );

      if (!validateMagicBytes(screenshot.buffer, screenshot.mimetype))
        throw new BadRequestException(
          "Screenshot file content does not match its type",
        );
    }

    const normalizedAiBody: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(rawBody)) {
      normalizedAiBody[key] = parseMultipartField(val, key);
    }
    const dto = publicAiAssistSchema.parse(normalizedAiBody);

    const actorUserId = widget.createdBy ?? "system";

    let result: { suggestedType: string; title: string; description: string };
    try {
      result = await runInTenantTransaction(
        this.db,
        () =>
          this.aiService.analyzePublic({
            orgId: widget.orgId,
            actorUserId,
            widgetId: widget.id,
            type: dto.type ?? "other",
            message: dto.message ?? "",
            pageUrl: dto.pageUrl,
            screenshotBuffer: screenshot?.buffer ?? null,
            networkLogs: dto.networkLogs,
          }),
        { orgId: widget.orgId },
      );
    } catch (err) {
      if (
        err instanceof HttpException &&
        err.getStatus() === HttpStatus.SERVICE_UNAVAILABLE
      ) {
        throw new HttpException(
          {
            message:
              "AI service is temporarily unavailable. Please try again later.",
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      if (err instanceof InsufficientAiCreditsException) {
        throw new InsufficientAiCreditsException({
          message: "Insufficient AI credits for this widget.",
        });
      }
      throw err;
    }

    return result;
  }

  private async autoLinkTicket(
    widget: typeof feedbucketWidgets.$inferSelect,
    submissionId: number,
    type: string,
    message: string,
    media: {
      screenshot?: Express.Multer.File;
      screenshotUrl?: string;
      recordingUrl?: string;
    },
  ) {
    const projectId = widget.projectId;
    if (!projectId) return;
    try {
      await runInNewTenantTransaction(this.db, widget.orgId, async () => {
        const actingUserId = widget.createdBy ?? widget.orgId;
        const parts: string[] = [
          `<p><strong>Feedback type:</strong> ${escapeHtml(type)}</p>`,
        ];
        if (message.trim())
          parts.push(`<p>${escapeHtml(message).replace(/\n/g, "<br>")}</p>`);
        if (media.screenshotUrl)
          parts.push(
            `<p><img src="${escapeHtml(media.screenshotUrl)}" alt="Feedback screenshot"></p>`,
          );
        if (media.recordingUrl)
          parts.push(
            `<p><strong>Screen recording:</strong> <a href="${escapeHtml(media.recordingUrl)}" target="_blank" rel="noopener noreferrer">Watch recording</a></p>`,
          );
        const ticket = await this.ticketsService.createFromFeedback(
          widget.orgId,
          actingUserId,
          projectId,
          {
            title: message.slice(0, 255) || `${type} feedback`,
            description: parts.join(""),
            type: widget.defaultTicketType,
          },
        );
        await this.db
          .update(feedbucketSubmissions)
          .set({ linkedTicketId: ticket.id })
          .where(
            and(
              eq(feedbucketSubmissions.id, submissionId),
              eq(feedbucketSubmissions.orgId, widget.orgId),
            ),
          );
      });
    } catch (err) {
      this.logger.warn(`linkFeedbackToTicket failed for submission ${submissionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
