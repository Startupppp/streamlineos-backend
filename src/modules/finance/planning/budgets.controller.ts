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
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
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
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const budgetIdParams = z.object({ budgetId: z.coerce.number().int().positive() }).strict();

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
  @Validate({ query: listBudgetsQuerySchema })
  listBudgets(
    @Query() query: ListBudgetsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budgets.listBudgets(u.orgId, query);
  }

  @Post("budgets")
  @RequirePermission("accounting:budgets:create")
  @HttpCode(201)
  @Validate({ body: createBudgetSchema })
  createBudget(
    @Body() body: CreateBudgetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budgets.createBudget(u.orgId, u.userId, body);
  }

  @Get("budgets/:budgetId")
  @RequirePermission("accounting:budgets:read")
  @Validate({ params: budgetIdParams })
  getBudget(
    @Param("budgetId", ParseIntPipe) budgetId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budgets.getBudget(u.orgId, budgetId);
  }

  @Patch("budgets/:budgetId")
  @RequirePermission("accounting:budgets:update")
  @Validate({ params: budgetIdParams, body: updateBudgetSchema })
  updateBudget(
    @Param("budgetId", ParseIntPipe) budgetId: number,
    @Body() body: UpdateBudgetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budgets.updateBudget(u.orgId, budgetId, u.userId, body);
  }

  @Put("budgets/:budgetId/lines")
  @RequirePermission("accounting:budgets:update")
  @HttpCode(200)
  @Validate({ params: budgetIdParams, body: replaceBudgetLinesSchema })
  replaceBudgetLines(
    @Param("budgetId", ParseIntPipe) budgetId: number,
    @Body() body: ReplaceBudgetLinesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budgets.replaceBudgetLines(u.orgId, budgetId, u.userId, body);
  }

  @Post("budgets/:budgetId/submit")
  @Idempotent("finance.budget.submit")
  @RequirePermission("accounting:budgets:update")
  @HttpCode(200)
  @Validate({ params: budgetIdParams, body: budgetWorkflowSchema })
  submitBudget(
    @Param("budgetId", ParseIntPipe) budgetId: number,
    @Body() body: BudgetWorkflowInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budgets.submitBudget(u.orgId, budgetId, u.userId, body);
  }

  @Post("budgets/:budgetId/approve")
  @Idempotent("finance.budget.approve")
  @RequirePermission("accounting:budgets:approve")
  @HttpCode(200)
  @Validate({ params: budgetIdParams, body: budgetWorkflowSchema })
  approveBudget(
    @Param("budgetId", ParseIntPipe) budgetId: number,
    @Body() body: BudgetWorkflowInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budgets.approveBudget(u.orgId, budgetId, u.userId, body);
  }

  @Get("budgets/:budgetId/revisions")
  @RequirePermission("accounting:budgets:read")
  @Validate({ params: budgetIdParams })
  listRevisions(
    @Param("budgetId", ParseIntPipe) budgetId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budgets.listRevisions(u.orgId, budgetId);
  }

  @Post("budgets/:budgetId/duplicate")
  @RequirePermission("accounting:budgets:create")
  @HttpCode(201)
  @Validate({ params: budgetIdParams, body: duplicateBudgetSchema })
  duplicateBudget(
    @Param("budgetId", ParseIntPipe) budgetId: number,
    @Body() body: DuplicateBudgetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budgets.duplicateBudget(u.orgId, budgetId, u.userId, body);
  }

  @Get("budgets/:budgetId/vs-actual")
  @RequirePermission("accounting:budgets:read")
  @Validate({ params: budgetIdParams, query: bvaQuerySchema })
  getBva(
    @Param("budgetId", ParseIntPipe) budgetId: number,
    @Query() query: BvaQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.bva.getBva(u.orgId, budgetId, query, u.userId);
  }
}
