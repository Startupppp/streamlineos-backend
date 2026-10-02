import { Injectable, type OnModuleInit } from "@nestjs/common";
import { NotificationVisibilityRegistry } from "../../../notifications/notification-visibility.registry";
import {
  BUILD_APPROVAL_RESOURCE,
  BUILD_RELEASE_RESOURCE,
} from "../../../notifications/notification-events-build.catalog";
import { BuildNotificationContextService } from "./build-notification-context.service";

@Injectable()
export class BuildNotificationVisibility implements OnModuleInit {
  constructor(
    private readonly context: BuildNotificationContextService,
    private readonly visibility: NotificationVisibilityRegistry,
  ) {}

  onModuleInit(): void {
    this.visibility.registerTicketContext((orgId, userId, ticketIds, principal) =>
      this.context.resolve(orgId, userId, ticketIds, principal),
    );
    this.visibility.register("build.ticket", async (orgId, userId, entityId) => {
      const ticketId = Number(entityId);
      if (!Number.isSafeInteger(ticketId) || ticketId <= 0) return false;
      return (await this.context.resolve(orgId, userId, [ticketId])).has(ticketId);
    });
    this.visibility.register(BUILD_RELEASE_RESOURCE, async (orgId, userId, entityId) => {
      const releaseId = Number(entityId);
      if (!Number.isSafeInteger(releaseId) || releaseId <= 0) return false;
      return this.context.canSeeRelease(orgId, userId, releaseId);
    });
    this.visibility.register(BUILD_APPROVAL_RESOURCE, async (orgId, userId, entityId) => {
      const approvalId = Number(entityId);
      if (!Number.isSafeInteger(approvalId) || approvalId <= 0) return false;
      return this.context.canSeeApproval(orgId, userId, approvalId);
    });
  }
}
