import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { SyncBatchService } from "./sync-batch.service";
import { syncBatchSchema, type SyncBatchInput } from "./dto/sync.schemas";

@RequireModule("inventory")
@Controller("inventory/sync")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class SyncBatchController {
  constructor(private readonly sync: SyncBatchService) {}

  /**
   * INV-208. Replays a device's offline queue, one operation at a time, through
   * the same services an online request uses. Returns a per-operation outcome
   * rather than a batch verdict: a device told only "batch failed" has no way
   * to know what to resend and will resend everything.
   */
  @Post("batch")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:adjust")
  applyBatch(
    @Body(new ZodValidationPipe(syncBatchSchema)) body: SyncBatchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sync.apply(u.orgId, u.userId, body);
  }
}
