import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { ProjectsWebhooksService } from "./projects-webhooks.service";
import { ProjectsWebhooksDispatchService } from "./projects-webhooks-dispatch.service";
import { createWebhookSchema, type CreateWebhookInput } from "./dto/webhook.schemas";

@RequireModule("projects")
@Controller("projects")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsWebhooksController {
  constructor(
    private readonly webhooks: ProjectsWebhooksService,
    private readonly dispatch: ProjectsWebhooksDispatchService,
  ) {}

  @Get(":projectId/webhooks")
  @RequirePermission("projects:manage")
  listWebhooks(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.listWebhooks(u.orgId, projectId);
  }

  @Post(":projectId/webhooks")
  @RequirePermission("projects:manage")
  @HttpCode(201)
  createWebhook(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createWebhookSchema)) body: CreateWebhookInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.createWebhook(u.orgId, projectId, u.userId, body);
  }

  @Delete(":projectId/webhooks/:webhookId")
  @RequirePermission("projects:manage")
  @HttpCode(204)
  deleteWebhook(
    @Param("webhookId", ParseIntPipe) webhookId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.deleteWebhook(u.orgId, webhookId);
  }

  @Get(":projectId/webhooks/:webhookId/deliveries")
  @RequirePermission("projects:manage")
  listDeliveries(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("webhookId", ParseIntPipe) webhookId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.listDeliveries(u.orgId, projectId, webhookId);
  }

  @Post(":projectId/webhooks/:webhookId/test")
  @RequirePermission("projects:manage")
  @HttpCode(200)
  async sendTest(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("webhookId", ParseIntPipe) webhookId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.webhooks.assertWebhookOwnership(u.orgId, projectId, webhookId);
    return this.dispatch.sendTest(u.orgId, projectId, webhookId);
  }
}
