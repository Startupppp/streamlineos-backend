import { Body, Controller, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AutomationService } from "./automation.service";
import { testAutomationSchema, type TestAutomationInput } from "./dto/automation.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const ruleIdParams = z.object({ ruleId: z.coerce.number().int().positive() }).strict();

@Controller("settings/automations")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AutomationController {
  constructor(private readonly automation: AutomationService) {}

  @Post(":ruleId/test")
  @HttpCode(200)
  @RequirePermission("settings:automations:manage")
  @Validate({ params: ruleIdParams, body: testAutomationSchema })
  testAutomation(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @Body() body: TestAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automation.testRule(u.orgId, ruleId, body.payload);
  }
}
