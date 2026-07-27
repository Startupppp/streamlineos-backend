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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { BudgetsService } from "./budgets.service";
import {
  createBudgetSchema,
  updateBudgetSchema,
  type CreateBudgetInput,
  type UpdateBudgetInput,
} from "./dto/budgets.schemas";

@RequireModule("build")
@Controller("timesheets/budgets")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class BudgetsController {
  constructor(private readonly budgets: BudgetsService) {}

  @Get()
  @RequirePermission("timesheets:budgets:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.budgets.list(u.orgId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("timesheets:budgets:manage")
  create(
    @Body(new ZodValidationPipe(createBudgetSchema)) body: CreateBudgetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budgets.create(u.orgId, u.userId, body);
  }

  @Patch(":budgetId")
  @RequirePermission("timesheets:budgets:manage")
  update(
    @Param("budgetId", ParseIntPipe) budgetId: number,
    @Body(new ZodValidationPipe(updateBudgetSchema)) body: UpdateBudgetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budgets.update(u.orgId, u.userId, budgetId, body);
  }

  @Delete(":budgetId")
  @HttpCode(204)
  @RequirePermission("timesheets:budgets:manage")
  remove(
    @Param("budgetId", ParseIntPipe) budgetId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budgets.remove(u.orgId, u.userId, budgetId);
  }
}
