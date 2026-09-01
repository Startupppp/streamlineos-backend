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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { BudgetsService } from "./budgets.service";
import {
  createBudgetSchema,
  updateBudgetSchema,
  type CreateBudgetInput,
  type UpdateBudgetInput,
} from "./dto/budgets.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const budgetIdParams = z.object({ budgetId: z.coerce.number().int().positive() }).strict();

@RequireModule("timesheets")
@Controller("timesheets/budgets")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class TimesheetBudgetsController {
  constructor(private readonly budgets: BudgetsService) {}

  @Get()
  @RequirePermission("timesheets:budgets:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.budgets.list(u.orgId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("timesheets:budgets:manage")
  @Validate({ body: createBudgetSchema })
  create(
    @Body() body: CreateBudgetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budgets.create(u.orgId, u.userId, body);
  }

  @Patch(":budgetId")
  @RequirePermission("timesheets:budgets:manage")
  @Validate({ params: budgetIdParams, body: updateBudgetSchema })
  update(
    @Param("budgetId", ParseIntPipe) budgetId: number,
    @Body() body: UpdateBudgetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budgets.update(u.orgId, u.userId, budgetId, body);
  }

  @Delete(":budgetId")
  @HttpCode(204)
  @RequirePermission("timesheets:budgets:manage")
  @Validate({ params: budgetIdParams })
  remove(
    @Param("budgetId", ParseIntPipe) budgetId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.budgets.remove(u.orgId, u.userId, budgetId);
  }
}
