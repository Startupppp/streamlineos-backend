import { Body, Controller, ForbiddenException, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { AccessService } from "../../access/access.service";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { SyncBatchService } from "./sync-batch.service";
import {
  syncBatchSchema,
  SYNC_OPERATION_PERMISSIONS,
  type SyncBatchInput,
} from "./dto/sync.schemas";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { syncBatchResponseSchema } from "./dto/sync-response.schemas";

@RequireModule("inventory")
@Controller("inventory/sync")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class SyncBatchController {
  constructor(
    private readonly sync: SyncBatchService,
    private readonly access: AccessService,
  ) {}

  /**
   * INV-208. Replays a device's offline queue, one operation at a time, through
   * the same services an online request uses. Returns a per-operation outcome
   * rather than a batch verdict: a device told only "batch failed" has no way
   * to know what to resend and will resend everything.
   *
   * B8. The route's own key is the door; `assertOperationsPermitted` is the
   * room. `PermissionGuard` reads exactly one `@RequirePermission` per handler,
   * so a batch endpoint that accepts four kinds of operation can only be gated
   * at the boundary on the weakest thing they have in common — and this one
   * carries a *receive* and a *pick confirm*, each of which answers to a
   * permission of its own online. Without the second check a device holding
   * only `inventory:stock:adjust` could post a `receive.count` and receive a
   * delivery it has no right to receive: the offline path would be a weaker set
   * of rules for exactly the operations that got the least supervision.
   */
  @Post("batch")
  @ResponseSchema(syncBatchResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:adjust")
  async applyBatch(
    @Body(new ZodValidationPipe(syncBatchSchema)) body: SyncBatchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.assertOperationsPermitted(u, body);
    return this.sync.apply(u.orgId, u.userId, body);
  }

  /**
   * Every distinct operation kind in the batch, checked once each.
   *
   * The whole batch is refused rather than the offending operations dropped. A
   * device whose token no longer covers what it queued has a real problem a
   * human needs to see, and silently applying the half it is still allowed
   * would leave the operator believing the shift synced.
   */
  private async assertOperationsPermitted(
    user: CurrentUserContext,
    body: SyncBatchInput,
  ): Promise<void> {
    const kinds = [...new Set(body.operations.map((o) => o.type))];
    for (const kind of kinds) {
      const key = SYNC_OPERATION_PERMISSIONS[kind];
      if (!(await this.access.holds(user, key))) {
        throw new ForbiddenException(
          `Replaying a queued ${kind} needs ${key}.`,
        );
      }
    }
  }
}
