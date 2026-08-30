import {
  Controller, Get, Post, Patch, Delete, Param, Body, Query,
  ParseIntPipe, UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
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
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const webhookIdParams = z.object({ webhookId: z.coerce.number().int().positive() }).strict();
const eventIdParams = z.object({ eventId: z.coerce.number().int().positive() }).strict();

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
  @Validate({ body: createWebhookSchema })
  create(
    @Body() body: CreateWebhookInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.create(u.orgId, u.userId, body);
  }

  @Patch(":webhookId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:webhooks:manage")
  @Validate({ params: webhookIdParams, body: updateWebhookSchema })
  update(
    @Param("webhookId", ParseIntPipe) id: number,
    @Body() body: UpdateWebhookInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.update(u.orgId, u.userId, id, body);
  }

  @Delete(":webhookId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:webhooks:manage")
  @Validate({ params: webhookIdParams })
  remove(
    @Param("webhookId", ParseIntPipe) id: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.remove(u.orgId, u.userId, id);
  }

  @Get(":webhookId/events")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:webhooks:manage")
  @Validate({ params: webhookIdParams, query: listEventsQuerySchema })
  listEvents(
    @Param("webhookId", ParseIntPipe) id: number,
    @Query() q: ListEventsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listEvents(u.orgId, id, q);
  }

  @Post("events/:eventId/retry")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:webhooks:manage")
  @Validate({ params: eventIdParams })
  retryEvent(
    @Param("eventId", ParseIntPipe) id: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.retryEvent(u.orgId, u.userId, id);
  }
}
