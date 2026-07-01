import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { ProjectsWebhooksService } from "./projects-webhooks.service";
import { createWebhookSchema, type CreateWebhookInput } from "./dto/webhook.schemas";

@RequireModule("projects")
@Controller("projects")
@UseGuards(JwtAuthGuard)
export class ProjectsWebhooksController {
  constructor(private readonly webhooks: ProjectsWebhooksService) {}

  @Get(":projectId/webhooks")
  listWebhooks(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.listWebhooks(u.orgId, projectId);
  }

  @Post(":projectId/webhooks")
  @HttpCode(201)
  createWebhook(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createWebhookSchema)) body: CreateWebhookInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.createWebhook(u.orgId, projectId, u.userId, body);
  }

  @Delete(":projectId/webhooks/:webhookId")
  @HttpCode(204)
  deleteWebhook(
    @Param("webhookId", ParseIntPipe) webhookId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.deleteWebhook(u.orgId, webhookId);
  }

  @Get(":projectId/webhooks/:webhookId/deliveries")
  listDeliveries(@Param("webhookId", ParseIntPipe) webhookId: number) {
    return this.webhooks.listDeliveries(webhookId);
  }
}
