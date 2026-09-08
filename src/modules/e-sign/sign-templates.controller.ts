import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { actingMembershipId } from "../../common/auth/principal";
import { Validate } from "../../common/validation/validate.decorator";
import { SignTemplatesService } from "./sign-templates.service";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  templateMutationResponseSchema,
  listTemplatesResponseSchema,
  instantiateTemplateResponseSchema,
  publishPublicFormResponseSchema,
} from "./dto/e-sign-response.schemas";
import {
  createTemplateSchema,
  updateTemplateSchema,
  saveAsTemplateSchema,
  createEnvelopeFromTemplateSchema,
  type CreateTemplateInput,
  type UpdateTemplateInput,
  type SaveAsTemplateInput,
  type CreateEnvelopeFromTemplateInput,
} from "./dto/e-sign.schemas";
import {
  publishPublicFormSchema,
  type PublishPublicFormInput,
} from "./dto/e-sign-public.schemas";

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
  @ResponseSchema(templateMutationResponseSchema)
  @Validate({ body: createTemplateSchema })
  create(@Body() body: CreateTemplateInput, @CurrentUser() u: CurrentUserContext) {
    return this.templates.create(u.orgId, actingMembershipId(u.principal), body);
  }

  @Post("envelopes/:envelopeId/save-as-template")
  @HttpCode(201)
  @RequirePermission("sign:template:manage")
  @ResponseSchema(templateMutationResponseSchema)
  @Validate({ params: envelopeIdParams, body: saveAsTemplateSchema })
  createFromEnvelope(
    @Param("envelopeId", ParseIntPipe) envelopeId: number,
    @Body() body: SaveAsTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.createFromEnvelope(u.orgId, actingMembershipId(u.principal), envelopeId, body.name);
  }

  @Get("templates")
  @RequirePermission("sign:template:manage")
  @ResponseSchema(listTemplatesResponseSchema)
  list(@CurrentUser() u: CurrentUserContext) {
    return this.templates.list(u.orgId);
  }

  @Get("templates/:templateId")
  @RequirePermission("sign:template:manage")
  @ResponseSchema(templateMutationResponseSchema)
  @Validate({ params: templateIdParams })
  get(@Param("templateId", ParseIntPipe) templateId: number, @CurrentUser() u: CurrentUserContext) {
    return this.templates.get(u.orgId, templateId);
  }

  @Patch("templates/:templateId")
  @RequirePermission("sign:template:manage")
  @ResponseSchema(templateMutationResponseSchema)
  @Validate({ params: templateIdParams, body: updateTemplateSchema })
  update(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body() body: UpdateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.update(u.orgId, templateId, body, { orgId: u.orgId, userId: u.userId });
  }

  @Post("templates/:templateId/duplicate")
  @BodylessAction()
  @RequirePermission("sign:template:manage")
  @ResponseSchema(templateMutationResponseSchema)
  @Validate({ params: templateIdParams })
  duplicate(@Param("templateId", ParseIntPipe) templateId: number, @CurrentUser() u: CurrentUserContext) {
    return this.templates.duplicate(u.orgId, templateId, { orgId: u.orgId, userId: u.userId, membershipId: actingMembershipId(u.principal) });
  }

  @Post("templates/:templateId/create-envelope")
  @HttpCode(201)
  @RequirePermission("sign:envelope:create")
  @ResponseSchema(instantiateTemplateResponseSchema)
  @Validate({ params: templateIdParams, body: createEnvelopeFromTemplateSchema })
  createEnvelope(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body() body: CreateEnvelopeFromTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.instantiate(u.orgId, actingMembershipId(u.principal), templateId, body);
  }

  @Post("templates/:templateId/publish-public-form")
  @RequirePermission("sign:template:manage")
  @ResponseSchema(publishPublicFormResponseSchema)
  @Validate({ params: templateIdParams, body: publishPublicFormSchema })
  publishPublicForm(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body() body: PublishPublicFormInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.publishPublicForm(u.orgId, actingMembershipId(u.principal), templateId, body);
  }
}
