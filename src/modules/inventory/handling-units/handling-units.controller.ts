import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  ParseIntPipe,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { HandlingUnitService } from "./handling-unit.service";
import {
  createHandlingUnitSchema,
  listHandlingUnitsQuerySchema,
  moveHandlingUnitSchema,
  nestHandlingUnitSchema,
} from "./dto/handling-units.schemas";
import type {
  CreateHandlingUnitInput,
  ListHandlingUnitsQuery,
  MoveHandlingUnitInput,
  NestHandlingUnitInput,
} from "./dto/handling-units.schemas";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  handlingUnitDetailResponseSchema,
  listHandlingUnitsResponseSchema,
} from "./dto/handling-units-response.schemas";

/**
 * NEO-4 - handling units.
 *
 * Reading one is `inventory:stock:read`: "what is on LPN 000123" is a stock
 * question. Moving one posts stock through the engine, so it carries
 * `inventory:stock:transfer` - the key that already means "you may move stock
 * between locations", which is exactly what a putaway of a pallet is. Nesting
 * moves nothing and is warehouse work, so it takes the transfer key too rather
 * than inventing a third authority for relabelling.
 */
@RequireModule("inventory")
@Controller("inventory/handling-units")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class HandlingUnitsController {
  constructor(private readonly svc: HandlingUnitService) {}

  @Get()
  @ResponseSchema(listHandlingUnitsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  list(
    @Query(new ZodValidationPipe(listHandlingUnitsQuerySchema)) query: ListHandlingUnitsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, u.userId, query);
  }

  @Get(":handlingUnitId")
  @ResponseSchema(handlingUnitDetailResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  detail(
    @Param("handlingUnitId", ParseIntPipe) handlingUnitId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.detail(u.orgId, u.userId, handlingUnitId);
  }

  @Post()
  @ResponseSchema(handlingUnitDetailResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:transfer")
  create(
    @Body(new ZodValidationPipe(createHandlingUnitSchema)) body: CreateHandlingUnitInput,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.create(u.orgId, u.userId, body, idempotencyKey);
  }

  @Post(":handlingUnitId/move")
  @ResponseSchema(handlingUnitDetailResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:transfer")
  move(
    @Param("handlingUnitId", ParseIntPipe) handlingUnitId: number,
    @Body(new ZodValidationPipe(moveHandlingUnitSchema)) body: MoveHandlingUnitInput,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.move(u.orgId, u.userId, handlingUnitId, body, idempotencyKey);
  }

  @Patch(":handlingUnitId/nesting")
  @ResponseSchema(handlingUnitDetailResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:transfer")
  nest(
    @Param("handlingUnitId", ParseIntPipe) handlingUnitId: number,
    @Body(new ZodValidationPipe(nestHandlingUnitSchema)) body: NestHandlingUnitInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.nest(u.orgId, u.userId, handlingUnitId, body);
  }
}
