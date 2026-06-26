import { Body, Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ExpensesService } from "./expenses.service";
import { createCategorySchema, type CreateCategoryInput } from "./dto/expense.schemas";

@Controller("hr/expenses/categories")
@UseGuards(JwtAuthGuard, AbilityGuard)
export class ExpenseCategoriesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  list(@CurrentUser() u: CurrentUserContext) {
    return this.expenses.getCategories(u.orgId);
  }

  @Post()
  @HttpCode(201)
  @CheckAbility("manage", "hr:expenses")
  create(
    @Body(new ZodValidationPipe(createCategorySchema)) body: CreateCategoryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expenses.createCategory(u.orgId, body);
  }
}
