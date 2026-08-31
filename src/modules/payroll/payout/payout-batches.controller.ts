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
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { PayoutBatchesService } from "./payout-batches.service";
import { BatchCreatorService } from "./batch-creator.service";
import { BatchStatusService } from "./batch-status.service";
import { PayoutValidationService } from "./payout-validation.service";
import {
  batchDetailQuerySchema,
  batchesQuerySchema,
  createBatchSchema,
  markBatchPaidSchema,
  markItemFailedSchema,
  markItemPaidSchema,
  bankReturnImportSchema,
  type BatchDetailQueryInput,
  type BatchesQueryInput,
  type CreateBatchInput,
  type MarkBatchPaidInput,
  type MarkItemFailedInput,
  type MarkItemPaidInput,
  type BankReturnImportInput,
} from "./dto/payout.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
import { z } from "zod";

const runIdParams = z.object({ runId: z.coerce.number().int().positive() }).strict();
const batchIdParams = z.object({ batchId: z.coerce.number().int().positive() }).strict();
const batchItemIdParams = z.object({ batchId: z.coerce.number().int().positive(), itemId: z.coerce.number().int().positive() }).strict();
const employeeUserIdParams = z.object({ employeeUserId: z.string().min(1) }).strict();

@RequireModule("payroll")
@Controller("payroll/runs/:runId/payout")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class PayoutRunController {
  constructor(
    private readonly batchCreator: BatchCreatorService,
    private readonly validation: PayoutValidationService,
  ) {}

  @Get("validation")
  @RequirePermission("payroll:bank:manage")
  @Validate({ params: runIdParams })
  validate(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.validation.validatePayout(u.orgId, runId);
  }

  @Post("batches")
  @HttpCode(201)
  @RequirePermission("payroll:bank:manage")
  @Validate({ params: runIdParams, body: createBatchSchema })
  createBatch(
    @Param("runId", ParseIntPipe) runId: number,
    @Body() body: CreateBatchInput,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.batchCreator.createBatch(u.orgId, runId, u.userId, idempotencyKey, body.format);
  }
}

@RequireModule("payroll")
@Controller("payroll/payout")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class PayoutBatchesController {
  constructor(
    private readonly batches: PayoutBatchesService,
    private readonly batchStatus: BatchStatusService,
  ) {}

  @Get("batches")
  @RequirePermission("payroll:bank:manage")
  @Validate({ query: batchesQuerySchema })
  listBatches(
    @Query() query: BatchesQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.batches.listBatches(u.orgId, query.runId, query.cursor, query.limit);
  }

  @Get("batches/:batchId")
  @RequirePermission("payroll:bank:manage")
  @Validate({ params: batchIdParams, query: batchDetailQuerySchema })
  getBatch(
    @Param("batchId", ParseIntPipe) batchId: number,
    @Query() query: BatchDetailQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.batches.getBatch(u.orgId, batchId, query.itemCursor, query.itemLimit);
  }

  @Get("batches/:batchId/file")
  @RequirePermission("payroll:bank:manage")
  @Validate({ params: batchIdParams })
  getBatchFile(
    @Param("batchId", ParseIntPipe) batchId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.batches.getFile(u.orgId, batchId);
  }

  @Post("batches/:batchId/mark-sent")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("payroll:bank:manage")
  @Validate({ params: batchIdParams })
  markSent(
    @Param("batchId", ParseIntPipe) batchId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.batchStatus.markSent(u.orgId, batchId, u.userId);
  }

  @Post("batches/:batchId/mark-paid")
  @HttpCode(200)
  @RequirePermission("payroll:bank:manage")
  @Validate({ params: batchIdParams, body: markBatchPaidSchema })
  markBatchPaid(
    @Param("batchId", ParseIntPipe) batchId: number,
    @Body() body: MarkBatchPaidInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.batchStatus.markBatchPaid(u.orgId, batchId, body.transactionRef, u.userId);
  }

  @Post("batches/:batchId/import-return")
  @HttpCode(200)
  @RequirePermission("payroll:bank:manage")
  @Idempotent("payroll.bank-return.import")
  @Validate({ params: batchIdParams, body: bankReturnImportSchema })
  importReturn(
    @Param("batchId", ParseIntPipe) batchId: number,
    @Body() body: BankReturnImportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.batchStatus.importBankReturn(u.orgId, batchId, u.userId, body.csv);
  }

  @Post("batches/:batchId/items/:itemId/mark-paid")
  @HttpCode(200)
  @RequirePermission("payroll:bank:manage")
  @Validate({ params: batchItemIdParams, body: markItemPaidSchema })
  markItemPaid(
    @Param("batchId", ParseIntPipe) batchId: number,
    @Param("itemId", ParseIntPipe) itemId: number,
    @Body() body: MarkItemPaidInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.batchStatus.markItemPaid(u.orgId, batchId, itemId, body.transactionRef, u.userId);
  }

  @Post("batches/:batchId/items/:itemId/mark-failed")
  @HttpCode(200)
  @RequirePermission("payroll:bank:manage")
  @Validate({ params: batchItemIdParams, body: markItemFailedSchema })
  markItemFailed(
    @Param("batchId", ParseIntPipe) batchId: number,
    @Param("itemId", ParseIntPipe) itemId: number,
    @Body() body: MarkItemFailedInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.batchStatus.markItemFailed(u.orgId, batchId, itemId, body.failureReason, u.userId);
  }
}

@RequireModule("payroll")
@Controller("payroll/employees/:employeeUserId")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class PayoutEmployeeBankController {
  constructor(private readonly batches: PayoutBatchesService) {}

  @Get("bank")
  @RequirePermission("payroll:bank:view")
  @Validate({ params: employeeUserIdParams })
  getBankDetails(
    @Param("employeeUserId") employeeUserId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.batches.getBankDetails(u.orgId, employeeUserId, u.userId);
  }
}
