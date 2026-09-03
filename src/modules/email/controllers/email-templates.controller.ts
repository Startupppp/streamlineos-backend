import { Body, Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { AuditService } from "../../../common/audit/audit.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { EmailRoutesService } from "../email-routes.service";
import { emailTemplateTestSchema, type EmailTemplateTestInput } from "../dto/email.schemas";

@Controller("settings/email-templates")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class EmailTemplatesController {
  constructor(
    private readonly routes: EmailRoutesService,
    private readonly audit: AuditService,
  ) {}

  @Get("preview")
  @HttpCode(200)
  @RequirePermission("settings:email-templates:manage")
  preview() {
    return this.routes.getTemplatePreviews();
  }

  @Post("test")
  @HttpCode(200)
  @RequirePermission("settings:email-templates:manage")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("settings:email-template-test")
  @Validate({ body: emailTemplateTestSchema })
  async test(
    @Body() body: EmailTemplateTestInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.routes.sendTemplateTest(
      u,
      body.templateId,
      body.testEmail,
      body.locale,
    );
    this.audit.log({
      action: "settings.emailTemplate.test",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "email_template",
      resourceId: body.templateId,
      metadata: { to: result.to, locale: result.locale, version: result.version },
    });
    return result;
  }
}
