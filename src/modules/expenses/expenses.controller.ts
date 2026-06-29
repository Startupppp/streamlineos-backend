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
import { AccessService } from "../access/access.service";
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
import { RequireModule } from "../../common/rbac/require-module.decorator";

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

@RequireModule("accounting")
@Controller("hr/expenses")
@UseGuards(JwtAuthGuard)
export class ExpensesController {
  constructor(
    private readonly expenses: ExpensesService,
    private readonly expensesWrite: ExpensesWriteService,
    private readonly access: AccessService,
  ) {}

  private async canApprove(u: CurrentUserContext): Promise<boolean> {
    if (u.isOrgOwner || u.isPlatformAdmin) return true;
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    return perms.has("hr:expenses:approve");
  }

  @Get()
  async list(
    @Query(new ZodValidationPipe(listSchema)) filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expenses.list(u.orgId, u.userId, await this.canApprove(u), filters);
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body(new ZodValidationPipe(createExpenseSchema)) body: CreateExpenseInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expensesWrite.create(u.orgId, u.userId, await this.canApprove(u), body);
  }

  @Patch(":expenseId")
  async update(
    @Param("expenseId", ParseIntPipe) expenseId: number,
    @Body() body: unknown,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expensesWrite.update(u, await this.canApprove(u), expenseId, body);
  }

  @Post("email-report")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:expenses:read")
  async emailReport(
    @Body(new ZodValidationPipe(emailReportSchema)) body: EmailReportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!(await this.canApprove(u))) {
      throw new BadRequestException("Only HR and CEO can send expense reports");
    }
    return this.expensesWrite.emailReport(u.orgId, u.userId, true, body);
  }

  @Get("page-data")
  async pageData(
    @Query(new ZodValidationPipe(pageDataSchema)) filters: PageDataInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expenses.getPageData(u.orgId, u.userId, await this.canApprove(u), filters);
  }

  @Get("report")
  async report(
    @Query(new ZodValidationPipe(reportSchema)) filters: ReportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expenses.getReport(u.orgId, u.userId, await this.canApprove(u), filters);
  }

  @Get("export-data")
  async exportData(
    @Query(new ZodValidationPipe(exportSchema)) filters: ExportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expenses.getExportRows(
      u.orgId,
      { userId: u.userId, isAdmin: await this.canApprove(u) },
      filters,
    );
  }

  @Get("export")
  async export(
    @Query(new ZodValidationPipe(exportSchema)) filters: ExportInput,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const data = await this.expenses.getExportRows(
      u.orgId,
      { userId: u.userId, isAdmin: await this.canApprove(u) },
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
      { userId: u.userId, isAdmin: await this.canApprove(u) },
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
