import {
  Body,
  Controller,
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
import { Public } from "../../common/auth/public.decorator";
import { MultipartAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { InsufficientAiCreditsException } from "../../common/http/api-exceptions";
import { FeedbucketPublicService } from "./feedbucket-public.service";
import { FeedbucketAiService } from "./feedbucket-ai.service";
import { StorageService } from "../storage/storage.service";
import { MediaTransformRunner } from "../storage/media-transform.runner";
import { NotificationsService } from "../notifications/notifications.service";
import { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import { ProjectsTicketsCreateService } from "../build/core/tickets/projects-tickets-create.service";
import { publicSubmitSchema, publicAiAssistSchema, publicSubmitDeclSchema, publicAiAssistDeclSchema } from "./feedbucket.schemas";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";
import { resolveClientIp } from "../../common/http/client-ip";
import {
  feedbucketPublicConfigSchema,
  feedbucketPublicSubmitSchema,
  feedbucketPublicAiAssistSchema,
} from "./dto/feedbucket-response.schemas";
import {
  MAX_RECORDING_BYTES,
  MAX_SCREENSHOT_BYTES,
  assertOriginAllowed,
  assertScreenshotAcceptable,
  normalizeMultipartBody,
} from "./lib/feedbucket-public-request";
import {
  submitPublicFeedback,
  type FeedbucketSubmitDeps,
} from "./lib/feedbucket-submit";

const publicKeyParams = z.object({ publicKey: z.string().min(1) }).strict();

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
    private readonly ticketsService: ProjectsTicketsCreateService,
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly transforms: MediaTransformRunner,
  ) {}

  private get submitDeps(): FeedbucketSubmitDeps {
    return {
      db: this.db,
      storage: this.storage,
      transforms: this.transforms,
      notifications: this.notifications,
      ticketsService: this.ticketsService,
      logger: this.logger,
      createSubmission: (widget, dto, screenshotUrl) =>
        this.publicService.createSubmission(widget, dto, screenshotUrl),
    };
  }

  @Get(":publicKey/config")
  @Validate({ params: publicKeyParams })
  @ResponseSchema(feedbucketPublicConfigSchema)
  async config(@Param("publicKey") publicKey: string, @Req() req: Request) {
    const widget = await this.publicService.resolveWidget(publicKey);
    if (!widget) throw new NotFoundException("Widget not found");

    const ip = resolveClientIp(req);
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
  @ResponseSchema(feedbucketPublicSubmitSchema)
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
    @Body() rawBody: z.infer<typeof publicSubmitDeclSchema>,
    @UploadedFiles()
    files: {
      screenshot?: Express.Multer.File[];
      recording?: Express.Multer.File[];
    },
    @Req() req: Request,
  ) {
    const widget = await this.publicService.resolveWidget(publicKey);
    if (!widget) throw new NotFoundException("Widget not found");

    assertOriginAllowed(widget, req);

    const ip = resolveClientIp(req);
    const rlResult = await this.rateLimitService.check(
      "feedbucket:widget-submit",
      `${widget.id}:${ip ?? "anon"}`,
    );
    if (!rlResult.allowed) {
      throw new HttpException({ message: "Rate limit exceeded" }, 429);
    }

    const dto = publicSubmitSchema.parse(normalizeMultipartBody(rawBody));

    return submitPublicFeedback(this.submitDeps, widget, dto, {
      screenshot: files?.screenshot?.[0],
      recording: files?.recording?.[0],
    });
  }

  @Post(":publicKey/ai-assist")
  @HttpCode(200)
  @ResponseSchema(feedbucketPublicAiAssistSchema)
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
    @Body() rawBody: z.infer<typeof publicAiAssistDeclSchema>,
    @UploadedFile() screenshot: Express.Multer.File | undefined,
    @Req() req: Request,
  ) {
    const widget = await this.publicService.resolveWidget(publicKey);
    if (!widget) throw new NotFoundException("Widget not found");

    if (!widget.aiAssistEnabled)
      throw new NotFoundException("Widget not found");

    assertOriginAllowed(widget, req);

    const ip = resolveClientIp(req);
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

    if (screenshot) assertScreenshotAcceptable(screenshot);

    const dto = publicAiAssistSchema.parse(normalizeMultipartBody(rawBody));

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
}
