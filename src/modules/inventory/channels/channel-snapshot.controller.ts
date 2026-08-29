import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Public } from "../../../common/auth/public.decorator";
import { assertCronSecret } from "../../cron/cron-secret";
import { ChannelSnapshotService, type SnapshotSweepResult } from "./channel-snapshot.service";
import {
  listSnapshotDiffsQuerySchema,
  resolveSnapshotDiffSchema,
  type ListSnapshotDiffsQueryInput,
  type ResolveSnapshotDiffInput,
} from "./dto/channel-snapshot.schemas";

/**
 * E6 — the operator's surface over channel snapshot differences.
 *
 * Reading a difference is `inventory:channels:manage`, the key that already
 * governs everything about a sales channel. **Accepting** one is
 * `inventory:stock:adjust`, deliberately a different key: accepting posts a
 * stock movement, and whoever administers a marketplace connection is not
 * automatically somebody who may correct the ledger. Dismissing stays on the
 * channel key, because it touches nothing.
 *
 * Both mutations are `@Idempotent`, and accepting is idempotent twice over —
 * once at the HTTP layer for a retried request, and once in the stock engine
 * through a key derived from the difference row, which also covers two
 * *different* requests to accept the same difference.
 */
@RequireModule("inventory")
@Controller("inventory/channels")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class ChannelSnapshotController {
  constructor(private readonly snapshots: ChannelSnapshotService) {}

  @Get(":channelId/snapshot-differences")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:channels:manage")
  list(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Query(new ZodValidationPipe(listSnapshotDiffsQuerySchema)) query: ListSnapshotDiffsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.snapshots.listDiffs(u.orgId, channelId, query);
  }

  @Post("snapshot-differences/:diffId/accept")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:adjust")
  @HttpCode(HttpStatus.OK)
  @Idempotent("inventory.channels.snapshot_difference.accept")
  accept(
    @Param("diffId", ParseIntPipe) diffId: number,
    @Body(new ZodValidationPipe(resolveSnapshotDiffSchema)) body: ResolveSnapshotDiffInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.snapshots.acceptDiff(u.orgId, u.userId, diffId, body);
  }

  @Post("snapshot-differences/:diffId/dismiss")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:channels:manage")
  @HttpCode(HttpStatus.OK)
  @Idempotent("inventory.channels.snapshot_difference.dismiss")
  dismiss(
    @Param("diffId", ParseIntPipe) diffId: number,
    @Body(new ZodValidationPipe(resolveSnapshotDiffSchema)) body: ResolveSnapshotDiffInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.snapshots.dismissDiff(u.orgId, u.userId, diffId, body);
  }
}

/**
 * E6 — the scheduler entry point for the refetch drain.
 *
 * Beside the service rather than in `modules/cron/`, for the reason
 * `InventoryWebhookDeliveryController` gives: the route is part of this module's
 * contract, and putting it in the cron module would make `CronModule` import the
 * whole of inventory to reach one method. `assertCronSecret` is the gate — the
 * route is `@Public()` because the caller is a scheduler with no session, not
 * because it is unauthenticated.
 *
 * Both verbs, because platform schedulers differ on which they issue and a
 * worker that only answers POST is a worker that silently never runs.
 */
@Public()
@Controller("cron")
export class ChannelSnapshotCronController {
  constructor(private readonly snapshots: ChannelSnapshotService) {}

  @Get("inventory-channel-snapshot")
  runGet(@Headers("authorization") authorization?: string): Promise<SnapshotSweepResult> {
    return this.run(authorization);
  }

  @Post("inventory-channel-snapshot")
  @HttpCode(HttpStatus.OK)
  runPost(@Headers("authorization") authorization?: string): Promise<SnapshotSweepResult> {
    return this.run(authorization);
  }

  private run(authorization?: string): Promise<SnapshotSweepResult> {
    assertCronSecret(authorization);
    return this.snapshots.drainPending();
  }
}
