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
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { HrAutomationEngineService } from "./hr-automation-engine.service";
import {
  createHrAutomationRuleSchema,
  updateHrAutomationRuleSchema,
  testHrAutomationSchema,
  toggleHrAutomationRuleSchema,
  listHrAutomationRulesSchema,
  listRunsSchema,
  type CreateHrAutomationRuleInput,
  type UpdateHrAutomationRuleInput,
  type TestHrAutomationInput,
  type ToggleHrAutomationRuleInput,
  type ListHrAutomationRulesInput,
  type ListRunsInput,
} from "./dto/hr-automation.schemas";
import { HR_AUTOMATION_EVENTS, HR_EVENT_FIELD_DOCS, HR_EVENT_SAMPLE_PAYLOADS } from "./hr-automation-events";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  automationEventsListSchema,
  automationRuleListSchema,
  automationRuleDetailSchema,
  automationRunListSchema,
  automationTestResultSchema,
  successSchema,
} from "./dto/automation-response.schemas";

const ruleIdParams = z.object({ ruleId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/automations")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrAutomationsController {
  constructor(private readonly engine: HrAutomationEngineService) {}

  @Get("events")
  @ResponseSchema(automationEventsListSchema)
  @RequirePermission("hr:automations:view")
  getEvents() {
    return {
      events: HR_AUTOMATION_EVENTS.map((event) => ({
        value: event,
        fields: HR_EVENT_FIELD_DOCS[event],
        samplePayload: HR_EVENT_SAMPLE_PAYLOADS[event],
      })),
    };
  }

  @Get()
  @ResponseSchema(automationRuleListSchema)
  @RequirePermission("hr:automations:view")
  @Validate({ query: listHrAutomationRulesSchema })
  list(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: ListHrAutomationRulesInput,
  ) {
    return this.engine.listRules(u.orgId, {
      search: query.search,
      triggerEvent: query.triggerEvent,
      isEnabled: query.isEnabled,
      page: query.page,
      limit: query.limit,
    });
  }

  @Get("runs")
  @ResponseSchema(automationRunListSchema)
  @RequirePermission("hr:automations:view")
  @Validate({ query: listRunsSchema })
  listAllRuns(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: ListRunsInput,
  ) {
    return this.engine.listRuns(u.orgId, { page: query.page, limit: query.limit });
  }

  @Get(":ruleId")
  @ResponseSchema(automationRuleDetailSchema)
  @RequirePermission("hr:automations:view")
  @Validate({ params: ruleIdParams })
  getOne(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.engine.getRule(u.orgId, ruleId);
  }

  @Post()
  @ResponseSchema(automationRuleDetailSchema)
  @HttpCode(201)
  @RequirePermission("hr:automations:manage")
  @Validate({ body: createHrAutomationRuleSchema })
  create(
    @Body() body: CreateHrAutomationRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.engine.createRule(u.orgId, u.userId, body);
  }

  @Patch(":ruleId")
  @ResponseSchema(automationRuleDetailSchema)
  @RequirePermission("hr:automations:manage")
  @Validate({ params: ruleIdParams, body: updateHrAutomationRuleSchema })
  update(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @Body() body: UpdateHrAutomationRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.engine.updateRule(u.orgId, ruleId, body);
  }

  @Post(":ruleId/toggle")
  @ResponseSchema(automationRuleDetailSchema)
  @HttpCode(200)
  @RequirePermission("hr:automations:manage")
  @Validate({ params: ruleIdParams, body: toggleHrAutomationRuleSchema })
  toggle(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @Body() body: ToggleHrAutomationRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.engine.toggleRule(u.orgId, ruleId, body.isEnabled);
  }

  @Delete(":ruleId")
  @NoContentResponse()
  @HttpCode(204)
  @RequirePermission("hr:automations:manage")
  @Validate({ params: ruleIdParams })
  async remove(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.engine.deleteRule(u.orgId, ruleId);
  }

  @Post(":ruleId/test")
  @ResponseSchema(automationTestResultSchema)
  @HttpCode(200)
  @RequirePermission("hr:automations:manage")
  @Validate({ params: ruleIdParams, body: testHrAutomationSchema })
  test(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @Body() body: TestHrAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.engine.testRule(u.orgId, ruleId, body.payload);
  }

  @Get(":ruleId/runs")
  @ResponseSchema(automationRunListSchema)
  @RequirePermission("hr:automations:view")
  @Validate({ params: ruleIdParams, query: listRunsSchema })
  listRuns(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
    @Query() query: ListRunsInput,
  ) {
    return this.engine.listRuns(u.orgId, { ruleId, page: query.page, limit: query.limit });
  }
}
