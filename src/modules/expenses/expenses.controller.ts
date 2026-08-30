import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
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
import { ExpenseLifecycleService } from "./expense-lifecycle.service";
import {
  createExpenseSchema,
  emailReportSchema,
  exportSchema,
  listSchema,
  pageDataSchema,
  rejectExpenseSchema,
  reportSchema,
  updateExpensePatchSchema,
  type CreateExpenseInput,
  type EmailReportInput,
  type ExportInput,
  type ListInput,
  type PageDataInput,
  type RejectExpenseInput,
  type ReportInput,
  type UpdateExpensePatchInput,
} from "./dto/expense.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { ExpenseExportService } from "./expense-export.service";
import { ExpenseExportWorkerService } from "./expense-export-worker.service";
import { pipeline } from "node:stream/promises";
import { z } from "zod";

const expenseIdParams = z.object({ expenseId: z.coerce.number().int().positive() }).strict();
const jobIdParams = z.object({ jobId: z.string().min(1) }).strict();

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
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ExpensesController {
  constructor(
    private readonly expenses: ExpensesService,
    private readonly expensesWrite: ExpensesWriteService,
    private readonly lifecycle: ExpenseLifecycleService,
    private readonly access: AccessService,
    private readonly exportJobs: ExpenseExportService,
    private readonly exportWorker: ExpenseExportWorkerService,
  ) {}

  private async canApprove(u: CurrentUserContext): Promise<boolean> {
    if (u.isOrgOwner) return true;
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    return perms.has("hr:expenses:approve");
  }

  @Get()
  @RequirePermission("hr:expenses:view")
  async list(
    @Query(new ZodValidationPipe(listSchema)) filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expenses.list(u.orgId, u.userId, await this.canApprove(u), filters);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:expenses:create")
  async create(
    @Body(new ZodValidationPipe(createExpenseSchema)) body: CreateExpenseInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expensesWrite.create(u.orgId, u.userId, body);
  }

  @Patch(":expenseId")
  @RequirePermission("hr:expenses:approve")
  @Validate({ params: expenseIdParams })
  async update(
    @Param("expenseId", ParseIntPipe) expenseId: number,
    @Body(new ZodValidationPipe(updateExpensePatchSchema)) body: UpdateExpensePatchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expensesWrite.update(u, await this.canApprove(u), expenseId, body);
  }

  @Post("email-report")
  @HttpCode(200)
  @RequirePermission("hr:expenses:approve")
  async emailReport(
    @Body(new ZodValidationPipe(emailReportSchema)) body: EmailReportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expensesWrite.emailReport(u.orgId, u.userId, true, body);
  }

  @Get("page-data")
  @RequirePermission("hr:expenses:view")
  async pageData(
    @Query(new ZodValidationPipe(pageDataSchema)) filters: PageDataInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expenses.getPageData(u.orgId, u.userId, await this.canApprove(u), filters);
  }

  @Get("report")
  @RequirePermission("hr:expenses:read")
  async report(
    @Query(new ZodValidationPipe(reportSchema)) filters: ReportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expenses.getReport(u.orgId, u.userId, await this.canApprove(u), filters);
  }

  @Get("export-data")
  @RequirePermission("hr:expenses:read")
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
  @RequirePermission("hr:expenses:read")
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

  @Post("export/jobs")
  @HttpCode(202)
  @Idempotent("expenses.export.create")
  @RequirePermission("hr:expenses:read")
  async createExportJob(
    @Body(new ZodValidationPipe(exportSchema)) filters: ExportInput,
    @Headers("idempotency-key") idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const job = await this.exportJobs.create(u, filters, idempotencyKey, await this.canApprove(u));
    this.exportWorker.wake();
    return job;
  }

  @Get("export/jobs/:jobId")
  @RequirePermission("hr:expenses:read")
  @Validate({ params: jobIdParams })
  getExportJob(@Param("jobId") jobId: string, @CurrentUser() u: CurrentUserContext) {
    return this.exportJobs.get(u, jobId);
  }

  @Get("export/jobs/:jobId/download")
  @RequirePermission("hr:expenses:read")
  @Validate({ params: jobIdParams })
  async downloadExportJob(@Param("jobId") jobId: string, @CurrentUser() u: CurrentUserContext, @Res() res: Response) {
    const { job, file } = await this.exportJobs.download(u, jobId);
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${(job.fileName ?? "expenses.csv").replace(/[^a-zA-Z0-9_.-]/g, "-")}"`);
    res.setHeader("Cache-Control", "private, no-store");
    if (file.contentLength !== undefined) res.setHeader("Content-Length", String(file.contentLength));
    await pipeline(file.body, res);
  }

  @Post(":expenseId/submit")
  @Idempotent("expenses.expense.submit")
  @HttpCode(200)
  @RequirePermission("hr:expenses:create")
  @Validate({ params: expenseIdParams })
  async submit(
    @Param("expenseId", ParseIntPipe) expenseId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.lifecycle.submitExpense(u, expenseId);
  }

  @Post(":expenseId/approve")
  @Idempotent("expenses.expense.approve")
  @HttpCode(200)
  @RequirePermission("hr:expenses:approve")
  @Validate({ params: expenseIdParams })
  async approve(
    @Param("expenseId", ParseIntPipe) expenseId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.lifecycle.approveExpense(u, expenseId);
  }

  @Post(":expenseId/reject")
  @Idempotent("expenses.expense.reject")
  @HttpCode(200)
  @RequirePermission("hr:expenses:approve")
  @Validate({ params: expenseIdParams })
  async reject(
    @Param("expenseId", ParseIntPipe) expenseId: number,
    @Body(new ZodValidationPipe(rejectExpenseSchema)) body: RejectExpenseInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const reason = body.rejectionReason?.trim() || "No reason provided";
    return this.lifecycle.rejectExpense(u, expenseId, reason);
  }

  @Delete(":expenseId")
  @RequirePermission("hr:expenses:create")
  @Validate({ params: expenseIdParams })
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
