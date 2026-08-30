import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { ProjectsWebhooksService } from "./projects-webhooks.service";
import { ProjectsWebhooksDispatchService } from "./projects-webhooks-dispatch.service";
import { createWebhookSchema, type CreateWebhookInput } from "./dto/webhook.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();
const projectIdwebhookIdParams = z.object({ projectId: z.string().min(1), webhookId: z.coerce.number().int().positive() }).strict();
const projectIdwebhookIdParams_ = z.object({ projectId: z.coerce.number().int().positive(), webhookId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsWebhooksController {
  constructor(
    private readonly webhooks: ProjectsWebhooksService,
    private readonly dispatch: ProjectsWebhooksDispatchService,
  ) {}

  @Get(":projectId/webhooks")
  @RequirePermission("build:manage")
  @Validate({ params: projectIdParams })
  listWebhooks(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.listWebhooks(u.orgId, projectId);
  }

  @Post(":projectId/webhooks")
  @RequirePermission("build:manage")
  @HttpCode(201)
  @Idempotent("build.webhook.register")
  @Validate({ params: projectIdParams, body: createWebhookSchema })
  createWebhook(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateWebhookInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.createWebhook(u.orgId, projectId, u.userId, body);
  }

  @Delete(":projectId/webhooks/:webhookId")
  @RequirePermission("build:manage")
  @HttpCode(204)
  @Validate({ params: projectIdwebhookIdParams })
  deleteWebhook(
    @Param("webhookId", ParseIntPipe) webhookId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.deleteWebhook(u.orgId, webhookId);
  }

  @Get(":projectId/webhooks/:webhookId/deliveries")
  @RequirePermission("build:manage")
  @Validate({ params: projectIdwebhookIdParams_ })
  listDeliveries(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("webhookId", ParseIntPipe) webhookId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.listDeliveries(u.orgId, projectId, webhookId);
  }

  @Post(":projectId/webhooks/:webhookId/test")
  @RequirePermission("build:manage")
  @HttpCode(200)
  @Validate({ params: projectIdwebhookIdParams_ })
  async sendTest(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("webhookId", ParseIntPipe) webhookId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.webhooks.assertWebhookOwnership(u.orgId, projectId, webhookId);
    return this.dispatch.sendTest(u.orgId, projectId, webhookId);
  }
}
