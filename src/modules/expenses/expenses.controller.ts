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
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AccessService } from "../access/access.service";
import { EmploymentFactsService } from "../directory/employment-facts.service";
import { readRequestScopedRead } from "../organization/core/read-request-scope";
import {
  canReadOthersExpenses,
  resolveExpenseReadScope,
  type ExpenseRead,
} from "./expenses-scope";
import { ExpensesService } from "./expenses.service";
import { ExpensesWriteService } from "./expenses-write.service";
import { ExpenseLifecycleService } from "./expense-lifecycle.service";
import {
  createExpenseSchema,
  exportSchema,
  listSchema,
  pageDataSchema,
  rejectExpenseSchema,
  reportSchema,
  updateExpensePatchSchema,
  type CreateExpenseInput,
  type ExportInput,
  type ListInput,
  type PageDataInput,
  type RejectExpenseInput,
  type ReportInput,
  type UpdateExpensePatchInput,
} from "./dto/expense.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { ExpenseExportService } from "./expense-export.service";
import { pipeline } from "node:stream/promises";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { ApiOkResponse } from "@nestjs/swagger";
import {
  expenseApproveResponseSchema,
  expenseExportJobViewSchema,
  expenseImportResultSchema,
  expenseListResponseSchema,
  expensePageDataResponseSchema,
  expenseReportResponseSchema,
  expenseRowSchema,
  expenseSubmitResponseSchema,
} from "./dto/expenses-response.schemas";
import { successSchema } from "../../common/openapi/response-envelopes";

const expenseIdParams = z.object({ expenseId: z.coerce.number().int().positive() }).strict();
const jobIdParams = z.object({ jobId: z.string().uuid() }).strict();

@RequireModule("accounting")
@Controller("hr/expenses")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ExpensesController {
  constructor(
    private readonly expenses: ExpensesService,
    private readonly expensesWrite: ExpensesWriteService,
    private readonly lifecycle: ExpenseLifecycleService,
    private readonly access: AccessService,
    private readonly employment: EmploymentFactsService,
    private readonly exportJobs: ExpenseExportService,
  ) {}

  private readScope(u: CurrentUserContext): Promise<ExpenseRead> {
    return resolveExpenseReadScope(this.access, this.employment, u);
  }

  private async canApprove(u: CurrentUserContext): Promise<boolean> {
    return canReadOthersExpenses(await this.readScope(u));
  }

  @Get()
  @RequirePermission("hr:expenses:view")
  @Validate({ query: listSchema })
  @ResponseSchema(expenseListResponseSchema)
  async list(
    @Query() filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expenses.list(await this.readScope(u), filters);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:expenses:create")
  @Validate({ body: createExpenseSchema })
  @ResponseSchema(expenseRowSchema)
  async create(
    @Body() body: CreateExpenseInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expensesWrite.create(u.orgId, u.userId, body);
  }

  @Patch(":expenseId")
  @RequirePermission("hr:expenses:approve")
  @Validate({ params: expenseIdParams, body: updateExpensePatchSchema })
  @ResponseSchema(successSchema)
  async update(
    @Param("expenseId", ParseIntPipe) expenseId: number,
    @Body() body: UpdateExpensePatchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expensesWrite.update(u, await this.canApprove(u), expenseId, body);
  }

  @Post("email-report")
  @HttpCode(202)
  @Idempotent("expenses.email-report.create")
  @RequirePermission("hr:expenses:approve")
  @Validate({ body: exportSchema })
  @ResponseSchema(expenseExportJobViewSchema)
  async emailReport(
    @Body() filters: ExportInput,
    @Headers("idempotency-key") idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    const read = readRequestScopedRead(req, u);
    return this.exportJobs.create(
      u,
      filters,
      idempotencyKey,
      read.rawScope("export filters are persisted on the job row for a background worker to replay outside the request"),
    );
  }

  @Get("page-data")
  @RequirePermission("hr:expenses:view")
  @Validate({ query: pageDataSchema })
  @ResponseSchema(expensePageDataResponseSchema)
  async pageData(
    @Query() filters: PageDataInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expenses.getPageData(await this.readScope(u), filters);
  }

  @Get("report")
  @RequirePermission("hr:expenses:read")
  @Validate({ query: reportSchema })
  @ResponseSchema(expenseReportResponseSchema)
  async report(
    @Query() filters: ReportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expenses.getReport(await this.readScope(u), filters);
  }

  @Post("export/jobs")
  @HttpCode(202)
  @Idempotent("expenses.export.create")
  @RequirePermission("hr:expenses:read")
  @Validate({ body: exportSchema })
  @ResponseSchema(expenseExportJobViewSchema)
  async createExportJob(
    @Body() filters: ExportInput,
    @Headers("idempotency-key") idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    const read = readRequestScopedRead(req, u);
    return this.exportJobs.create(
      u,
      filters,
      idempotencyKey,
      read.rawScope("export filters are persisted on the job row for a background worker to replay outside the request"),
    );
  }

  @Get("export/jobs/:jobId")
  @RequirePermission("hr:expenses:read")
  @Validate({ params: jobIdParams })
  @ResponseSchema(expenseExportJobViewSchema)
  getExportJob(@Param("jobId") jobId: string, @CurrentUser() u: CurrentUserContext) {
    return this.exportJobs.get(u, jobId);
  }

  @Get("export/jobs/:jobId/download")
  @RequirePermission("hr:expenses:read")
  @Validate({ params: jobIdParams })
  @ApiOkResponse({ description: "CSV download", content: { "text/csv": { schema: { type: "string", format: "binary" } } } })
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
  @BodylessAction()
  @ResponseSchema(expenseSubmitResponseSchema)
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
  @BodylessAction()
  @ResponseSchema(expenseApproveResponseSchema)
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
  @Validate({ params: expenseIdParams, body: rejectExpenseSchema })
  @ResponseSchema(successSchema)
  async reject(
    @Param("expenseId", ParseIntPipe) expenseId: number,
    @Body() body: RejectExpenseInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const reason = body.rejectionReason?.trim() || "No reason provided";
    return this.lifecycle.rejectExpense(u, expenseId, reason);
  }

  @Delete(":expenseId")
  @RequirePermission("hr:expenses:create")
  @Validate({ params: expenseIdParams })
  @ResponseSchema(successSchema)
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
