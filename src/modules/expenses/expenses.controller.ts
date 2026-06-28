import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { defineAbilityFor } from "../../common/rbac/abilities.factory";
import { ExpensesService } from "./expenses.service";
import { ExpensesWriteService } from "./expenses-write.service";
import {
  createExpenseSchema,
  emailReportSchema,
  exportSchema,
  listSchema,
  pageDataSchema,
  reportSchema,
  type CreateExpenseInput,
  type EmailReportInput,
  type ExportInput,
  type ListInput,
  type PageDataInput,
  type ReportInput,
} from "./dto/expense.schemas";

function canApprove(u: CurrentUserContext): boolean {
  const ability = defineAbilityFor({
    isPlatformAdmin: u.isPlatformAdmin,
    isOrgOwner: u.isOrgOwner,
    permissions: u.permissions,
    enabledModules: u.enabledModules,
  });
  return ability.can("approve", "hr:expenses");
}

const EXPORT_HEADERS = [
  "Date",
  "Employee",
  "Email",
  "Category",
  "Amount",
  "Description",
  "Status",
  "Rejection Reason",
] as const;

@Controller("hr/expenses")
@UseGuards(JwtAuthGuard)
export class ExpensesController {
  constructor(
    private readonly expenses: ExpensesService,
    private readonly expensesWrite: ExpensesWriteService,
  ) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(listSchema)) filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expenses.list(u.orgId, u.userId, canApprove(u), filters);
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createExpenseSchema)) body: CreateExpenseInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expensesWrite.create(u.orgId, u.userId, canApprove(u), body);
  }

  @Patch(":expenseId")
  update(
    @Param("expenseId", ParseIntPipe) expenseId: number,
    @Body() body: unknown,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expensesWrite.update(u, canApprove(u), expenseId, body);
  }

  @Post("email-report")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:expenses:read")
  emailReport(
    @Body(new ZodValidationPipe(emailReportSchema)) body: EmailReportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!canApprove(u)) {
      throw new BadRequestException("Only HR and CEO can send expense reports");
    }
    return this.expensesWrite.emailReport(u.orgId, u.userId, true, body);
  }

  @Get("page-data")
  pageData(
    @Query(new ZodValidationPipe(pageDataSchema)) filters: PageDataInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expenses.getPageData(u.orgId, u.userId, canApprove(u), filters);
  }

  @Get("report")
  report(
    @Query(new ZodValidationPipe(reportSchema)) filters: ReportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expenses.getReport(u.orgId, u.userId, canApprove(u), filters);
  }

  @Get("export")
  async export(
    @Query(new ZodValidationPipe(exportSchema)) filters: ExportInput,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const data = await this.expenses.getExportRows(
      u.orgId,
      { userId: u.userId, isAdmin: canApprove(u) },
      filters,
    );

    const rows = data.map((r) => [
      r.expenseDate,
      r.userName || "",
      r.userEmail || "",
      r.category || "",
      r.amount || "0",
      r.description || "",
      r.status || "",
      r.rejectionReason || "",
    ]);

    const csv = [[...EXPORT_HEADERS], ...rows]
      .map((row) => row.map((val) => `"${String(val ?? "").replace(/"/g, '""')}"`).join(","))
      .join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="expenses-${new Date().toISOString().split("T")[0]}.csv"`,
    );
    res.send(csv);
  }

  @Delete(":expenseId")
  async remove(
    @Param("expenseId", ParseIntPipe) expenseId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.expenses.remove(
      u.orgId,
      { userId: u.userId, isAdmin: canApprove(u) },
      expenseId,
    );
    if ("error" in result) {
      if (result.error === "not_found") throw new NotFoundException("Expense not found.");
      if (result.error === "forbidden") {
        throw new ForbiddenException("Not authorized to delete this expense.");
      }
      throw new BadRequestException("Paid expenses cannot be deleted.");
    }
    return result;
  }
}
