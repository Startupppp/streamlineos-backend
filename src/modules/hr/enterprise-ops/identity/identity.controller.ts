import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { IdentityService } from "./identity.service";
import {
  createProvisioningSchema,
  updateProvisioningSchema,
  listProvisioningSchema,
  createTemplateSchema,
  updateTemplateSchema,
  generateProvisioningSchema,
  exitVerificationSchema,
  type CreateProvisioningInput,
  type UpdateProvisioningInput,
  type ListProvisioningInput,
  type CreateTemplateInput,
  type UpdateTemplateInput,
  type GenerateProvisioningInput,
} from "../dto/identity.schemas";
import { z } from "zod";
import { Validate } from "../../../../common/validation/validate.decorator";
import { ResponseSchema, NoContentResponse } from "../../../../common/openapi/zod-operation-contracts"
import { listProvisioningResponseSchema, createProvisioningResponseSchema, generateProvisioningResponseSchema, updateProvisioningResponseSchema, listTemplatesResponseSchema, createTemplateResponseSchema, updateTemplateResponseSchema, getExitVerificationResponseSchema } from "../dto/enterprise-ops-response.schemas"

const provisioningIdParams = z.object({ provisioningId: z.string().uuid() }).strict();
const templateIdParams = z.object({ templateId: z.string().uuid() }).strict();

@RequireModule("hr")
@Controller("hr/enterprise/ops/identity")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class IdentityController {
  constructor(private readonly svc: IdentityService) {}

  @ResponseSchema(listProvisioningResponseSchema)
  @Get("provisioning")
  @RequirePermission("hr:identity:view")
  @Validate({ query: listProvisioningSchema })
  listProvisioning(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: ListProvisioningInput,
  ) {
    return this.svc.listProvisioning(user.orgId, query);
  }

  @ResponseSchema(createProvisioningResponseSchema)
  @Post("provisioning")
  @HttpCode(201)
  @RequirePermission("hr:identity:manage")
  @Validate({ body: createProvisioningSchema })
  createProvisioning(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: CreateProvisioningInput,
  ) {
    return this.svc.createProvisioning(user.orgId, body);
  }

  @ResponseSchema(generateProvisioningResponseSchema)
  @Post("provisioning/generate")
  @HttpCode(201)
  @RequirePermission("hr:identity:manage")
  @Validate({ body: generateProvisioningSchema })
  generateProvisioning(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: GenerateProvisioningInput,
  ) {
    return this.svc.generateProvisioning(user.orgId, body);
  }

  @ResponseSchema(updateProvisioningResponseSchema)
  @Patch("provisioning/:provisioningId")
  @RequirePermission("hr:identity:manage")
  @Validate({ params: provisioningIdParams, body: updateProvisioningSchema })
  updateProvisioning(
    @CurrentUser() user: CurrentUserContext,
    @Param("provisioningId") provisioningId: string,
    @Body() body: UpdateProvisioningInput,
  ) {
    return this.svc.updateProvisioning(user.orgId, provisioningId, body);
  }

  @ResponseSchema(listTemplatesResponseSchema)
  @Get("templates")
  @RequirePermission("hr:identity:view")
  listTemplates(@CurrentUser() user: CurrentUserContext) {
    return this.svc.listTemplates(user.orgId);
  }

  @ResponseSchema(createTemplateResponseSchema)
  @Post("templates")
  @HttpCode(201)
  @RequirePermission("hr:identity:manage")
  @Validate({ body: createTemplateSchema })
  createTemplate(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: CreateTemplateInput,
  ) {
    return this.svc.createTemplate(user.orgId, body);
  }

  @ResponseSchema(updateTemplateResponseSchema)
  @Patch("templates/:templateId")
  @RequirePermission("hr:identity:manage")
  @Validate({ params: templateIdParams, body: updateTemplateSchema })
  updateTemplate(
    @CurrentUser() user: CurrentUserContext,
    @Param("templateId") templateId: string,
    @Body() body: UpdateTemplateInput,
  ) {
    return this.svc.updateTemplate(user.orgId, templateId, body);
  }

  @NoContentResponse()
  @Delete("templates/:templateId")
  @HttpCode(204)
  @RequirePermission("hr:identity:manage")
  @Validate({ params: templateIdParams })
  async deleteTemplate(
    @CurrentUser() user: CurrentUserContext,
    @Param("templateId") templateId: string,
  ) {
    await this.svc.deleteTemplate(user.orgId, templateId);
  }

  @ResponseSchema(getExitVerificationResponseSchema)
  @Get("exit-verification")
  @RequirePermission("hr:identity:view")
  @Validate({ query: exitVerificationSchema })
  exitVerification(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: z.infer<typeof exitVerificationSchema>,
  ) {
    return this.svc.getExitVerification(user.orgId, query.userId);
  }
}
