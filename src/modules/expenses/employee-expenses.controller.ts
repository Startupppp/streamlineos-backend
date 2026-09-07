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
import { SELF_ONLY_SCOPE } from "./expenses-scope";
import { ExpensesWriteService } from "./expenses-write.service";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { successSchema } from "../../common/openapi/response-envelopes";
import {
  expensePageDataResponseSchema,
  expenseRowSchema,
} from "./dto/expenses-response.schemas";

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
  @Validate({ query: selfExpensePageDataSchema })
  @ResponseSchema(expensePageDataResponseSchema)
  pageData(
    @Query() filters: SelfExpensePageDataInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.expenses.getPageData(
      user.orgId,
      user.userId,
      SELF_ONLY_SCOPE,
      filters,
    );
  }

  @Post()
  @HttpCode(201)
  @Validate({ body: createExpenseSchema })
  @ResponseSchema(expenseRowSchema)
  create(
    @Body() body: CreateExpenseInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.expensesWrite.create(user.orgId, user.userId, body);
  }

  @Patch(":expenseId")
  @Validate({ params: expenseIdParams, body: updateExpenseDetailsSchema })
  @ResponseSchema(successSchema)
  update(
    @Param("expenseId", ParseIntPipe) expenseId: number,
    @Body() body: UpdateExpenseDetailsInput,
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
