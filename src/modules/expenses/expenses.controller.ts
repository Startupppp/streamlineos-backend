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
import type { DataScope } from "../access/access.types";
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
import { ExpenseExportService } from "./expense-export.service";
import { pipeline } from "node:stream/promises";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";

const expenseIdParams = z.object({ expenseId: z.coerce.number().int().positive() }).strict();
const jobIdParams = z.object({ jobId: z.string().min(1) }).strict();

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
  ) {}

  private async canApprove(u: CurrentUserContext): Promise<boolean> {
    if (u.isOrgOwner) return true;
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    return perms.has("hr:expenses:approve");
  }

  @Get()
  @RequirePermission("hr:expenses:view")
  @Validate({ query: listSchema })
  async list(
    @Query() filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expenses.list(u.orgId, u.userId, await this.canApprove(u), filters);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:expenses:create")
  @Validate({ body: createExpenseSchema })
  async create(
    @Body() body: CreateExpenseInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expensesWrite.create(u.orgId, u.userId, body);
  }

  @Patch(":expenseId")
  @RequirePermission("hr:expenses:approve")
  @Validate({ params: expenseIdParams, body: updateExpensePatchSchema })
  async update(
    @Param("expenseId", ParseIntPipe) expenseId: number,
    @Body() body: UpdateExpensePatchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expensesWrite.update(u, await this.canApprove(u), expenseId, body);
  }

  @Post("email-report")
  @HttpCode(200)
  @RequirePermission("hr:expenses:approve")
  @Validate({ body: emailReportSchema })
  async emailReport(
    @Body() body: EmailReportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expensesWrite.emailReport(u.orgId, u.userId, true, body);
  }

  @Get("page-data")
  @RequirePermission("hr:expenses:view")
  @Validate({ query: pageDataSchema })
  async pageData(
    @Query() filters: PageDataInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expenses.getPageData(u.orgId, u.userId, await this.canApprove(u), filters);
  }

  @Get("report")
  @RequirePermission("hr:expenses:read")
  @Validate({ query: reportSchema })
  async report(
    @Query() filters: ReportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.expenses.getReport(u.orgId, u.userId, await this.canApprove(u), filters);
  }

  @Post("export/jobs")
  @HttpCode(202)
  @Idempotent("expenses.export.create")
  @RequirePermission("hr:expenses:read")
  @Validate({ body: exportSchema })
  async createExportJob(
    @Body() filters: ExportInput,
    @Headers("idempotency-key") idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request & { rbacScope?: DataScope },
  ) {
    const scope: DataScope = req.rbacScope ?? "none";
    return this.exportJobs.create(u, filters, idempotencyKey, scope);
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
  @BodylessAction()
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
