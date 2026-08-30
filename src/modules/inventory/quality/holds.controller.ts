import { BadRequestException, Body, Controller, Get, Headers, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { HoldsService } from "./quality-holds.service";
import { listHoldsQuerySchema, createHoldSchema } from "./dto/quality.schemas";
import type { ListHoldsQueryInput, CreateHoldInput } from "./dto/quality.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const holdIdParams = z.object({ holdId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/quality/holds")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class HoldsController {
  constructor(private readonly svc: HoldsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:read")
  @Validate({ query: listHoldsQuerySchema })
  list(
    @Query() q: ListHoldsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, u.userId, q);
  }

  @Get(":holdId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:read")
  @Validate({ params: holdIdParams })
  findOne(
    @Param("holdId", ParseIntPipe) holdId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.findOne(u.orgId, holdId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:inspect")
  @Validate({ body: createHoldSchema })
  create(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: CreateHoldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key header required");
    return this.svc.create(u.orgId, u.userId, idempotencyKey, body);
  }

  @Post(":holdId/release")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:release")
  @Validate({ params: holdIdParams })
  release(
    @Param("holdId", ParseIntPipe) holdId: number,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key header required");
    return this.svc.release(u.orgId, u.userId, holdId, idempotencyKey);
  }
}
