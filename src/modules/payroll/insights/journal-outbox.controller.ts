import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  HttpCode,
  ParseIntPipe,
  UseGuards,
  ForbiddenException,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { AccessService } from "../../access/access.service";
import { authorize } from "../../access/authorize";
import { JournalOutboxService } from "./journal-outbox.service";
import { PeriodReconciliationService } from "./period-reconciliation.service";
import { buildCsv } from "./lib/csv";
import {
  journalBatchCreateSchema,
  journalBatchReverseSchema,
  journalBatchReconcileSchema,
  journalBatchListQuerySchema,
  periodReconQuerySchema,
  type JournalBatchCreate,
  type JournalBatchReverse,
  type JournalBatchReconcile,
  type JournalBatchListQuery,
  type PeriodReconQuery,
} from "./dto/insights.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const batchIdParams = z.object({ batchId: z.coerce.number().int().positive() }).strict();

const CSV_HEADERS = ["lineNo", "account", "description", "debit", "credit", "costCenter"] as const;

@RequireModule("payroll")
@Controller("payroll/accounting/journal-batches")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class JournalOutboxController {
  constructor(
    private readonly outbox: JournalOutboxService,
    private readonly periodRecon: PeriodReconciliationService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @RequirePermission("payroll:accounting:view")
  async list(
    @Query(new ZodValidationPipe(journalBatchListQuerySchema)) query: JournalBatchListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.outbox.list(u.orgId, query);
  }

  /**
   * Period recon: run net ↔ payout paid ↔ journal outbox (manual/export honesty).
   * Must be registered before :batchId routes.
   */
  @Get("period-reconciliation")
  @RequirePermission("payroll:accounting:view")
  async periodReconciliation(
    @Query(new ZodValidationPipe(periodReconQuerySchema)) query: PeriodReconQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.periodRecon.getPeriodReconciliation(u.orgId, query.periodKey);
  }

  @Get(":batchId")
  @RequirePermission("payroll:accounting:view")
  @Validate({ params: batchIdParams })
  async get(
    @Param("batchId", ParseIntPipe) batchId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.outbox.get(u.orgId, batchId);
  }

  @Get(":batchId/export")
  @RequirePermission("payroll:accounting:view")
  @Validate({ params: batchIdParams })
  async exportCsv(
    @Param("batchId", ParseIntPipe) batchId: number,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const exportCheck = await authorize(this.access, u, "payroll:reports:export");
    if (!exportCheck.allow) {
      throw new ForbiddenException("Permission denied: payroll:reports:export required");
    }

    const batch = await this.outbox.get(u.orgId, batchId);
    const rows = batch.lines.map((line) => [
      String(line.lineNo),
      line.account,
      line.description,
      line.debit,
      line.credit,
      line.costCenter,
    ]);

    await this.outbox.markExported(u.orgId, u.userId, batchId);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="journal-batch-${batch.periodKey}-v${batch.version}.csv"`,
    );

    return buildCsv([...CSV_HEADERS], rows);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("payroll:accounting:manage")
  async create(
    @Body(new ZodValidationPipe(journalBatchCreateSchema)) body: JournalBatchCreate,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.outbox.createBatch(u.orgId, u.userId, body);
  }

  @Post(":batchId/post")
  @RequirePermission("payroll:accounting:manage")
  @Validate({ params: batchIdParams })
  async post(
    @Param("batchId", ParseIntPipe) batchId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.outbox.markPosted(u.orgId, u.userId, batchId);
  }

  @Post(":batchId/reverse")
  @RequirePermission("payroll:accounting:manage")
  @Validate({ params: batchIdParams })
  async reverse(
    @Param("batchId", ParseIntPipe) batchId: number,
    @Body(new ZodValidationPipe(journalBatchReverseSchema)) body: JournalBatchReverse,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.outbox.reverseBatch(u.orgId, u.userId, batchId, body.reason);
  }

  @Post(":batchId/reconcile")
  @RequirePermission("payroll:accounting:manage")
  @Validate({ params: batchIdParams })
  async reconcile(
    @Param("batchId", ParseIntPipe) batchId: number,
    @Body(new ZodValidationPipe(journalBatchReconcileSchema)) body: JournalBatchReconcile,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.outbox.reconcile(u.orgId, u.userId, batchId, body);
  }
}
