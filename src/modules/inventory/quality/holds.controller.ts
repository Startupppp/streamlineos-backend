import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { HoldsService } from "./quality-holds.service";
import { listHoldsQuerySchema, createHoldSchema } from "./dto/quality.schemas";
import type { ListHoldsQueryInput, CreateHoldInput } from "./dto/quality.schemas";

@RequireModule("inventory")
@Controller("inventory/quality/holds")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class HoldsController {
  constructor(private readonly svc: HoldsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:read")
  list(
    @Query(new ZodValidationPipe(listHoldsQuerySchema)) q: ListHoldsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, u.userId, q);
  }

  @Get(":holdId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:read")
  findOne(
    @Param("holdId", ParseIntPipe) holdId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.findOne(u.orgId, holdId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:inspect")
  create(
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(createHoldSchema)) body: CreateHoldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {return this.svc.create(u.orgId, u.userId, idempotencyKey, body);
  }

  @Post(":holdId/release")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:release")
  release(
    @Param("holdId", ParseIntPipe) holdId: number,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {return this.svc.release(u.orgId, u.userId, holdId, idempotencyKey);
  }
}
