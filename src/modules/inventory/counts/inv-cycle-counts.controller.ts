import { Controller, Get, Param, ParseIntPipe, Patch, Post, Body, Query, UseGuards } from "@nestjs/common";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { InvCycleCountsService } from "./inv-cycle-counts.service";
import {
  listCountsSchema, createCycleCountSchema, updateCountLinesSchema,
  type ListCountsInput, type CreateCycleCountInput, type UpdateCountLinesInput,
} from "./dto/inv-counts.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { successSchema } from "../../../common/openapi/response-envelopes";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import {
  listCycleCountsResponseSchema,
  cycleCountSchema,
} from "./dto/counts-response.schemas";

const countIdParams = z.object({ countId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/cycle-counts")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvCycleCountsController {
  constructor(private readonly counts: InvCycleCountsService) {}

  @Get()
  @ResponseSchema(listCycleCountsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @Validate({ query: listCountsSchema })
  list(
    @Query() filters: ListCountsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.counts.listCycleCounts(u.orgId, u.userId, filters);
  }

  @Get(":countId")
  @ResponseSchema(cycleCountSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @Validate({ params: countIdParams })
  getOne(
    @Param("countId", ParseIntPipe) countId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.counts.getCycleCount(u.orgId, u.userId, countId);
  }

  @Post()
  @ResponseSchema(cycleCountSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reconcile")
  @Idempotent("inventory.cycle-count.create")
  @Validate({ body: createCycleCountSchema })
  create(
    @Body() body: CreateCycleCountInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.counts.createCycleCount(u.orgId, u.userId, body);
  }

  @Post(":countId/start")
  @BodylessAction()
  @ResponseSchema(cycleCountSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reconcile")
  @Idempotent("inventory.cycle-count.start")
  @Validate({ params: countIdParams })
  start(
    @Param("countId", ParseIntPipe) countId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.counts.startCycleCount(u.orgId, u.userId, countId);
  }

  @Patch(":countId/lines")
  @ResponseSchema(cycleCountSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reconcile")
  @Validate({ params: countIdParams, body: updateCountLinesSchema })
  updateLines(
    @Param("countId", ParseIntPipe) countId: number,
    @Body() body: UpdateCountLinesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.counts.updateLines(u.orgId, u.userId, countId, body);
  }

  @Post(":countId/review")
  @BodylessAction()
  @ResponseSchema(cycleCountSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reconcile")
  @Idempotent("inventory.cycle-count.review")
  @Validate({ params: countIdParams })
  review(
    @Param("countId", ParseIntPipe) countId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.counts.reviewCycleCount(u.orgId, u.userId, countId);
  }

  @Post(":countId/post")
  @BodylessAction()
  @ResponseSchema(cycleCountSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reconcile")
  @Validate({ params: countIdParams })
  post(
    @IdempotencyKey() idempotencyKey: string,
    @Param("countId", ParseIntPipe) countId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {return this.counts.postCycleCount(u.orgId, u.userId, countId, idempotencyKey);
  }

  @Post(":countId/cancel")
  @BodylessAction()
  @ResponseSchema(successSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reconcile")
  @Idempotent("inventory.cycle-count.cancel")
  @Validate({ params: countIdParams })
  async cancel(
    @Param("countId", ParseIntPipe) countId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.counts.cancelCycleCount(u.orgId, u.userId, countId);
    return { success: true as const };
  }
}
