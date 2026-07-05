import { BadRequestException, Body, Controller, Get, Headers, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { HoldsService } from "./quality-holds.service";
import { listHoldsQuerySchema, createHoldSchema } from "./dto/quality.schemas";
import type { ListHoldsQueryInput, CreateHoldInput } from "./dto/quality.schemas";

@RequireModule("inventory")
@Controller("inventory/quality/holds")
@UseGuards(JwtAuthGuard)
export class HoldsController {
  constructor(private readonly svc: HoldsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:read")
  list(
    @Query(new ZodValidationPipe(listHoldsQuerySchema)) q: ListHoldsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, q);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:inspect")
  create(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(createHoldSchema)) body: CreateHoldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key header required");
    return this.svc.create(u.orgId, u.userId, idempotencyKey, body);
  }

  @Post(":holdId/release")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:release")
  release(
    @Param("holdId", ParseIntPipe) holdId: number,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key header required");
    return this.svc.release(u.orgId, u.userId, holdId, idempotencyKey);
  }
}
