import { BadRequestException, Controller, Get, Headers, Param, ParseIntPipe, Patch, Post, Body, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { InvCycleCountsService } from "./inv-cycle-counts.service";
import {
  listCountsSchema, createCycleCountSchema, updateCountLinesSchema,
  type ListCountsInput, type CreateCycleCountInput, type UpdateCountLinesInput,
} from "./dto/inv-counts.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const countIdParams = z.object({ countId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/cycle-counts")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvCycleCountsController {
  constructor(private readonly counts: InvCycleCountsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  list(
    @Query(new ZodValidationPipe(listCountsSchema)) filters: ListCountsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.counts.listCycleCounts(u.orgId, u.userId, filters);
  }

  @Get(":countId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @Validate({ params: countIdParams })
  getOne(
    @Param("countId", ParseIntPipe) countId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.counts.getCycleCount(u.orgId, countId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reconcile")
  create(
    @Body(new ZodValidationPipe(createCycleCountSchema)) body: CreateCycleCountInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.counts.createCycleCount(u.orgId, u.userId, body);
  }

  @Post(":countId/start")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reconcile")
  @Validate({ params: countIdParams })
  start(
    @Param("countId", ParseIntPipe) countId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.counts.startCycleCount(u.orgId, countId);
  }

  @Patch(":countId/lines")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reconcile")
  @Validate({ params: countIdParams })
  updateLines(
    @Param("countId", ParseIntPipe) countId: number,
    @Body(new ZodValidationPipe(updateCountLinesSchema)) body: UpdateCountLinesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.counts.updateLines(u.orgId, countId, body);
  }

  @Post(":countId/review")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reconcile")
  @Validate({ params: countIdParams })
  review(
    @Param("countId", ParseIntPipe) countId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.counts.reviewCycleCount(u.orgId, countId);
  }

  @Post(":countId/post")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reconcile")
  @Validate({ params: countIdParams })
  post(
    @Headers("idempotency-key") idempotencyKey: string,
    @Param("countId", ParseIntPipe) countId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key header required");
    return this.counts.postCycleCount(u.orgId, u.userId, countId, idempotencyKey);
  }

  @Post(":countId/cancel")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reconcile")
  @Validate({ params: countIdParams })
  cancel(
    @Param("countId", ParseIntPipe) countId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.counts.cancelCycleCount(u.orgId, countId);
  }
}
