import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { ProjectsWebhooksService } from "./projects-webhooks.service";
import { ProjectsWebhooksDispatchService } from "./projects-webhooks-dispatch.service";
import {
  createWebhookSchema,
  listWebhooksQuerySchema,
  updateWebhookSchema,
  type CreateWebhookInput,
  type ListWebhooksQuery,
  type UpdateWebhookInput,
} from "./dto/webhook.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  projectWebhookSchema,
  projectWebhookPageSchema,
  webhookDeliverySchema,
  webhookTestResultSchema,
} from "./dto/build-core-response.schemas";

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();
const projectIdwebhookIdParams = z.object({ projectId: z.coerce.number().int().positive(), webhookId: z.coerce.number().int().positive() }).strict();

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
  @ResponseSchema(projectWebhookPageSchema)
  @Validate({ params: projectIdParams, query: listWebhooksQuerySchema })
  listWebhooks(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: ListWebhooksQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.listWebhooks(u.orgId, projectId, query);
  }

  @Post(":projectId/webhooks")
  @RequirePermission("build:manage")
  @HttpCode(201)
  @Idempotent("build.webhook.register")
  @ResponseSchema(projectWebhookSchema)
  @Validate({ params: projectIdParams, body: createWebhookSchema })
  createWebhook(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateWebhookInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.createWebhook(u.orgId, projectId, u.userId, body);
  }

  @Patch(":projectId/webhooks/:webhookId")
  @RequirePermission("build:manage")
  @ResponseSchema(projectWebhookSchema)
  @Validate({ params: projectIdwebhookIdParams, body: updateWebhookSchema })
  updateWebhook(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("webhookId", ParseIntPipe) webhookId: number,
    @Body() body: UpdateWebhookInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.updateWebhook(u.orgId, projectId, webhookId, body);
  }

  @Delete(":projectId/webhooks/:webhookId")
  @RequirePermission("build:manage")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectIdwebhookIdParams })
  deleteWebhook(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("webhookId", ParseIntPipe) webhookId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.deleteWebhook(u.orgId, projectId, webhookId);
  }

  @Get(":projectId/webhooks/:webhookId/deliveries")
  @RequirePermission("build:manage")
  @ResponseSchema(z.array(webhookDeliverySchema))
  @Validate({ params: projectIdwebhookIdParams })
  listDeliveries(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("webhookId", ParseIntPipe) webhookId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.listDeliveries(u.orgId, projectId, webhookId);
  }

  @Post(":projectId/webhooks/:webhookId/test")
  @BodylessAction()
  @RequirePermission("build:manage")
  @HttpCode(200)
  @ResponseSchema(webhookTestResultSchema)
  @Validate({ params: projectIdwebhookIdParams })
  async sendTest(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("webhookId", ParseIntPipe) webhookId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.webhooks.assertWebhookOwnership(u.orgId, projectId, webhookId);
    return this.dispatch.sendTest(u.orgId, projectId, webhookId);
  }
}
