import {
  Controller, Get, Post, Patch, Delete, Param, Body, Query,
  ParseIntPipe, UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { WebhooksService } from "./webhooks.service";
import {
  createWebhookSchema,
  updateWebhookSchema,
  listEventsQuerySchema,
  type CreateWebhookInput,
  type UpdateWebhookInput,
  type ListEventsQueryInput,
} from "./dto/webhooks.schemas";

@RequireModule("inventory")
@Controller("inventory/webhooks")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class WebhooksController {
  constructor(private readonly svc: WebhooksService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:webhooks:manage")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.svc.list(u.orgId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:webhooks:manage")
  create(
    @Body(new ZodValidationPipe(createWebhookSchema)) body: CreateWebhookInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.create(u.orgId, u.userId, body);
  }

  @Patch(":webhookId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:webhooks:manage")
  update(
    @Param("webhookId", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateWebhookSchema)) body: UpdateWebhookInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.update(u.orgId, u.userId, id, body);
  }

  @Delete(":webhookId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:webhooks:manage")
  remove(
    @Param("webhookId", ParseIntPipe) id: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.remove(u.orgId, u.userId, id);
  }

  @Get(":webhookId/events")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:webhooks:manage")
  listEvents(
    @Param("webhookId", ParseIntPipe) id: number,
    @Query(new ZodValidationPipe(listEventsQuerySchema)) q: ListEventsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listEvents(u.orgId, id, q);
  }

  @Post("events/:eventId/retry")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:webhooks:manage")
  retryEvent(
    @Param("eventId", ParseIntPipe) id: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.retryEvent(u.orgId, u.userId, id);
  }
}
