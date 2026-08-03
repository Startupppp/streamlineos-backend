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
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { HrAutomationEngineService } from "./hr-automation-engine.service";
import {
  createHrAutomationRuleSchema,
  updateHrAutomationRuleSchema,
  testHrAutomationSchema,
  listRunsSchema,
  type CreateHrAutomationRuleInput,
  type UpdateHrAutomationRuleInput,
  type TestHrAutomationInput,
  type ListRunsInput,
} from "./dto/hr-automation.schemas";
import { HR_AUTOMATION_EVENTS, HR_EVENT_FIELD_DOCS, HR_EVENT_SAMPLE_PAYLOADS } from "./hr-automation-events";
import { RequireModule } from "../../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/automations")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrAutomationsController {
  constructor(private readonly engine: HrAutomationEngineService) {}

  @Get("events")
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
  @RequirePermission("hr:automations:view")
  list(
    @CurrentUser() u: CurrentUserContext,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("search") search?: string,
    @Query("triggerEvent") triggerEvent?: string,
    @Query("isEnabled") isEnabled?: string,
  ) {
    const pageNum = Math.max(1, parseInt(page ?? "1", 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit ?? "50", 10) || 50));
    const enabledFilter = isEnabled === "true" ? true : isEnabled === "false" ? false : undefined;

    return this.engine.listRules(u.orgId, {
      search,
      triggerEvent,
      isEnabled: enabledFilter,
      page: pageNum,
      limit: limitNum,
    });
  }

  @Get("runs")
  @RequirePermission("hr:automations:view")
  listAllRuns(
    @CurrentUser() u: CurrentUserContext,
    @Query(new ZodValidationPipe(listRunsSchema)) query: ListRunsInput,
  ) {
    return this.engine.listRuns(u.orgId, { page: query.page, limit: query.limit });
  }

  @Get(":ruleId")
  @RequirePermission("hr:automations:view")
  getOne(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.engine.getRule(u.orgId, ruleId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:automations:manage")
  create(
    @Body(new ZodValidationPipe(createHrAutomationRuleSchema)) body: CreateHrAutomationRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.engine.createRule(u.orgId, u.userId, body);
  }

  @Patch(":ruleId")
  @RequirePermission("hr:automations:manage")
  update(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @Body(new ZodValidationPipe(updateHrAutomationRuleSchema)) body: UpdateHrAutomationRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.engine.updateRule(u.orgId, ruleId, body);
  }

  @Post(":ruleId/toggle")
  @HttpCode(200)
  @RequirePermission("hr:automations:manage")
  toggle(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @Body() body: { isEnabled: boolean },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.engine.toggleRule(u.orgId, ruleId, Boolean(body.isEnabled));
  }

  @Delete(":ruleId")
  @HttpCode(204)
  @RequirePermission("hr:automations:manage")
  async remove(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.engine.deleteRule(u.orgId, ruleId);
  }

  @Post(":ruleId/test")
  @HttpCode(200)
  @RequirePermission("hr:automations:manage")
  test(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @Body(new ZodValidationPipe(testHrAutomationSchema)) body: TestHrAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.engine.testRule(u.orgId, ruleId, body.payload);
  }

  @Get(":ruleId/runs")
  @RequirePermission("hr:automations:view")
  listRuns(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
    @Query(new ZodValidationPipe(listRunsSchema)) query: ListRunsInput,
  ) {
    return this.engine.listRuns(u.orgId, { ruleId, page: query.page, limit: query.limit });
  }
}
