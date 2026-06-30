import { Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotificationQueueService } from "./notification-queue.service";
import { queueListSchema, type QueueListInput } from "./dto/queue.schemas";

@Controller("notification-queue")
@UseGuards(JwtAuthGuard)
export class NotificationQueueController {
  constructor(private readonly queue: NotificationQueueService) {}

  @Get()
  getQueue(
    @Query(new ZodValidationPipe(queueListSchema)) filters: QueueListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.queue.getQueue(u.orgId, filters);
  }

  @Get("failed")
  getFailed(
    @Query(new ZodValidationPipe(queueListSchema)) filters: QueueListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.queue.getFailed(u.orgId, filters);
  }

  @Post(":notificationId/retry")
  retry(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.queue.retry(u.orgId, notificationId);
  }
}
