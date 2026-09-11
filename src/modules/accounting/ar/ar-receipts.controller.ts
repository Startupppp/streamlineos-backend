import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { ArReceiptsService } from "./ar-receipts.service";
import {
  allocateFifoSchema,
  allocateReceiptSchema,
  createReceiptSchema,
  listReceiptsSchema,
  reverseReceiptSchema,
  type AllocateFifoInput,
  type AllocateReceiptInput,
  type CreateReceiptInput,
  type ListReceiptsQuery,
  type ReverseReceiptInput,
} from "./dto/ar-receipts.schemas";

@RequireModule("accounting")
@Controller("accounting/ar/receipts")
@UseGuards(JwtAuthGuard)
export class ArReceiptsController {
  constructor(private readonly receipts: ArReceiptsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:receivables:read")
  list(
    @Query(new ZodValidationPipe(listReceiptsSchema)) query: ListReceiptsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.receipts.list(u.orgId, query);
  }

  /** Recording a receipt posts it — cash either arrived or it did not. */
  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:receivables:manage")
  @HttpCode(201)
  @Idempotent("accounting.ar.receipt.post")
  create(
    @Body(new ZodValidationPipe(createReceiptSchema)) body: CreateReceiptInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.receipts.postReceipt(u.orgId, u.userId, body);
  }

  @Get(":receiptId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:receivables:read")
  get(@Param("receiptId") receiptId: string, @CurrentUser() u: CurrentUserContext) {
    return this.receipts.get(u.orgId, receiptId);
  }

  @Post(":receiptId/allocations")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:receivables:manage")
  @HttpCode(200)
  @Idempotent("accounting.ar.receipt.allocate")
  allocate(
    @Param("receiptId") receiptId: string,
    @Body(new ZodValidationPipe(allocateReceiptSchema)) body: AllocateReceiptInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.receipts.allocate(u.orgId, u.userId, receiptId, body);
  }

  @Post(":receiptId/allocations/fifo")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:receivables:manage")
  @HttpCode(200)
  allocateFifo(
    @Param("receiptId") receiptId: string,
    @Body(new ZodValidationPipe(allocateFifoSchema)) body: AllocateFifoInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.receipts.allocateFifo(u.orgId, u.userId, receiptId, body);
  }

  /**
   * Reversal unwinds every allocation and posts the mirror journal. It is the
   * only destructive operation in AR, so it sits on the approval rung.
   */
  @Post(":receiptId/reverse")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:receivables:approve")
  @HttpCode(200)
  @Idempotent("accounting.ar.receipt.reverse")
  reverse(
    @Param("receiptId") receiptId: string,
    @Body(new ZodValidationPipe(reverseReceiptSchema)) body: ReverseReceiptInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.receipts.reverseReceipt(u.orgId, u.userId, receiptId, body);
  }
}
