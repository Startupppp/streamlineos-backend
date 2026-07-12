import { Body, Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ExpensesService } from "./expenses.service";
import { createCategorySchema, type CreateCategoryInput } from "./dto/expense.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("accounting")
@Controller("hr/expenses/categories")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ExpenseCategoriesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  @RequirePermission("hr:expenses:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.expenses.getCategories(u.orgId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:expenses:manage")
  create(
    @Body(new ZodValidationPipe(createCategorySchema)) body: CreateCategoryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expenses.createCategory(u.orgId, body);
  }
}
