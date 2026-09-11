import { Injectable, type OnModuleInit } from "@nestjs/common";
import { NotificationVisibilityRegistry } from "../../notifications/notification-visibility.registry";
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
  }
}
