import { Body, Controller, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AutomationService } from "./automation.service";
import { testAutomationSchema, type TestAutomationInput } from "./dto/automation.schemas";

@Controller("settings/automations")
@UseGuards(JwtAuthGuard, AbilityGuard)
export class AutomationController {
  constructor(private readonly automation: AutomationService) {}

  @Post(":ruleId/test")
  @HttpCode(200)
  @CheckAbility("manage", "settings:automations")
  testAutomation(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @Body(new ZodValidationPipe(testAutomationSchema)) body: TestAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automation.testRule(u.orgId, ruleId, body.payload);
  }
}
