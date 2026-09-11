import {
  Body,
  Controller,
  Get,
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
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { PickExceptionService } from "./pick-exception.service";
import {
  assignPickExceptionSchema,
  listPickExceptionsSchema,
  resolvePickExceptionSchema,
  type AssignPickExceptionInput,
  type ListPickExceptionsInput,
  type ResolvePickExceptionInput,
} from "./dto/picking.schemas";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  assignPickExceptionResponseSchema,
  listPickExceptionsResponseSchema,
  resolvePickExceptionResponseSchema,
} from "./dto/picking-response.schemas";

/**
 * B5, items 2, 4 and 5 — the supervisor's side of picking.
 *
 * Separate from the wave controller because it is a different resource with a
 * different audience: a reviewer works a queue across every wave in their
 * warehouses, and is not necessarily anybody who may walk one.
 *
 * None of the three take an `Idempotency-Key`, on purpose. Each is a conditional
 * single statement against the row's current state — assignment against the
 * current owner, resolution against `OPEN` — so a repeat is the same state
 * rather than a second effect, and an unused key is worse than none because the
 * client believes it is protected.
 */
@RequireModule("inventory")
@Controller("inventory/picking/exceptions")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class PickExceptionController {
  constructor(private readonly exceptions: PickExceptionService) {}

  @Get()
  @ResponseSchema(listPickExceptionsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:picking:review")
  list(
    @Query(new ZodValidationPipe(listPickExceptionsSchema)) query: ListPickExceptionsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exceptions.list(u.orgId, u.userId, query);
  }

  @Post(":pickLineId/assign")
  @ResponseSchema(assignPickExceptionResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:picking:review")
  @Idempotent("inventory.pick-exception.assign")
  assign(
    @Param("pickLineId", ParseIntPipe) pickLineId: number,
    @Body(new ZodValidationPipe(assignPickExceptionSchema)) body: AssignPickExceptionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exceptions.assign(u.orgId, u.userId, pickLineId, body);
  }

  @Post(":pickLineId/resolve")
  @ResponseSchema(resolvePickExceptionResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:picking:review")
  @Idempotent("inventory.pick-exception.resolve")
  resolve(
    @Param("pickLineId", ParseIntPipe) pickLineId: number,
    @Body(new ZodValidationPipe(resolvePickExceptionSchema)) body: ResolvePickExceptionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exceptions.resolve(u.orgId, u.userId, pickLineId, body);
  }
}
