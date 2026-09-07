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
import { CrmAutomationsService } from "./crm-automations.service";
import {
  createAutomationRuleSchema,
  updateAutomationRuleSchema,
  automationRunsQuerySchema,
  type CreateAutomationRuleInput,
  type UpdateAutomationRuleInput,
  type AutomationRunsQueryInput,
} from "./dto/automation-rules.schemas";
import {
  testAutomationRuleSchema,
  type TestAutomationRuleInput,
} from "../automation-studio/dto/automation-studio.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  automationRulesListSchema,
  automationRuleSingleSchema,
  automationEventsListSchema,
  automationActionsListSchema,
  automationRunsPageSchema,
  automationDryRunSchema,
} from "./dto/crm-automations-response.schemas";
import { successSchema } from "../../../common/openapi/response-envelopes";

const ruleIdParams = z.object({ ruleId: z.coerce.number().int().positive() }).strict();

@RequireModule("crm")
@Controller("crm")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmAutomationsController {
  constructor(private readonly automations: CrmAutomationsService) {}

  @Get("automations")
  @RequirePermission("crm:automations:manage")
  @ResponseSchema(automationRulesListSchema)
  list(@CurrentUser() u: CurrentUserContext) {
    return this.automations.list(u.orgId);
  }

  @Post("automations")
  @RequirePermission("crm:automations:manage")
  @HttpCode(201)
  @ResponseSchema(automationRuleSingleSchema)
  @Validate({ body: createAutomationRuleSchema })
  create(
    @Body() body: CreateAutomationRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.create(u.orgId, body);
  }

  @Patch("automations/:ruleId")
  @RequirePermission("crm:automations:manage")
  @ResponseSchema(automationRuleSingleSchema)
  @Validate({ params: ruleIdParams, body: updateAutomationRuleSchema })
  async update(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @Body() body: UpdateAutomationRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.automations.update(u.orgId, ruleId, body);
    if (!result) throw new NotFoundException("Automation rule not found");
    return result;
  }

  @Delete("automations/:ruleId")
  @HttpCode(200)
  @RequirePermission("crm:automations:manage")
  @ResponseSchema(successSchema)
  @Validate({ params: ruleIdParams })
  async remove(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<{ success: true }> {
    await this.automations.remove(u.orgId, ruleId);
    return { success: true };
  }

  @Get("automation/events")
  @RequirePermission("crm:automations:manage")
  @ResponseSchema(automationEventsListSchema)
  listEvents(@CurrentUser() u: CurrentUserContext) {
    return this.automations.listEvents(u.orgId);
  }

  @Get("automation/actions")
  @RequirePermission("crm:automations:manage")
  @ResponseSchema(automationActionsListSchema)
  listActions(@CurrentUser() u: CurrentUserContext) {
    return this.automations.listActions(u.orgId);
  }

  @Patch("automations/:ruleId/enable")
  @BodylessAction()
  @RequirePermission("crm:automations:manage")
  @ResponseSchema(automationRuleSingleSchema)
  @Validate({ params: ruleIdParams })
  enable(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.enable(u.orgId, ruleId);
  }

  @Patch("automations/:ruleId/disable")
  @BodylessAction()
  @RequirePermission("crm:automations:manage")
  @ResponseSchema(automationRuleSingleSchema)
  @Validate({ params: ruleIdParams })
  disable(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.disable(u.orgId, ruleId);
  }

  @Post("automations/:ruleId/test")
  @RequirePermission("crm:automations:manage")
  @HttpCode(200)
  @ResponseSchema(automationDryRunSchema)
  @Validate({ params: ruleIdParams, body: testAutomationRuleSchema })
  testRule(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @Body() body: TestAutomationRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.testRule(u.orgId, ruleId, body);
  }

  @Get("automations/:ruleId/runs")
  @RequirePermission("crm:automations:manage")
  @ResponseSchema(automationRunsPageSchema)
  @Validate({ params: ruleIdParams, query: automationRunsQuerySchema })
  getRuns(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @Query() query: AutomationRunsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.getRuns(u.orgId, ruleId, query.cursor);
  }
}
