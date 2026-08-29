import { Controller, Get, Post, Patch, Delete, Param, ParseIntPipe, Query, Body, UseGuards, HttpCode, HttpStatus } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { InvReplenishmentService } from "./inv-replenishment.service";
import {
  listRulesSchema,
  createRuleSchema,
  updateRuleSchema,
  generatePoSchema,
  suggestionsQuerySchema,
  type ListRulesInput,
  type CreateRuleInput,
  type UpdateRuleInput,
  type GeneratePoInput,
  type SuggestionsQueryInput,
} from "./dto/replenishment.schemas";

@RequireModule("inventory")
@Controller("inventory/replenishment")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvReplenishmentController {
  constructor(private readonly replenishment: InvReplenishmentService) {}

  @Get("rules")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:replenishment:manage")
  listRules(
    @Query(new ZodValidationPipe(listRulesSchema)) filters: ListRulesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.replenishment.listRules(u.orgId, filters);
  }

  @Post("rules")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:replenishment:manage")
  createRule(
    @Body(new ZodValidationPipe(createRuleSchema)) body: CreateRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.replenishment.createRule(u.orgId, body);
  }

  @Patch("rules/:ruleId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:replenishment:manage")
  updateRule(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @Body(new ZodValidationPipe(updateRuleSchema)) body: UpdateRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.replenishment.updateRule(u.orgId, ruleId, body);
  }

  @Delete("rules/:ruleId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:replenishment:manage")
  @HttpCode(HttpStatus.OK)
  deleteRule(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.replenishment.deleteRule(u.orgId, ruleId);
  }

  @Get("suggestions")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:reports:read")
  getSuggestions(
    @Query(new ZodValidationPipe(suggestionsQuerySchema)) filters: SuggestionsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.replenishment.getSuggestions(u.orgId, filters);
  }

  @Post("suggestions/generate-po")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:create")
  generatePo(
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(generatePoSchema)) body: GeneratePoInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.replenishment.generatePo(u.orgId, u.userId, body, idempotencyKey);
  }
}
