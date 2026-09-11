import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { ApPaymentsService } from "./ap-payments.service";
import {
  allocateDebitNoteSchema,
  allocatePaymentSchema,
  listApPaymentsQuerySchema,
  postApPaymentSchema,
  reversePaymentSchema,
  type AllocateDebitNoteInput,
  type AllocatePaymentInput,
  type ListApPaymentsQuery,
  type PostApPaymentInput,
  type ReversePaymentInput,
} from "./dto/ap-payments.schemas";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  allocateApPaymentResponseSchema,
  allocateDebitNoteResponseSchema,
  getApPaymentResponseSchema,
  listApPaymentsResponseSchema,
  postApPaymentResponseSchema,
  reverseApPaymentResponseSchema,
} from "./dto/ap-response.schemas";

@RequireModule("accounting")
@Controller("accounting/payables")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class ApPaymentsController {
  constructor(private readonly payments: ApPaymentsService) {}

  @Get("payments")
  @ResponseSchema(listApPaymentsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payables:read")
  list(
    @Query(new ZodValidationPipe(listApPaymentsQuerySchema)) query: ListApPaymentsQuery,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.payments.list(user.orgId, query);
  }

  @Get("payments/:paymentId")
  @ResponseSchema(getApPaymentResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payables:read")
  get(@Param("paymentId") paymentId: string, @CurrentUser() user: CurrentUserContext) {
    return this.payments.get(user.orgId, paymentId);
  }

  @Post("payments")
  @ResponseSchema(postApPaymentResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payables:manage")
  @HttpCode(201)
  @Idempotent("accounting.payables.payment.post")
  postPayment(
    @Body(new ZodValidationPipe(postApPaymentSchema)) body: PostApPaymentInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.payments.postPayment(user.orgId, user.userId, body);
  }

  @Post("payments/:paymentId/allocations")
  @ResponseSchema(allocateApPaymentResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payables:manage")
  @HttpCode(200)
  @Idempotent("accounting.payables.payment.allocate")
  allocate(
    @Param("paymentId") paymentId: string,
    @Body(new ZodValidationPipe(allocatePaymentSchema)) body: AllocatePaymentInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.payments.allocate(user.orgId, user.userId, paymentId, body);
  }

  /** Apply a posted debit note against open bills. No journal — see the service. */
  @Post("debit-notes/:debitNoteId/allocations")
  @ResponseSchema(allocateDebitNoteResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:vendor-credits:manage")
  @HttpCode(200)
  allocateDebitNote(
    @Param("debitNoteId") debitNoteId: string,
    @Body(new ZodValidationPipe(allocateDebitNoteSchema)) body: AllocateDebitNoteInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.payments.allocateDebitNote(user.orgId, user.userId, debitNoteId, body);
  }

  @Post("payments/:paymentId/reverse")
  @ResponseSchema(reverseApPaymentResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payables:approve")
  @HttpCode(200)
  @Idempotent("accounting.payables.payment.reverse")
  reverse(
    @Param("paymentId") paymentId: string,
    @Body(new ZodValidationPipe(reversePaymentSchema)) body: ReversePaymentInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.payments.reversePayment(user.orgId, user.userId, paymentId, body);
  }
}
