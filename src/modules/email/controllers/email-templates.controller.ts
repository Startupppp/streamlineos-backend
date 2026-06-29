import { Body, Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { EmailRoutesService } from "../email-routes.service";
import { emailTemplateTestSchema, type EmailTemplateTestInput } from "../dto/email.schemas";

@Controller("settings/email-templates")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class EmailTemplatesController {
  constructor(private readonly routes: EmailRoutesService) {}

  @Get("preview")
  @HttpCode(200)
  @RequirePermission("settings:email-templates:manage")
  preview() {
    return this.routes.getTemplatePreviews();
  }

  @Post("test")
  @HttpCode(200)
  @RequirePermission("settings:email-templates:manage")
  test(@Body(new ZodValidationPipe(emailTemplateTestSchema)) body: EmailTemplateTestInput) {
    return this.routes.sendTemplateTest(body.templateId, body.testEmail);
  }
}
