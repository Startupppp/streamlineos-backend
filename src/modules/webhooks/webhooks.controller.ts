import {
  Body,
  Header,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { NO_COMPRESSION_HEADER } from "../../common/http/compression.config";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { WebhooksService } from "./webhooks.service";
import { WebhooksDispatchService } from "./webhooks-dispatch.service";
import {
  createSchema,
  listSchema,
  logsSchema,
  updateSchema,
  type CreateInput,
  type ListInput,
  type LogsInput,
  type UpdateInput,
} from "./dto/webhook.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";
import { z } from "zod";

const webhookIdParams = z.object({ webhookId: z.coerce.number().int().positive() }).strict();
const webhookIdlogIdParams = z.object({ webhookId: z.coerce.number().int().positive(), logId: z.coerce.number().int().positive() }).strict();

@Controller("webhooks")
@UseGuards(JwtAuthGuard)
export class WebhooksController {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly dispatch: WebhooksDispatchService,
  ) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:webhooks:manage")
  @Validate({ query: listSchema })
  list(
    @Query() filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.list(u.orgId, filters);
  }

  @Post()
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:webhooks:manage")
  @Validate({ body: createSchema })
  // PRD-C089 (BREACH) — this body carries a credential and `app.enableCors({ credentials:
  // true })` is live, so a compressed length is a cross-origin size oracle.
  @Header(NO_COMPRESSION_HEADER, "1")
  create(
    @Body() body: CreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.create(u.orgId, u.userId, body);
  }

  @Post(":webhookId/rotate-secret")
  @BodylessAction()
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:webhooks:manage")
  @Validate({ params: webhookIdParams })
  // PRD-C089 (BREACH) — this body carries a credential and `app.enableCors({ credentials:
  // true })` is live, so a compressed length is a cross-origin size oracle.
  @Header(NO_COMPRESSION_HEADER, "1")
  rotateSecret(
    @Param("webhookId", ParseIntPipe) webhookId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.rotateSecret(u.orgId, webhookId);
  }

  @Get(":webhookId")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:webhooks:manage")
  @Validate({ params: webhookIdParams })
  async get(
    @Param("webhookId", ParseIntPipe) webhookId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const endpoint = await this.webhooks.getEndpoint(u.orgId, webhookId);
    if (!endpoint) throw new NotFoundException("Webhook endpoint not found");
    return endpoint;
  }

  @Patch(":webhookId")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:webhooks:manage")
  @Validate({ params: webhookIdParams, body: updateSchema })
  async update(
    @Param("webhookId", ParseIntPipe) webhookId: number,
    @Body() body: UpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.webhooks.update(u.orgId, webhookId, body);
    if (!updated) throw new NotFoundException("Webhook endpoint not found");
    return updated;
  }

  @Delete(":webhookId")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:webhooks:manage")
  @Validate({ params: webhookIdParams })
  async remove(
    @Param("webhookId", ParseIntPipe) webhookId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.webhooks.remove(u.orgId, webhookId);
    if (!result) throw new NotFoundException("Webhook endpoint not found");
    return result;
  }

  @Get(":webhookId/logs")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:webhooks:manage")
  @Validate({ params: webhookIdParams, query: logsSchema })
  async listLogs(
    @Param("webhookId", ParseIntPipe) webhookId: number,
    @Query() filters: LogsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.webhooks.listLogs(u.orgId, webhookId, filters);
    if (!result) throw new NotFoundException("Webhook endpoint not found");
    return result;
  }

  @Post(":webhookId/logs/:logId/retry")
  @BodylessAction()
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:webhooks:manage")
  @Idempotent("webhook.delivery.retry")
  @Validate({ params: webhookIdlogIdParams })
  async retryLog(
    @Param("webhookId", ParseIntPipe) webhookId: number,
    @Param("logId", ParseIntPipe) logId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.dispatch.retryLog(u.orgId, webhookId, logId);
  }
}
