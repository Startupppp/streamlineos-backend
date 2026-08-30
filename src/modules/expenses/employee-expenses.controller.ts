import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import {
  createExpenseSchema,
  selfExpensePageDataSchema,
  updateExpenseDetailsSchema,
  type CreateExpenseInput,
  type SelfExpensePageDataInput,
  type UpdateExpenseDetailsInput,
} from "./dto/expense.schemas";
import { ExpensesService } from "./expenses.service";
import { ExpensesWriteService } from "./expenses-write.service";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const expenseIdParams = z.object({ expenseId: z.coerce.number().int().positive() }).strict();

@Controller("me/expenses")
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission("self:expenses")
export class EmployeeExpensesController {
  constructor(
    private readonly expenses: ExpensesService,
    private readonly expensesWrite: ExpensesWriteService,
  ) {}

  @Get()
  pageData(
    @Query(new ZodValidationPipe(selfExpensePageDataSchema))
    filters: SelfExpensePageDataInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.expenses.getPageData(
      user.orgId,
      user.userId,
      false,
      filters,
    );
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createExpenseSchema)) body: CreateExpenseInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.expensesWrite.create(user.orgId, user.userId, body);
  }

  @Patch(":expenseId")
  @Validate({ params: expenseIdParams })
  update(
    @Param("expenseId", ParseIntPipe) expenseId: number,
    @Body(new ZodValidationPipe(updateExpenseDetailsSchema))
    body: UpdateExpenseDetailsInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.expensesWrite.updateOwn(
      user.orgId,
      user.userId,
      expenseId,
      body,
    );
  }
}
