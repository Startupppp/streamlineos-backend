import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../../common/rbac/ability.guard";
import { CheckAbility } from "../../../common/rbac/check-ability.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { EmailRoutesService } from "../email-routes.service";
import { emailTemplateTestSchema, type EmailTemplateTestInput } from "../dto/email.schemas";

@Controller("settings/email-templates")
@UseGuards(JwtAuthGuard, AbilityGuard)
export class EmailTemplatesController {
  constructor(private readonly routes: EmailRoutesService) {}

  @Post("test")
  @HttpCode(200)
  @CheckAbility("manage", "settings:email-templates")
  test(@Body(new ZodValidationPipe(emailTemplateTestSchema)) body: EmailTemplateTestInput) {
    return this.routes.sendTemplateTest(body.templateId, body.testEmail);
  }
}
