import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ModuleGuard } from "../../../../common/rbac/module.guard";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { ZodValidationPipe } from "../../../../common/pipes/zod-validation.pipe";
import { InvAnomalyQueueService } from "./inv-anomaly-queue.service";
import { INV_ANOMALY_DETECTORS, INV_ANOMALY_TYPES } from "./inv-anomaly-detectors";
import {
  listAnomaliesSchema,
  reviewAnomalySchema,
  type ListAnomaliesInput,
  type ReviewAnomalyInput,
} from "./dto/inv-anomaly.schemas";

/**
 * F3 — the anomaly queue's routes.
 *
 * All three are deterministic and unpaid. Nothing here reaches a provider, so
 * none of them carries the `ai:invoke` rate limit and all three are safe on a
 * page render — the narrative over these findings is a separate, explicit,
 * charged request.
 *
 * Reading the queue is `inventory:ai:read`, the same key the other AI reading
 * surfaces carry. Reviewing is `inventory:ai:manage`, because closing an item is
 * a statement on the organisation's record about work somebody did or decided
 * not to do.
 */
@RequireModule("inventory")
@Controller("inventory/ai/anomalies")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvAnomalyController {
  constructor(private readonly queue: InvAnomalyQueueService) {}

  /**
   * What the six detectors compute, and how. Static and identical for every
   * caller, so it needs no scope — but it stays behind the same read key,
   * because the vocabulary of an organisation's alerting is not public.
   */
  @Get("detectors")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:ai:read")
  listDetectors() {
    return {
      detectors: INV_ANOMALY_TYPES.map((type) => INV_ANOMALY_DETECTORS[type]),
    };
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:ai:read")
  list(
    @Query(new ZodValidationPipe(listAnomaliesSchema)) filters: ListAnomaliesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.queue.list(u, filters);
  }

  @Patch(":insightId/review")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:ai:manage")
  review(
    @Param("insightId", ParseIntPipe) insightId: number,
    @Body(new ZodValidationPipe(reviewAnomalySchema)) body: ReviewAnomalyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.queue.review(u, insightId, body);
  }
}
