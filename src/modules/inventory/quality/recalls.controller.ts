import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RecallsService } from "./quality-recalls.service";
import { RecallSimulationService } from "./recall-simulation.service";
import { listRecallsQuerySchema, createRecallSchema, updateRecallSchema } from "./dto/quality.schemas";
import type { ListRecallsQueryInput, CreateRecallInput, UpdateRecallInput } from "./dto/quality.schemas";
import { simulateRecallSchema } from "./dto/recall-simulation.schemas";
import type { SimulateRecallInput } from "./dto/recall-simulation.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";

const recallIdParams = z.object({ recallId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/quality/recalls")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class RecallsController {
  constructor(
    private readonly svc: RecallsService,
    private readonly simulation: RecallSimulationService,
  ) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:read")
  @Validate({ query: listRecallsQuerySchema })
  list(
    @Query() q: ListRecallsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, u.userId, q);
  }

  @Get(":recallId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:read")
  @Validate({ params: recallIdParams })
  findOne(
    @Param("recallId", ParseIntPipe) id: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.findOne(u.orgId, id);
  }

  /**
   * D4 — what a recall would do, before anybody does it.
   *
   * A POST that writes nothing: no holds, no lot status changes, no ledger
   * rows, no idempotency key, because there is no effect to replay. It is a
   * POST rather than a GET only because a selection — lot ids, variants, a
   * date range, a vendor — does not fit in a query string.
   *
   * Gated on `inventory:quality:read`, not `:recall`: reading the blast radius
   * is how somebody decides whether to ask for a recall, and requiring the
   * power to execute one in order to look at it is the reason operators guess
   * instead.
   */
  @Post("simulate")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:read")
  @Validate({ body: simulateRecallSchema })
  simulate(
    @Body() body: SimulateRecallInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.simulation.simulate(u.orgId, u.userId, body.selection);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:recall")
  @Validate({ body: createRecallSchema })
  create(
    @Body() body: CreateRecallInput,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.create(u.orgId, u.userId, body, idempotencyKey);
  }

  @Patch(":recallId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:recall")
  @Validate({ params: recallIdParams, body: updateRecallSchema })
  update(
    @Param("recallId", ParseIntPipe) id: number,
    @Body() body: UpdateRecallInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.update(u.orgId, u.userId, id, body);
  }
}
