import {
  Body, Controller, Get, HttpCode, Param, ParseIntPipe,
  Patch, Post, Put, Query, UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { BudgetsService } from "./budgets.service";
import { BvaService } from "./bva.service";
import {
  listBudgetsQuerySchema, createBudgetSchema, updateBudgetSchema,
  replaceBudgetLinesSchema, budgetWorkflowSchema, duplicateBudgetSchema,
  bvaQuerySchema,
  type ListBudgetsQuery, type CreateBudgetInput, type UpdateBudgetInput,
  type ReplaceBudgetLinesInput, type BudgetWorkflowInput, type DuplicateBudgetInput,
  type BvaQuery,
} from "./dto/finance-planning.schemas";

@RequireModule("accounting")
@Controller("accounting")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class BudgetsController {
  constructor(
    private readonly budgets: BudgetsService,
    private readonly bva: BvaService,
  ) {}

  @Get("budgets")
  @RequirePermission("accounting:budgets:read")
  listBudgets(
    @Query(new ZodValidationPipe(listBudgetsQuerySchema)) query: ListBudgetsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budgets.listBudgets(u.orgId, query);
  }

  @Post("budgets")
  @RequirePermission("accounting:budgets:create")
  @HttpCode(201)
  createBudget(
    @Body(new ZodValidationPipe(createBudgetSchema)) body: CreateBudgetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budgets.createBudget(u.orgId, u.userId, body);
  }

  @Get("budgets/:budgetId")
  @RequirePermission("accounting:budgets:read")
  getBudget(
    @Param("budgetId", ParseIntPipe) budgetId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budgets.getBudget(u.orgId, budgetId);
  }

  @Patch("budgets/:budgetId")
  @RequirePermission("accounting:budgets:update")
  updateBudget(
    @Param("budgetId", ParseIntPipe) budgetId: number,
    @Body(new ZodValidationPipe(updateBudgetSchema)) body: UpdateBudgetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budgets.updateBudget(u.orgId, budgetId, u.userId, body);
  }

  @Put("budgets/:budgetId/lines")
  @RequirePermission("accounting:budgets:update")
  @HttpCode(200)
  replaceBudgetLines(
    @Param("budgetId", ParseIntPipe) budgetId: number,
    @Body(new ZodValidationPipe(replaceBudgetLinesSchema)) body: ReplaceBudgetLinesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budgets.replaceBudgetLines(u.orgId, budgetId, u.userId, body);
  }

  @Post("budgets/:budgetId/submit")
  @RequirePermission("accounting:budgets:update")
  @HttpCode(200)
  submitBudget(
    @Param("budgetId", ParseIntPipe) budgetId: number,
    @Body(new ZodValidationPipe(budgetWorkflowSchema)) body: BudgetWorkflowInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budgets.submitBudget(u.orgId, budgetId, u.userId, body);
  }

  @Post("budgets/:budgetId/approve")
  @RequirePermission("accounting:budgets:approve")
  @HttpCode(200)
  approveBudget(
    @Param("budgetId", ParseIntPipe) budgetId: number,
    @Body(new ZodValidationPipe(budgetWorkflowSchema)) body: BudgetWorkflowInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budgets.approveBudget(u.orgId, budgetId, u.userId, body);
  }

  @Get("budgets/:budgetId/revisions")
  @RequirePermission("accounting:budgets:read")
  listRevisions(
    @Param("budgetId", ParseIntPipe) budgetId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budgets.listRevisions(u.orgId, budgetId);
  }

  @Post("budgets/:budgetId/duplicate")
  @RequirePermission("accounting:budgets:create")
  @HttpCode(201)
  duplicateBudget(
    @Param("budgetId", ParseIntPipe) budgetId: number,
    @Body(new ZodValidationPipe(duplicateBudgetSchema)) body: DuplicateBudgetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budgets.duplicateBudget(u.orgId, budgetId, u.userId, body);
  }

  @Get("budgets/:budgetId/vs-actual")
  @RequirePermission("accounting:budgets:read")
  getBva(
    @Param("budgetId", ParseIntPipe) budgetId: number,
    @Query(new ZodValidationPipe(bvaQuerySchema)) query: BvaQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.bva.getBva(u.orgId, budgetId, query, u.userId);
  }
}
