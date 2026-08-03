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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { CrmAutomationsService } from "./crm-automations.service";
import {
  createAutomationRuleSchema,
  updateAutomationRuleSchema,
  type CreateAutomationRuleInput,
  type UpdateAutomationRuleInput,
} from "./dto/automation-rules.schemas";
import {
  testAutomationRuleSchema,
  type TestAutomationRuleInput,
} from "../automation-studio/dto/automation-studio.schemas";

@RequireModule("crm")
@Controller("crm")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmAutomationsController {
  constructor(private readonly automations: CrmAutomationsService) {}

  @Get("automations")
  @RequirePermission("crm:automations:manage")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.automations.list(u.orgId);
  }

  @Post("automations")
  @RequirePermission("crm:automations:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createAutomationRuleSchema)) body: CreateAutomationRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.create(u.orgId, body);
  }

  @Patch("automations/:ruleId")
  @RequirePermission("crm:automations:manage")
  async update(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @Body(new ZodValidationPipe(updateAutomationRuleSchema)) body: UpdateAutomationRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.automations.update(u.orgId, ruleId, body);
    if (!result) throw new NotFoundException("Automation rule not found");
    return result;
  }

  @Delete("automations/:ruleId")
  @HttpCode(204)
  @RequirePermission("crm:automations:manage")
  async remove(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.automations.remove(u.orgId, ruleId);
  }

  @Get("automation/events")
  @RequirePermission("crm:automations:manage")
  listEvents(@CurrentUser() u: CurrentUserContext) {
    return this.automations.listEvents(u.orgId);
  }

  @Get("automation/actions")
  @RequirePermission("crm:automations:manage")
  listActions(@CurrentUser() u: CurrentUserContext) {
    return this.automations.listActions(u.orgId);
  }

  @Patch("automations/:ruleId/enable")
  @RequirePermission("crm:automations:manage")
  enable(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.enable(u.orgId, ruleId);
  }

  @Patch("automations/:ruleId/disable")
  @RequirePermission("crm:automations:manage")
  disable(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.disable(u.orgId, ruleId);
  }

  @Post("automations/:ruleId/test")
  @RequirePermission("crm:automations:manage")
  @HttpCode(200)
  testRule(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @Body(new ZodValidationPipe(testAutomationRuleSchema)) body: TestAutomationRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.testRule(u.orgId, ruleId, body);
  }

  @Get("automations/:ruleId/runs")
  @RequirePermission("crm:automations:manage")
  getRuns(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @Query("page") page = "1",
    @CurrentUser() u: CurrentUserContext,
  ) {
    const pageNum = Math.max(1, Math.min(100, parseInt(page, 10) || 1));
    return this.automations.getRuns(u.orgId, ruleId, pageNum);
  }
}
