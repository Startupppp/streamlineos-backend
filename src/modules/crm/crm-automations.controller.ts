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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { CrmAutomationsService } from "./crm-automations.service";
import {
  createAutomationRuleSchema,
  updateAutomationRuleSchema,
  type CreateAutomationRuleInput,
  type UpdateAutomationRuleInput,
} from "./dto/automation-rules.schemas";

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
  @RequirePermission("crm:automations:manage")
  remove(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.remove(u.orgId, ruleId);
  }
}
