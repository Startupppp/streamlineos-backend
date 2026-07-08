import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotificationQueueService } from "./notification-queue.service";
import { queueListSchema, bulkRetrySchema, type QueueListInput, type BulkRetryInput } from "./dto/queue.schemas";

@Controller("notification-queue")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class NotificationQueueController {
  constructor(private readonly queue: NotificationQueueService) {}

  @Get()
  @RequirePermission("notifications:queue:view")
  getQueue(
    @Query(new ZodValidationPipe(queueListSchema)) filters: QueueListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.queue.getQueue(u.orgId, filters);
  }

  @Get("failed")
  @RequirePermission("notifications:queue:view")
  getFailed(
    @Query(new ZodValidationPipe(queueListSchema)) filters: QueueListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.queue.getFailed(u.orgId, filters);
  }

  @Get("stats")
  @RequirePermission("notifications:queue:view")
  stats(@CurrentUser() u: CurrentUserContext) {
    return this.queue.stats(u.orgId);
  }

  @Post("bulk-retry")
  @RequirePermission("notifications:queue:manage")
  bulkRetry(
    @Body(new ZodValidationPipe(bulkRetrySchema)) body: BulkRetryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.queue.bulkRetry(u.orgId, body.ids);
  }

  @Post(":deliveryId/retry")
  @RequirePermission("notifications:queue:manage")
  retry(
    @Param("deliveryId", ParseIntPipe) deliveryId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.queue.retry(u.orgId, deliveryId);
  }

  @Post(":deliveryId/cancel")
  @RequirePermission("notifications:queue:manage")
  cancel(
    @Param("deliveryId", ParseIntPipe) deliveryId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.queue.cancel(u.orgId, deliveryId);
  }
}
