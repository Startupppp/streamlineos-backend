import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Validate } from "../../common/validation/validate.decorator";
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
} from "./dto/e-sign.schemas";

const envelopeIdParams = z.object({ envelopeId: z.coerce.number().int().positive() }).strict();
const templateIdParams = z.object({ templateId: z.coerce.number().int().positive() }).strict();

@RequireModule("sign")
@Controller("sign")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SignTemplatesController {
  constructor(private readonly templates: SignTemplatesService) {}

  @Post("templates")
  @HttpCode(201)
  @RequirePermission("sign:template:manage")
  @Validate({ body: createTemplateSchema })
  create(@Body() body: CreateTemplateInput, @CurrentUser() u: CurrentUserContext) {
    return this.templates.create(u.orgId, u.userId, body);
  }

  @Post("envelopes/:envelopeId/save-as-template")
  @HttpCode(201)
  @RequirePermission("sign:template:manage")
  @Validate({ params: envelopeIdParams })
  createFromEnvelope(
    @Param("envelopeId", ParseIntPipe) envelopeId: number,
    @Body() body: unknown,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const parsed = z.object({ name: z.string().min(1).max(200) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid request: name is required");
    return this.templates.createFromEnvelope(u.orgId, u.userId, envelopeId, parsed.data.name);
  }

  @Get("templates")
  @RequirePermission("sign:template:manage")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.templates.list(u.orgId);
  }

  @Get("templates/:templateId")
  @RequirePermission("sign:template:manage")
  @Validate({ params: templateIdParams })
  get(@Param("templateId", ParseIntPipe) templateId: number, @CurrentUser() u: CurrentUserContext) {
    return this.templates.get(u.orgId, templateId);
  }

  @Patch("templates/:templateId")
  @RequirePermission("sign:template:manage")
  @Validate({ params: templateIdParams, body: updateTemplateSchema })
  update(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body() body: UpdateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.update(u.orgId, templateId, body, { orgId: u.orgId, userId: u.userId });
  }

  @Post("templates/:templateId/duplicate")
  @RequirePermission("sign:template:manage")
  @Validate({ params: templateIdParams })
  duplicate(@Param("templateId", ParseIntPipe) templateId: number, @CurrentUser() u: CurrentUserContext) {
    return this.templates.duplicate(u.orgId, templateId, { orgId: u.orgId, userId: u.userId });
  }

  @Post("templates/:templateId/create-envelope")
  @HttpCode(201)
  @RequirePermission("sign:envelope:create")
  @Validate({ params: templateIdParams, body: createEnvelopeFromTemplateSchema })
  createEnvelope(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body() body: CreateEnvelopeFromTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.instantiate(u.orgId, u.userId, templateId, body);
  }

  @Post("templates/:templateId/publish-public-form")
  @RequirePermission("sign:template:manage")
  @Validate({ params: templateIdParams, body: publishPublicFormSchema })
  publishPublicForm(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body() body: PublishPublicFormInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.publishPublicForm(u.orgId, u.userId, templateId, body);
  }
}
