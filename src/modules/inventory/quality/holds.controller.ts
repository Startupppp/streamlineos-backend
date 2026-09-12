import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
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
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import {
  listHoldsResponseSchema,
  invQualityHoldSchema,
} from "./dto/quality-response.schemas";

const holdIdParams = z.object({ holdId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/quality/holds")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class HoldsController {
  constructor(private readonly svc: HoldsService) {}

  @Get()
  @ResponseSchema(listHoldsResponseSchema)
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
  @ResponseSchema(invQualityHoldSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:read")
  @Validate({ params: holdIdParams })
  findOne(
    @Param("holdId", ParseIntPipe) holdId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.findOne(u.orgId, u.userId, holdId);
  }

  @Post()
  @ResponseSchema(invQualityHoldSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:inspect")
  @Validate({ body: createHoldSchema })
  create(
    @IdempotencyKey() idempotencyKey: string,
    @Body() body: CreateHoldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.create(u.orgId, u.userId, idempotencyKey, body);
  }

  @Post(":holdId/release")
  @BodylessAction()
  @ResponseSchema(invQualityHoldSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:release")
  @Validate({ params: holdIdParams })
  release(
    @Param("holdId", ParseIntPipe) holdId: number,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.release(u.orgId, u.userId, holdId, idempotencyKey);
  }
}
