import { Controller, Get, Post, Body, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { OwnershipService } from "./ownership.service";
import { convertOwnershipSchema, listConsignedQuerySchema } from "./dto/stock-types.schemas";
import type { ConvertOwnershipInput, ListConsignedQuery } from "./dto/stock-types.schemas";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  listConsignedResponseSchema,
  convertOwnershipResponseSchema,
} from "./dto/stock-types-response.schemas";

/**
 * NEO-11 - consignment.
 *
 * Reading what is standing here that is not ours is `inventory:stock:read`.
 * Taking title is `inventory:stock:adjust`: it posts stock and creates a
 * liability to the supplier, which is the same weight of decision as correcting
 * the ledger and should carry the same key.
 */
@RequireModule("inventory")
@Controller("inventory/ownership")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class OwnershipController {
  constructor(private readonly svc: OwnershipService) {}

  @Get("consigned")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @ResponseSchema(listConsignedResponseSchema)
  listConsigned(
    @Query(new ZodValidationPipe(listConsignedQuerySchema)) query: ListConsignedQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listConsigned(u.orgId, u.userId, query.warehouseId ?? null);
  }

  @Post("convert")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:adjust")
  @ResponseSchema(convertOwnershipResponseSchema)
  convert(
    @Body(new ZodValidationPipe(convertOwnershipSchema)) body: ConvertOwnershipInput,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.convert(u.orgId, u.userId, body, idempotencyKey);
  }
}
