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
import { ZodValidationPipe } from "../../../../common/pipes/zod-validation.pipe";
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

const provisioningIdParams = z.object({ provisioningId: z.string().min(1) }).strict();
const templateIdParams = z.object({ templateId: z.string().min(1) }).strict();

@RequireModule("hr")
@Controller("hr/enterprise/ops/identity")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class IdentityController {
  constructor(private readonly svc: IdentityService) {}

  @Get("provisioning")
  @RequirePermission("hr:identity:view")
  listProvisioning(
    @CurrentUser() user: CurrentUserContext,
    @Query(new ZodValidationPipe(listProvisioningSchema)) query: ListProvisioningInput,
  ) {
    return this.svc.listProvisioning(user.orgId, query);
  }

  @Post("provisioning")
  @HttpCode(201)
  @RequirePermission("hr:identity:manage")
  createProvisioning(
    @CurrentUser() user: CurrentUserContext,
    @Body(new ZodValidationPipe(createProvisioningSchema)) body: CreateProvisioningInput,
  ) {
    return this.svc.createProvisioning(user.orgId, body);
  }

  @Post("provisioning/generate")
  @HttpCode(201)
  @RequirePermission("hr:identity:manage")
  generateProvisioning(
    @CurrentUser() user: CurrentUserContext,
    @Body(new ZodValidationPipe(generateProvisioningSchema)) body: GenerateProvisioningInput,
  ) {
    return this.svc.generateProvisioning(user.orgId, body);
  }

  @Patch("provisioning/:provisioningId")
  @RequirePermission("hr:identity:manage")
  @Validate({ params: provisioningIdParams })
  updateProvisioning(
    @CurrentUser() user: CurrentUserContext,
    @Param("provisioningId") provisioningId: string,
    @Body(new ZodValidationPipe(updateProvisioningSchema)) body: UpdateProvisioningInput,
  ) {
    return this.svc.updateProvisioning(user.orgId, provisioningId, body);
  }

  @Get("templates")
  @RequirePermission("hr:identity:view")
  listTemplates(@CurrentUser() user: CurrentUserContext) {
    return this.svc.listTemplates(user.orgId);
  }

  @Post("templates")
  @HttpCode(201)
  @RequirePermission("hr:identity:manage")
  createTemplate(
    @CurrentUser() user: CurrentUserContext,
    @Body(new ZodValidationPipe(createTemplateSchema)) body: CreateTemplateInput,
  ) {
    return this.svc.createTemplate(user.orgId, body);
  }

  @Patch("templates/:templateId")
  @RequirePermission("hr:identity:manage")
  @Validate({ params: templateIdParams })
  updateTemplate(
    @CurrentUser() user: CurrentUserContext,
    @Param("templateId") templateId: string,
    @Body(new ZodValidationPipe(updateTemplateSchema)) body: UpdateTemplateInput,
  ) {
    return this.svc.updateTemplate(user.orgId, templateId, body);
  }

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

  @Get("exit-verification")
  @RequirePermission("hr:identity:view")
  exitVerification(
    @CurrentUser() user: CurrentUserContext,
    @Query(new ZodValidationPipe(exitVerificationSchema)) query: z.infer<typeof exitVerificationSchema>,
  ) {
    return this.svc.getExitVerification(user.orgId, query.userId);
  }
}
