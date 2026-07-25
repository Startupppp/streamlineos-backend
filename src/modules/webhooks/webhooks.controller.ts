import {
  Body,
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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { WebhooksService } from "./webhooks.service";
import {
  createSchema,
  listSchema,
  updateSchema,
  type CreateInput,
  type ListInput,
  type UpdateInput,
} from "./dto/webhook.schemas";

@Controller("webhooks")
@UseGuards(JwtAuthGuard)
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:webhooks:manage")
  list(
    @Query(new ZodValidationPipe(listSchema)) filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.list(u.orgId, filters);
  }

  @Post()
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:webhooks:manage")
  create(
    @Body(new ZodValidationPipe(createSchema)) body: CreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.create(u.orgId, u.userId, body);
  }

  @Get(":webhookId")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:webhooks:manage")
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
  async update(
    @Param("webhookId", ParseIntPipe) webhookId: number,
    @Body(new ZodValidationPipe(updateSchema)) body: UpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.webhooks.update(u.orgId, webhookId, body);
    if (!updated) throw new NotFoundException("Webhook endpoint not found");
    return updated;
  }

  @Delete(":webhookId")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:webhooks:manage")
  async remove(
    @Param("webhookId", ParseIntPipe) webhookId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.webhooks.remove(u.orgId, webhookId);
    if (!result) throw new NotFoundException("Webhook endpoint not found");
    return result;
  }
}
