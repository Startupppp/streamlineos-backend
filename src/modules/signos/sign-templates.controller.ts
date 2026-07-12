import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { SignTemplatesService } from "./sign-templates.service";
import {
  createTemplateSchema,
  updateTemplateSchema,
  createEnvelopeFromTemplateSchema,
  publishPublicFormSchema,
  type CreateTemplateInput,
  type UpdateTemplateInput,
  type CreateEnvelopeFromTemplateInput,
  type PublishPublicFormInput,
} from "./dto/signos.schemas";

@RequireModule("sign")
@Controller("sign")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SignTemplatesController {
  constructor(private readonly templates: SignTemplatesService) {}

  @Post("templates")
  @RequirePermission("sign:template:manage")
  create(@Body(new ZodValidationPipe(createTemplateSchema)) body: CreateTemplateInput, @CurrentUser() u: CurrentUserContext) {
    return this.templates.create(u.orgId, u.userId, body);
  }

  @Post("envelopes/:envelopeId/save-as-template")
  @RequirePermission("sign:template:manage")
  createFromEnvelope(
    @Param("envelopeId", ParseIntPipe) envelopeId: number,
    @Body("name") name: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.createFromEnvelope(u.orgId, u.userId, envelopeId, name);
  }

  @Get("templates")
  @RequirePermission("sign:template:manage")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.templates.list(u.orgId);
  }

  @Get("templates/:id")
  @RequirePermission("sign:template:manage")
  get(@Param("id", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext) {
    return this.templates.get(u.orgId, id);
  }

  @Patch("templates/:id")
  @RequirePermission("sign:template:manage")
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateTemplateSchema)) body: UpdateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.update(u.orgId, id, body, { orgId: u.orgId, userId: u.userId });
  }

  @Post("templates/:id/duplicate")
  @RequirePermission("sign:template:manage")
  duplicate(@Param("id", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext) {
    return this.templates.duplicate(u.orgId, id, { orgId: u.orgId, userId: u.userId });
  }

  @Post("templates/:id/create-envelope")
  @RequirePermission("sign:envelope:create")
  createEnvelope(
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(createEnvelopeFromTemplateSchema)) body: CreateEnvelopeFromTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.instantiate(u.orgId, u.userId, id, body);
  }

  @Post("templates/:id/publish-public-form")
  @RequirePermission("sign:template:manage")
  publishPublicForm(
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(publishPublicFormSchema)) body: PublishPublicFormInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.publishPublicForm(u.orgId, u.userId, id, body);
  }
}
