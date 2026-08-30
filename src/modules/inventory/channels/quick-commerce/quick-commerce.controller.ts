import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  ParseIntPipe,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../../common/rbac/module.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { IdempotencyKey } from "../../../../common/idempotency/idempotency-key.decorator";
import { QuickCommerceInboundService } from "./quick-commerce-inbound.service";
import { FillRateService } from "./fill-rate.service";
import {
  acceptPlatformPoSchema,
  createAsnSchema,
  ingestPlatformPoSchema,
  listAsnsQuerySchema,
  listPlatformPosQuerySchema,
  fillRateQuerySchema,
  uploadPayoutSchema,
} from "./dto/quick-commerce.schemas";
import type {
  AcceptPlatformPoInput,
  CreateAsnInput,
  IngestPlatformPoInput,
  ListAsnsQuery,
  ListPlatformPosQuery,
  FillRateQuery,
  UploadPayoutInput,
} from "./dto/quick-commerce.schemas";

/**
 * NEO-2 — platform purchase orders and advance shipping notices.
 *
 * Ingest is `inventory:channels:manage`: it is a marketplace integration, and
 * the document it creates is not yet a purchase order. Accepting one *is* raising
 * a purchase order, so it carries `inventory:purchase-orders:create` as well —
 * a marketplace administrator who may not buy goods may not turn a platform's
 * order into one.
 */
@RequireModule("inventory")
@Controller("inventory/quick-commerce")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class QuickCommerceController {
  constructor(
    private readonly svc: QuickCommerceInboundService,
    private readonly fillRate: FillRateService,
  ) {}

  @Get("purchase-orders")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:channels:manage")
  list(
    @Query(new ZodValidationPipe(listPlatformPosQuerySchema)) query: ListPlatformPosQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, query);
  }

  @Get("purchase-orders/:platformPoId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:channels:manage")
  detail(
    @Param("platformPoId", ParseIntPipe) platformPoId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.detail(u.orgId, platformPoId);
  }

  @Post("purchase-orders/ingest")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:channels:manage")
  ingest(
    @Body(new ZodValidationPipe(ingestPlatformPoSchema)) body: IngestPlatformPoInput,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.ingestPurchaseOrder(u.orgId, u.userId, body, idempotencyKey);
  }

  @Post("purchase-orders/:platformPoId/accept")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:create")
  accept(
    @Param("platformPoId", ParseIntPipe) platformPoId: number,
    @Body(new ZodValidationPipe(acceptPlatformPoSchema)) body: AcceptPlatformPoInput,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.acceptPurchaseOrder(u.orgId, u.userId, platformPoId, body, idempotencyKey);
  }

  @Get("asns")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:read")
  listAsns(
    @Query(new ZodValidationPipe(listAsnsQuerySchema)) query: ListAsnsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listAsns(u.orgId, u.userId, query);
  }

  @Get("asns/:asnId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:read")
  asnDetail(
    @Param("asnId", ParseIntPipe) asnId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.asnDetail(u.orgId, asnId);
  }

  @Post("asns")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:update")
  createAsn(
    @Body(new ZodValidationPipe(createAsnSchema)) body: CreateAsnInput,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createAsn(u.orgId, u.userId, body, idempotencyKey);
  }

  /**
   * NEO-3. `inventory:reports:read` rather than the channel key: fill rate is a
   * performance number an analyst reads, and it is warehouse-scoped inside the
   * service like every other operational read.
   */
  @Get("fill-rate")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:reports:read")
  fillRateReport(
    @Query(new ZodValidationPipe(fillRateQuerySchema)) query: FillRateQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.fillRate.report(u.orgId, u.userId, query);
  }

  /**
   * Uploading a payout file is not a report; it records what a platform says it
   * settled, so it keeps the channel-administration key. It writes nothing to
   * the general ledger.
   */
  @Post("payouts")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:channels:manage")
  uploadPayout(
    @Body(new ZodValidationPipe(uploadPayoutSchema)) body: UploadPayoutInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.fillRate.uploadPayout(u.orgId, u.userId, body);
  }
}
