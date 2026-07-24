import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { PayoutBatchesService } from "./payout-batches.service";
import { PayoutValidationService } from "./payout-validation.service";
import {
  batchesQuerySchema,
  createBatchSchema,
  markBatchPaidSchema,
  markItemFailedSchema,
  markItemPaidSchema,
  bankReturnImportSchema,
  type BatchesQueryInput,
  type CreateBatchInput,
  type MarkBatchPaidInput,
  type MarkItemFailedInput,
  type MarkItemPaidInput,
  type BankReturnImportInput,
} from "./dto/payout.schemas";

@Controller("payroll/runs/:runId/payout")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PayoutRunController {
  constructor(
    private readonly batches: PayoutBatchesService,
    private readonly validation: PayoutValidationService,
  ) {}

  @Get("validation")
  @RequirePermission("payroll:bank:manage")
  validate(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.validation.validatePayout(u.orgId, runId);
  }

  @Post("batches")
  @HttpCode(201)
  @RequirePermission("payroll:bank:manage")
  createBatch(
    @Param("runId", ParseIntPipe) runId: number,
    @Body(new ZodValidationPipe(createBatchSchema)) body: CreateBatchInput,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.batches.createBatch(u.orgId, runId, u.userId, idempotencyKey, body.format);
  }
}

@Controller("payroll/payout")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PayoutBatchesController {
  constructor(private readonly batches: PayoutBatchesService) {}

  @Get("batches")
  @RequirePermission("payroll:bank:manage")
  listBatches(
    @Query(new ZodValidationPipe(batchesQuerySchema)) query: BatchesQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.batches.listBatches(u.orgId, query.runId);
  }

  @Get("batches/:batchId")
  @RequirePermission("payroll:bank:manage")
  getBatch(
    @Param("batchId", ParseIntPipe) batchId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.batches.getBatch(u.orgId, batchId);
  }

  @Get("batches/:batchId/file")
  @RequirePermission("payroll:bank:manage")
  getBatchFile(
    @Param("batchId", ParseIntPipe) batchId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.batches.getFile(u.orgId, batchId);
  }

  @Post("batches/:batchId/mark-sent")
  @HttpCode(200)
  @RequirePermission("payroll:bank:manage")
  markSent(
    @Param("batchId", ParseIntPipe) batchId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.batches.markSent(u.orgId, batchId, u.userId);
  }

  @Post("batches/:batchId/mark-paid")
  @HttpCode(200)
  @RequirePermission("payroll:bank:manage")
  markBatchPaid(
    @Param("batchId", ParseIntPipe) batchId: number,
    @Body(new ZodValidationPipe(markBatchPaidSchema)) body: MarkBatchPaidInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.batches.markBatchPaid(u.orgId, batchId, body.transactionRef, u.userId);
  }

  /**
   * Import bank return/ack CSV (manual). Does not call bank APIs.
   * Columns: itemId|userId, status, transactionRef, failureReason
   */
  @Post("batches/:batchId/import-return")
  @HttpCode(200)
  @RequirePermission("payroll:bank:manage")
  importReturn(
    @Param("batchId", ParseIntPipe) batchId: number,
    @Body(new ZodValidationPipe(bankReturnImportSchema)) body: BankReturnImportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.batches.importBankReturn(u.orgId, batchId, u.userId, body.csv);
  }

  @Post("batches/:batchId/items/:itemId/mark-paid")
  @HttpCode(200)
  @RequirePermission("payroll:bank:manage")
  markItemPaid(
    @Param("batchId", ParseIntPipe) batchId: number,
    @Param("itemId", ParseIntPipe) itemId: number,
    @Body(new ZodValidationPipe(markItemPaidSchema)) body: MarkItemPaidInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.batches.markItemPaid(u.orgId, batchId, itemId, body.transactionRef, u.userId);
  }

  @Post("batches/:batchId/items/:itemId/mark-failed")
  @HttpCode(200)
  @RequirePermission("payroll:bank:manage")
  markItemFailed(
    @Param("batchId", ParseIntPipe) batchId: number,
    @Param("itemId", ParseIntPipe) itemId: number,
    @Body(new ZodValidationPipe(markItemFailedSchema)) body: MarkItemFailedInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.batches.markItemFailed(u.orgId, batchId, itemId, body.failureReason, u.userId);
  }
}

@Controller("payroll/employees/:employeeUserId")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PayoutEmployeeBankController {
  constructor(private readonly batches: PayoutBatchesService) {}

  @Get("bank")
  @RequirePermission("payroll:bank:view")
  getBankDetails(
    @Param("employeeUserId") employeeUserId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.batches.getBankDetails(u.orgId, employeeUserId, u.userId);
  }
}
