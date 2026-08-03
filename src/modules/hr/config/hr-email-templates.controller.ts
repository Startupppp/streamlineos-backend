import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { HrEmailTemplatesService } from "./hr-email-templates.service";
import {
  createEmailTemplateSchema,
  updateEmailTemplateSchema,
  generateEmailTemplateAiSchema,
  type CreateEmailTemplateInput,
  type UpdateEmailTemplateInput,
  type GenerateEmailTemplateAiInput,
} from "./dto/email-templates.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/email-templates")
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission("hr:email-templates:manage")
export class HrEmailTemplatesController {
  constructor(private readonly emailTemplates: HrEmailTemplatesService) {}

  @Get()
  list(@CurrentUser() u: CurrentUserContext) {
    return this.emailTemplates.list(u.orgId);
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createEmailTemplateSchema)) body: CreateEmailTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.emailTemplates.create(u.orgId, u.userId, body);
  }

  @Patch(":templateId")
  update(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(updateEmailTemplateSchema)) body: UpdateEmailTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.emailTemplates.update(u.orgId, templateId, body);
  }

  @Delete(":templateId")
  @HttpCode(204)
  remove(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.emailTemplates.remove(u.orgId, templateId);
  }

  @Post("generate-ai")
  @HttpCode(200)
  generateAi(
    @Body(new ZodValidationPipe(generateEmailTemplateAiSchema)) body: GenerateEmailTemplateAiInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.emailTemplates.generateWithAi(u.orgId, u.userId, body);
  }
}
