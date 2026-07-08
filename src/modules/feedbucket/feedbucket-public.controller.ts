import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpException,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import { Public } from "../../common/auth/public.decorator";
import { FeedbucketPublicService } from "./feedbucket-public.service";
import { StorageService } from "../storage/storage.service";
import { NotificationsService } from "../notifications/notifications.service";
import { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import { ProjectsTicketsService } from "../projects/projects-tickets.service";
import { validateMagicBytes } from "../storage/file-signatures";
import { publicSubmitSchema } from "./feedbucket.schemas";
import { feedbucketAttachments, feedbucketSubmissions, feedbucketWidgets } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";

const ALLOWED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

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
  const referer = Array.isArray(refererHeader) ? refererHeader[0] : refererHeader;
  const src = origin ?? referer;
  if (!src) return undefined;
  try {
    return new URL(src).hostname;
  } catch {
    return undefined;
  }
}

function parseMultipartField(raw: unknown, fieldName: string): unknown {
  if (fieldName === "consoleLogs" || fieldName === "metadata") {
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
  constructor(
    private readonly publicService: FeedbucketPublicService,
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
    private readonly rateLimitService: RateLimitService,
    private readonly ticketsService: ProjectsTicketsService,
    @Inject(DRIZZLE) private readonly db: Db,
  ) {}

  @Post(":publicKey")
  @HttpCode(200)
  @UseInterceptors(FileInterceptor("screenshot"))
  async submit(
    @Param("publicKey") publicKey: string,
    @Body() rawBody: Record<string, unknown>,
    @UploadedFile() screenshot: Express.Multer.File | undefined,
    @Req() req: Request,
  ) {
    const widget = await this.publicService.resolveWidget(publicKey);
    if (!widget) throw new NotFoundException("Widget not found");

    const host = originHostname(req);
    if (widget.allowedDomains.length > 0 && host !== undefined && !widget.allowedDomains.includes(host)) {
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

    let screenshotUrl: string | undefined;
    if (screenshot) {
      if (screenshot.size > MAX_SCREENSHOT_BYTES) {
        throw new BadRequestException("Screenshot must be under 5MB");
      }
      const mime = screenshot.mimetype;
      if (!ALLOWED_IMAGE_MIMES.has(mime)) {
        throw new BadRequestException("Screenshot must be an image (JPEG, PNG, GIF, or WebP)");
      }
      if (!validateMagicBytes(screenshot.buffer, mime)) {
        throw new BadRequestException("Screenshot file content does not match its type");
      }
      const result = await this.storage.uploadFile(
        screenshot.buffer,
        "feedbucket/screenshots",
        screenshot.originalname,
        mime,
      );
      screenshotUrl = result.url;
    }

    const submissionId = await this.publicService.createSubmission(widget, dto, screenshotUrl);

    if (widget.autoCreateTicket && widget.projectId) {
      void this.autoLinkTicket(widget, submissionId, dto.type, dto.message, screenshot, screenshotUrl);
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
          link: `/feedbucket/submissions`,
        })
        .catch(() => undefined);
    }

    return { ok: true };
  }

  private async autoLinkTicket(
    widget: typeof feedbucketWidgets.$inferSelect,
    submissionId: number,
    type: string,
    message: string,
    screenshot: Express.Multer.File | undefined,
    screenshotUrl: string | undefined,
  ) {
    if (!widget.projectId) return;
    try {
      const actingUserId = widget.createdBy ?? widget.orgId;
      const ticket = await this.ticketsService.createFromFeedback(
        widget.orgId,
        actingUserId,
        widget.projectId,
        {
          title: message.slice(0, 255),
          description: `**Feedback type:** ${type}\n\n${message}`,
          type: widget.defaultTicketType,
        },
      );
      await this.db
        .update(feedbucketSubmissions)
        .set({ linkedTicketId: ticket.id })
        .where(and(eq(feedbucketSubmissions.id, submissionId), eq(feedbucketSubmissions.orgId, widget.orgId)));

      if (screenshotUrl && screenshot) {
        await this.db.insert(feedbucketAttachments).values({
          orgId: widget.orgId,
          submissionId,
          fileUrl: screenshotUrl,
          mimeType: screenshot.mimetype,
          fileName: screenshot.originalname,
          fileSize: screenshot.size,
        });
      }
    } catch {}
  }
}
