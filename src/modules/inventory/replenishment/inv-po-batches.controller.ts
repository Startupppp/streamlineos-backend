import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PoBatchService } from "./forecast/po-batch.service";
import {
  batchableProposalsQuerySchema,
  createPoBatchSchema,
  previewPoBatchSchema,
  type BatchableProposalsQuery,
  type CreatePoBatchInput,
  type PreviewPoBatchInput,
} from "./dto/po-batch.schemas";

/**
 * C6 — batching persisted proposals into purchase orders.
 *
 * `preview` is a POST that writes nothing. It takes a list of proposal ids that
 * can run to a couple of hundred entries, which does not belong in a query
 * string, and it is gated on the read key because reading is all it does.
 */
@RequireModule("inventory")
@Controller("inventory/replenishment/po-batches")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvPoBatchesController {
  constructor(private readonly batches: PoBatchService) {}

  /** The persisted proposals a buyer could order against, newest per site. */
  @Get("proposals")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:replenishment:read")
  proposals(
    @Query(new ZodValidationPipe(batchableProposalsQuerySchema))
    query: BatchableProposalsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.batches.batchable(u.orgId, u.userId, query);
  }

  /** What would be created, grouped by supplier, site and currency. */
  @Post("preview")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:replenishment:read")
  preview(
    @Body(new ZodValidationPipe(previewPoBatchSchema)) body: PreviewPoBatchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.batches.preview(u.orgId, u.userId, body.proposalIds, body.overrides);
  }

  /**
   * Create the one draft order these proposals describe.
   *
   * A set spanning two suppliers is refused rather than split, and the quantity
   * is the server's: the schema has no field for a client-sent one. The one way
   * a person changes it is `overrides`, which is a named act carrying a reason
   * and is written to `inv_proposal_overrides` beside the order — never a
   * quantity smuggled onto a line.
   */
  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:create")
  create(
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(createPoBatchSchema)) body: CreatePoBatchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.batches.create(u.orgId, u.userId, body, idempotencyKey);
  }
}
