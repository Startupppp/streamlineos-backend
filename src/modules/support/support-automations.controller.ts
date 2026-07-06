import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AutomationService } from "../automation/automation.service";
import {
  createAutomationRuleSchema,
  testAutomationSchema,
  updateAutomationRuleSchema,
  type CreateAutomationRuleInput,
  type TestAutomationInput,
  type UpdateAutomationRuleInput,
} from "../automation/dto/automation.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../common/rbac/module.guard";

const TICKET_TRIGGER_PREFIX = "ticket.";

@RequireModule("support")
@Controller("support")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SupportAutomationsController {
  constructor(private readonly automations: AutomationService) {}

  @Get("automations")
  @RequirePermission("support:settings:manage")
  listAutomations(@CurrentUser() u: CurrentUserContext) {
    return this.automations.listRules(u.orgId, TICKET_TRIGGER_PREFIX);
  }

  @Post("automations")
  @RequirePermission("support:settings:manage")
  @HttpCode(201)
  createAutomation(
    @Body(new ZodValidationPipe(createAutomationRuleSchema)) body: CreateAutomationRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!body.triggerEvent.startsWith(TICKET_TRIGGER_PREFIX)) {
      throw new NotFoundException(`Support automations must use a "${TICKET_TRIGGER_PREFIX}*" trigger`);
    }
    return this.automations.createRule(u.orgId, u.userId, body);
  }

  @Patch("automations/:id")
  @RequirePermission("support:settings:manage")
  updateAutomation(
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateAutomationRuleSchema)) body: UpdateAutomationRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.updateRule(u.orgId, id, body);
  }

  @Delete("automations/:id")
  @RequirePermission("support:settings:manage")
  deleteAutomation(@Param("id", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext) {
    return this.automations.deleteRule(u.orgId, id);
  }

  @Post("automations/:id/test")
  @RequirePermission("support:settings:manage")
  @HttpCode(200)
  testAutomation(
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(testAutomationSchema)) body: TestAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.testRule(u.orgId, id, body.payload);
  }

  @Get("automation-runs")
  @RequirePermission("support:settings:manage")
  listAutomationRuns(@Query("automationId") automationId: string | undefined, @CurrentUser() u: CurrentUserContext) {
    return this.automations.listRuns(u.orgId, automationId ? Number(automationId) : undefined);
  }
}
